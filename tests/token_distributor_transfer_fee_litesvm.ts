// #346 dispute supplement — Token-2022 TransferFee underfunding PoC
// Demonstrates three failure modes against an unpatched create_distributor that
// accepts transfer-fee mints without runtime restriction.
//
// Run: cd lib/boost-tokendistributor-solana
//      anchor build
//      npm install --legacy-peer-deps
//      ./node_modules/.bin/ts-mocha -t 60000 tests/token_distributor_transfer_fee_litesvm.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  calculateFee,
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMintToInstruction,
  getAccount,
  getAccountLen,
  getMint,
  getMintLen,
  getTransferFeeAmount,
  getTransferFeeConfig,
} from "@solana/spl-token";
import { LiteSVM } from "litesvm";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as crypto from "crypto";
import { assert } from "chai";

// ── Seeds and scenario constants ─────────────────────────────────────────────
const DISTRIBUTOR_SEED = "distributor";
const OWNER_NONCE_SEED  = "owner_nonce";
const VAULT_SEED        = "vault";
const CLAIM_SEED        = "claim";

const NOMINAL_AMOUNT = 1000n; // tokens owner intends to distribute
const FEE_BPS        = 1000;  // 10 % transfer fee
const MAX_FEE        = 100n;  // fee capped at 100 tokens
const DECIMALS       = 0;

// Anchor error offset (6000) + index of InsufficientVaultBalance in error.rs
const ERR_INSUFFICIENT_VAULT = 6014;

// ── LiteSVM helpers ───────────────────────────────────────────────────────────
function advanceSlot(svm: LiteSVM): void {
  const clock = svm.getClock();
  clock.slot += 1n;
  svm.setClock(clock);
}

function sendTx(
  svm: LiteSVM,
  feePayer: Keypair,
  tx: Transaction,
  signers: Keypair[],
): unknown {
  advanceSlot(svm);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = feePayer.publicKey;
  tx.sign(...signers);
  return svm.sendTransaction(tx);
}

function isFailure(result: unknown): boolean {
  const s = String(result);
  return (
    s.includes("FailedTransactionMetadata") ||
    s.includes("TransactionError") ||
    (s !== "undefined" && s.includes("Error"))
  );
}

// Minimal connection shim so @coral-xyz/anchor can fetch accounts from LiteSVM
class LiteSVMConnection {
  private readonly svm: LiteSVM;
  constructor(svm: LiteSVM) {
    this.svm = svm;
  }

  async getLatestBlockhash() {
    return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0 };
  }
  async getMinimumBalanceForRentExemption() { return 0; }
  async getAccountInfo(pubkey: PublicKey) {
    const account = this.svm.getAccount(pubkey);
    if (!account) return null;
    return {
      executable: account.executable,
      owner: account.owner,
      lamports: Number(account.lamports),
      data: Buffer.from(account.data),
      rentEpoch: 0,
    };
  }
  async getAccountInfoAndContext(pubkey: PublicKey) {
    return {
      context: { slot: Number(this.svm.getClock().slot) },
      value: await this.getAccountInfo(pubkey),
    };
  }
  async getMultipleAccountsInfo(pubkeys: PublicKey[]) {
    return Promise.all(pubkeys.map((p) => this.getAccountInfo(p)));
  }
}

// ── Token-2022 mint/account helpers ─────────────────────────────────────────
function createTransferFeeMint(svm: LiteSVM, mintAuth: Keypair): Keypair {
  const mint    = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey:      mintAuth.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports:        5_000_000,
      space:           mintLen,
      programId:       TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mint.publicKey,
      mintAuth.publicKey, // transfer fee config authority
      mintAuth.publicKey, // withdraw withheld authority
      FEE_BPS,
      MAX_FEE,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      DECIMALS,
      mintAuth.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  sendTx(svm, mintAuth, tx, [mintAuth, mint]);
  return mint;
}

function createFeeTokenAccount(
  svm:     LiteSVM,
  mint:    PublicKey,
  owner:   PublicKey,
  payer:   Keypair,
): Keypair {
  const account    = Keypair.generate();
  const accountLen = getAccountLen([ExtensionType.TransferFeeAmount]);
  const tx = new Transaction();
  tx.add(
    SystemProgram.createAccount({
      fromPubkey:      payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports:        5_000_000,
      space:           accountLen,
      programId:       TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(
      account.publicKey,
      mint,
      owner,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  sendTx(svm, payer, tx, [payer, account]);
  return account;
}

function mintTokens(
  svm:    LiteSVM,
  mint:   PublicKey,
  dest:   PublicKey,
  auth:   Keypair,
  amount: bigint,
): void {
  const tx = new Transaction().add(
    createMintToInstruction(
      mint,
      dest,
      auth.publicKey,
      Number(amount),
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  sendTx(svm, auth, tx, [auth]);
}

// Single-leaf merkle tree: leaf IS the root; proof is empty.
function merkleLeaf(claimant: PublicKey, amount: bigint): Buffer {
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(amount);
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([claimant.toBuffer(), amtBuf]))
    .digest();
}

// ── Test suite ───────────────────────────────────────────────────────────────
describe("token_distributor — #346 transfer fee underfunding", () => {
  let svm:        LiteSVM;
  let program:    Program<TokenDistributor>;
  let programId:  PublicKey;
  let connection: LiteSVMConnection;

  let owner:    Keypair;
  let operator: Keypair;
  let claimant: Keypair;

  let mint:        Keypair;
  let ownerAta:    Keypair;
  let claimantAta: Keypair;

  let ownerNoncePda:   PublicKey;
  let distributorPda:  PublicKey;
  let vaultPda:        PublicKey;
  let claimStatusPda:  PublicKey;

  before(async () => {
    // ── bootstrap LiteSVM ──────────────────────────────────────────────────
    svm = new LiteSVM();
    const programBytes = fs.readFileSync("./target/deploy/token_distributor.so");
    const idl = JSON.parse(
      fs.readFileSync("./target/idl/token_distributor.json", "utf8"),
    );
    programId = new PublicKey(idl.address);
    svm.addProgram(programId, programBytes);

    // ── keypairs and airdrops ─────────────────────────────────────────────
    owner    = Keypair.generate();
    operator = Keypair.generate();
    claimant = Keypair.generate();
    svm.airdrop(owner.publicKey,    BigInt(100 * LAMPORTS_PER_SOL));
    svm.airdrop(operator.publicKey, BigInt(LAMPORTS_PER_SOL));
    svm.airdrop(claimant.publicKey, BigInt(LAMPORTS_PER_SOL));

    // ── create Token-2022 mint with TransferFeeConfig extension ───────────
    mint        = createTransferFeeMint(svm, owner);
    ownerAta    = createFeeTokenAccount(svm, mint.publicKey, owner.publicKey,    owner);
    claimantAta = createFeeTokenAccount(svm, mint.publicKey, claimant.publicKey, owner);
    mintTokens(svm, mint.publicKey, ownerAta.publicKey, owner, NOMINAL_AMOUNT);

    // ── anchor provider over LiteSVM connection shim ──────────────────────
    connection = new LiteSVMConnection(svm);
    const provider = new anchor.AnchorProvider(
      connection as any,
      new anchor.Wallet(owner),
      { commitment: "processed" },
    );
    program = new anchor.Program(idl as anchor.Idl, provider) as Program<TokenDistributor>;

    // ── derive PDAs ────────────────────────────────────────────────────────
    [ownerNoncePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(OWNER_NONCE_SEED), owner.publicKey.toBuffer()],
      programId,
    );
    const nonceBuf = new anchor.BN(1).toArrayLike(Buffer, "le", 4);
    [distributorPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(DISTRIBUTOR_SEED),
        mint.publicKey.toBuffer(),
        owner.publicKey.toBuffer(),
        nonceBuf,
      ],
      programId,
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(VAULT_SEED), distributorPda.toBuffer()],
      programId,
    );
    [claimStatusPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(CLAIM_SEED),
        distributorPda.toBuffer(),
        claimant.publicKey.toBuffer(),
      ],
      programId,
    );
  });

  // ── Test 1: accounting gap (Failure Mode A precondition) ─────────────────
  it("create_distributor succeeds with transfer-fee mint — records nominal 1000, vault receives 900", async () => {
    const ix = await program.methods
      .createDistributor(new anchor.BN(NOMINAL_AMOUNT.toString()))
      .accounts({
        ownerNonce:        ownerNoncePda,
        distributor:       distributorPda,
        tokenVault:        vaultPda,
        tokenMint:         mint.publicKey,
        ownerTokenAccount: ownerAta.publicKey,
        owner:             owner.publicKey,
        operator:          operator.publicKey,
        systemProgram:     SystemProgram.programId,
        tokenProgram:      TOKEN_2022_PROGRAM_ID,
        rent:              anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const result = sendTx(svm, owner, new Transaction().add(ix), [owner]);
    assert.isFalse(
      isFailure(result),
      `create_distributor should succeed but got: ${result}`,
    );

    // Fetch on-chain state
    const distributorState = await program.account.tokenDistributor.fetch(distributorPda);
    const vault     = await getAccount(connection as any, vaultPda,         undefined, TOKEN_2022_PROGRAM_ID);
    const mintInfo  = await getMint(   connection as any, mint.publicKey,   undefined, TOKEN_2022_PROGRAM_ID);
    const feeConfig = getTransferFeeConfig(mintInfo);
    assert.isNotNull(feeConfig, "mint must have TransferFeeConfig extension");

    const expectedFee = calculateFee(feeConfig!.newerTransferFee, NOMINAL_AMOUNT);
    const withheld    = getTransferFeeAmount(vault)?.withheldAmount ?? 0n;

    // Core accounting gap assertion
    assert.equal(
      distributorState.initialTotalAmount.toString(),
      NOMINAL_AMOUNT.toString(),
      `distributor.initial_total_amount should equal nominal (${NOMINAL_AMOUNT})`,
    );
    assert.equal(
      vault.amount.toString(),
      (NOMINAL_AMOUNT - expectedFee).toString(),
      `vault spendable should be nominal minus fee (${NOMINAL_AMOUNT - expectedFee})`,
    );
    assert.equal(
      withheld.toString(),
      expectedFee.toString(),
      `vault withheld should equal fee (${expectedFee})`,
    );

    console.log(
      `  distributor.initial_total_amount = ${distributorState.initialTotalAmount}  (nominal)`,
    );
    console.log(`  vault.amount (spendable)          = ${vault.amount}  (after 10% fee)`);
    console.log(`  vault.withheld_amount             = ${withheld}  (fee held in vault account)`);
  });

  // ── configure merkle root and start time so claim can proceed ─────────────
  it("operator sets merkle root and advances clock past start time", async () => {
    const leaf = merkleLeaf(claimant.publicKey, NOMINAL_AMOUNT);

    const rootIx = await program.methods
      .setMerkleRoot(Array.from(leaf))
      .accounts({ distributor: distributorPda, operator: operator.publicKey })
      .instruction();
    const r1 = sendTx(svm, operator, new Transaction().add(rootIx), [operator]);
    assert.isFalse(isFailure(r1), `setMerkleRoot failed: ${r1}`);

    const clock     = svm.getClock();
    const startTime = Number(clock.unixTimestamp) + 5;
    const timeIx    = await program.methods
      .setTime(new anchor.BN(startTime))
      .accounts({ distributor: distributorPda, operator: operator.publicKey })
      .instruction();
    const r2 = sendTx(svm, operator, new Transaction().add(timeIx), [operator]);
    assert.isFalse(isFailure(r2), `setTime failed: ${r2}`);

    // advance past start time
    const newClock = svm.getClock();
    newClock.unixTimestamp = BigInt(startTime + 1);
    newClock.slot += 1n;
    svm.setClock(newClock);
  });

  // ── Test 2: Failure Mode B — late claimant cannot claim (vault underfunded)
  it("claim(1000) reverts with InsufficientVaultBalance — vault has 900 spendable but claim requires 1000", async () => {
    const claimIx = await program.methods
      .claim(new anchor.BN(NOMINAL_AMOUNT.toString()), [] /* empty proof: single-leaf tree */)
      .accounts({
        distributor:          distributorPda,
        claimStatus:          claimStatusPda,
        tokenVault:           vaultPda,
        claimantTokenAccount: claimantAta.publicKey,
        tokenMint:            mint.publicKey,
        claimant:             claimant.publicKey,
        systemProgram:        SystemProgram.programId,
        tokenProgram:         TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    let claimFailed = false;
    let claimResult: unknown;
    try {
      claimResult = sendTx(svm, claimant, new Transaction().add(claimIx), [claimant]);
      if (isFailure(claimResult)) claimFailed = true;
    } catch (e) {
      claimFailed = true;
      claimResult = e;
    }

    const claimantVault = await getAccount(
      connection as any,
      claimantAta.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    assert.isTrue(
      claimFailed,
      `claim should have failed; result: ${claimResult}`,
    );
    assert.equal(
      claimantVault.amount.toString(),
      "0",
      "claimant received 0 tokens despite holding a valid merkle proof",
    );

    // Verify error code is InsufficientVaultBalance (6014) if LiteSVM surfaces it
    const resultStr = String(claimResult);
    if (resultStr.includes("Custom(")) {
      assert.match(
        resultStr,
        new RegExp(`Custom\\(${ERR_INSUFFICIENT_VAULT}\\)`),
        `expected InsufficientVaultBalance (${ERR_INSUFFICIENT_VAULT})`,
      );
      console.log(
        `  claim reverted with Custom(${ERR_INSUFFICIENT_VAULT}) = InsufficientVaultBalance`,
      );
    } else {
      console.log(`  claim reverted: ${resultStr.slice(0, 120)}`);
    }
  });

  // ── Test 3: Failure Mode C — withdraw() reverts because CloseAccount fails
  //    Token-2022 CloseAccount instruction fails with AccountHasWithheldTransferFees
  //    when withheld_amount > 0, reverting the entire withdraw() transaction.
  it("withdraw() reverts — Token-2022 CloseAccount rejects vault with nonzero withheld balance", async () => {
    // Advance the clock past end_time so the DistributionNotEnded time-check passes
    // and the actual close_account failure (AccountHasWithheldTransferFees) is reached.
    const distributorState = await program.account.tokenDistributor.fetch(distributorPda);
    const pastEndTime = Number(distributorState.endTime) + 1;
    const withdrawClock = svm.getClock();
    withdrawClock.unixTimestamp = BigInt(pastEndTime);
    withdrawClock.slot += 1n;
    svm.setClock(withdrawClock);

    const withdrawIx = await program.methods
      .withdraw()
      .accounts({
        distributor:       distributorPda,
        tokenVault:        vaultPda,
        tokenMint:         mint.publicKey,
        ownerTokenAccount: ownerAta.publicKey,
        owner:             owner.publicKey,
        tokenProgram:      TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    let withdrawFailed = false;
    let withdrawResult: unknown;
    try {
      withdrawResult = sendTx(svm, owner, new Transaction().add(withdrawIx), [owner]);
      if (isFailure(withdrawResult)) withdrawFailed = true;
    } catch (e) {
      withdrawFailed = true;
      withdrawResult = e;
    }

    // Even spendable tokens cannot be recovered: the whole transaction reverts
    const vaultAfter = await getAccount(
      connection as any,
      vaultPda,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    assert.isTrue(
      withdrawFailed,
      `withdraw should have failed due to AccountHasWithheldTransferFees; result: ${withdrawResult}`,
    );
    // vault spendable balance unchanged (transfer reverted along with close)
    assert.equal(
      vaultAfter.amount.toString(),
      (NOMINAL_AMOUNT - MAX_FEE).toString(),
      "vault spendable balance unchanged — withdraw reverted atomically",
    );

    console.log(
      `  withdraw reverted: ${String(withdrawResult).slice(0, 120)}`,
    );
    console.log(
      `  vault spendable still locked: ${vaultAfter.amount} tokens`,
    );
    console.log(
      `  vault withheld still locked:  ${getTransferFeeAmount(vaultAfter)?.withheldAmount ?? 0n} tokens`,
    );
  });
});
