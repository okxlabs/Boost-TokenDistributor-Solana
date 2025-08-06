import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  getAccount,
  getAccount as getAccount2022,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import { expect } from "chai";
import { SimpleMerkleTree } from "./utils/merkle_tree";
import { LiteSVM } from "litesvm";
import * as fs from "fs";
import * as crypto from "crypto";

/**
 * Manually create an SPL Token Mint in LiteSVM (supports TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID)
 * @param svm LiteSVM instance
 * @param mintAuthority Keypair that has mint authority
 * @param decimals Token precision (usually 6 or 9)
 * @param programId TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 * @param seed Optional seed string for generating deterministic addresses
 * @returns mint Keypair
 */
function liteSvmCreateMint(
  svm: LiteSVM,
  mintAuthority: Keypair,
  decimals = 9,
  programId = TOKEN_PROGRAM_ID,
  seed?: string,
): Keypair {
  // Use seed to generate keypair with optional randomness
  let mintSeed: string;
  if (seed) {
    mintSeed = seed;
  } else {
    // Add timestamp and random component to ensure uniqueness across test runs
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    mintSeed = `mint-${mintAuthority.publicKey.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;
  }

  // Use SHA256 hash to generate unique seed
  const hash = crypto.createHash("sha256").update(mintSeed).digest();
  const mint = Keypair.fromSeed(hash);

  // Rent calculation (Token 2022 uses same MINT_SIZE)
  // Standard rent for mint account is approximately 1461600 lamports
  const lamports = 1461600; // Fixed rent for mint accounts

  const tx = new Transaction();

  // Create Mint account (System Program)
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: mintAuthority.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports,
      space: MINT_SIZE,
      programId: programId,
    }),
  );

  // Initialize Mint (SPL Token CPI)
  tx.add(
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      mintAuthority.publicKey, // mint authority
      null, // freeze authority (optional)
      programId,
    ),
  );

  // Set blockhash and sign transaction
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = mintAuthority.publicKey;
  tx.sign(mintAuthority, mint);

  // Send transaction
  svm.sendTransaction(tx);

  return mint;
}

/**
 * Manually create a Token Account in LiteSVM (supports TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID)
 * @param svm LiteSVM instance
 * @param mint Token mint address
 * @param owner Token account owner
 * @param payer Account that pays for the transaction
 * @param programId TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 * @returns token account Keypair
 */
function liteSvmCreateAccount(
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey,
  payer: Keypair,
  programId = TOKEN_PROGRAM_ID,
): Keypair {
  // Add timestamp and random component to ensure uniqueness across test runs
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const accountSeed = `account-${mint.toBase58()}-${owner.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;

  // Use SHA256 hash to generate unique seed
  const hash = crypto.createHash("sha256").update(accountSeed).digest();
  const account = Keypair.fromSeed(hash);

  // Rent calculation for token account is approximately 2039280 lamports
  const lamports = 2039280; // Fixed rent for token accounts

  const tx = new Transaction();

  // Create Token Account (System Program)
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: account.publicKey,
      lamports,
      space: ACCOUNT_SIZE,
      programId: programId,
    }),
  );

  // Initialize Token Account (SPL Token CPI)
  tx.add(createInitializeAccountInstruction(account.publicKey, mint, owner, programId));

  // Set blockhash and sign transaction
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.sign(payer, account);

  // Send transaction
  svm.sendTransaction(tx);

  return account;
}

/**
 * Manually mint tokens to specified account in LiteSVM (supports TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID)
 * @param svm LiteSVM instance
 * @param mint Token mint address
 * @param destination Target token account address
 * @param authority mint authority
 * @param amount Amount to mint
 * @param programId TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 */
function liteSvmMintTo(
  svm: LiteSVM,
  mint: PublicKey,
  destination: PublicKey,
  authority: Keypair,
  amount: number,
  programId = TOKEN_PROGRAM_ID,
): void {
  const tx = new Transaction();

  // Add mint instruction
  tx.add(createMintToInstruction(mint, destination, authority.publicKey, amount, [], programId));

  // Set blockhash and sign transaction
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);

  // Send transaction
  svm.sendTransaction(tx);
}

describe("token_distributor_litesvm", () => {
  let svm: LiteSVM;
  let programId: PublicKey;
  let program: Program<TokenDistributor>;
  let provider: anchor.AnchorProvider;

  let tokenMint: PublicKey;
  let tokenMint2022: PublicKey;
  let owner: Keypair;
  let operator: Keypair;
  let ownerTokenAccount: PublicKey;
  let ownerTokenAccount2022: PublicKey;

  // Nonce state PDA
  let ownerNoncePda: PublicKey;

  // Distributor and vault PDAs will be calculated dynamically
  let distributorPda: PublicKey;
  let distributorPda2022: PublicKey;
  let tokenVaultPda: PublicKey;
  let tokenVaultPda2022: PublicKey;

  // Additional variables for withdraw tests
  let withdrawTestDistributorPda: PublicKey;
  let withdrawTestDistributorPda2022: PublicKey;
  let withdrawTestTokenVaultPda: PublicKey;
  let withdrawTestTokenVaultPda2022: PublicKey;

  // Test claimants and merkle tree data
  let claimant1: Keypair;
  let claimant2: Keypair;
  let testTreeNodes: Array<{ claimant: PublicKey; amount: anchor.BN }>;
  let testMerkleTree: SimpleMerkleTree;
  let testMerkleRoot: number[];

  // Helper function to get next nonce for an owner
  async function getNextNonceForOwner(ownerKey: PublicKey): Promise<number> {
    try {
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      return ownerNonceAccount.nonce + 1;
    } catch (error) {
      // If account doesn't exist, this will be the first distributor (nonce 1)
      return 1;
    }
  }

  // Helper function to calculate distributor PDA for a specific nonce
  function calculateDistributorPda(tokenMint: PublicKey, owner: PublicKey, nonce: number): PublicKey {
    const DISTRIBUTOR_SEED = "distributor";
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(DISTRIBUTOR_SEED),
        tokenMint.toBuffer(),
        owner.toBuffer(),
        new anchor.BN(nonce).toArrayLike(Buffer, "le", 4),
      ],
      programId,
    );
    return pda;
  }

  // Helper function to calculate vault PDA
  function calculateVaultPda(distributorPda: PublicKey): PublicKey {
    const VAULT_SEED = "vault";
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), distributorPda.toBuffer()], programId);
    return pda;
  }

  // Helper function to ensure unique transactions in LiteSVM
  function ensureUniqueTransaction(tx: Transaction): void {
    // Advance slot to ensure unique blockhash
    const currentClock = svm.getClock();
    currentClock.slot = currentClock.slot + BigInt(1);
    svm.setClock(currentClock);

    // Get fresh blockhash
    tx.recentBlockhash = svm.latestBlockhash();

    // Add a unique memo instruction to ensure transaction uniqueness
    const uniqueId = `${Date.now()}-${Math.random()}`;
    const memoInstruction = {
      keys: [],
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      data: Buffer.from(uniqueId),
    };
    tx.add(memoInstruction);
  }

  // Helper function to extract and format error details with specific error codes
  function formatError(error: any): string {
    let searchString = "";

    // Handle different input types
    if (error && error.message) {
      searchString = error.message;
    } else {
      searchString = String(error);
    }

    // Extract error code if present in Custom(xxxx) format
    const customMatch = searchString.match(/Custom\((\d+)\)/);
    if (customMatch) {
      const errorCode = parseInt(customMatch[1]);
      const errorMap: { [key: number]: string } = {
        6006: "DistributionNotStarted - Distribution not started",
        6007: "DistributionEnded - Distribution has ended",
        6008: "DistributionNotEnded - Distribution has not ended yet",
        6009: "TooEarly - Too early to claim",
        6010: "TooLate - Too late to claim",
        6012: "InvalidProof - Invalid proof",
        6013: "AlreadyClaimed - Already claimed maximum amount",
        6014: "InvalidWithdrawTime - Invalid withdraw time",
        6015: "NoTokensToWithdraw - No tokens to withdraw",
      };
      const errorMsg = errorMap[errorCode] || `Unknown error code ${errorCode}`;
      return `Custom(${errorCode}): ${errorMsg}`;
    }

    // If no custom error code found, return the original string
    return searchString;
  }

  // Helper function to check if transaction result indicates failure
  function isTransactionFailed(result: any): boolean {
    const resultStr = String(result);
    return resultStr.includes("FailedTransactionMetadata") || resultStr === "FailedTransactionMetadata {}";
  }

  before(async () => {
    console.log("=== Initializing LiteSVM Test Environment ===");

    // Initialize LiteSVM
    svm = new LiteSVM();

    // Load the program using the correct program ID from IDL
    const programBytes = fs.readFileSync("./target/deploy/token_distributor.so");
    const idl = JSON.parse(fs.readFileSync("./target/idl/token_distributor.json", "utf8"));
    programId = new PublicKey(idl.address); // Use IDL address instead of keypair

    svm.addProgram(programId, programBytes);
    console.log("✅ Loaded token distributor program:", programId.toString());
    console.log("✅ Using program ID from IDL:", idl.address);

    // Load essential system programs
    console.log("Loading essential system programs...");

    // SPL Token program is essential for token operations
    // LiteSVM should have these built-in, but let's ensure they're available
    console.log("✅ System programs should be available in LiteSVM by default");

    // Create keypairs - use owner as the main payer (similar to bankrun context.payer)
    owner = Keypair.generate();
    operator = Keypair.generate();

    console.log("✅ Using generated owner as payer:", owner.publicKey.toString());
    console.log("✅ Generated operator:", operator.publicKey.toString());

    // Calculate nonce state PDA
    const OWNER_NONCE_SEED = "owner_nonce";
    [ownerNoncePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(OWNER_NONCE_SEED), owner.publicKey.toBuffer()],
      programId,
    );
    console.log("✅ Nonce State PDA:", ownerNoncePda.toString());

    // Airdrop SOL to owner (main payer)
    svm.airdrop(owner.publicKey, BigInt(100 * LAMPORTS_PER_SOL)); // Give owner plenty of SOL
    console.log("✅ Airdropped 100 SOL to owner");

    // Check balance
    const balance = svm.getAccount(owner.publicKey)?.lamports || BigInt(0);
    console.log("Owner balance:", Number(balance) / LAMPORTS_PER_SOL, "SOL");

    // Give operator some SOL from owner
    const transferTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: operator.publicKey,
        lamports: LAMPORTS_PER_SOL, // 1 SOL
      }),
    );

    transferTx.recentBlockhash = svm.latestBlockhash();
    transferTx.feePayer = owner.publicKey;
    transferTx.sign(owner);
    svm.sendTransaction(transferTx);
    console.log("✅ Transferred 1 SOL to operator");

    // Create test claimants with keypairs we control
    claimant1 = Keypair.generate();
    claimant2 = Keypair.generate();

    // Give claimants some SOL for transaction fees
    for (const claimant of [claimant1, claimant2]) {
      const claimantTransferTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: claimant.publicKey,
          lamports: LAMPORTS_PER_SOL / 10, // 0.1 SOL
        }),
      );
      claimantTransferTx.recentBlockhash = svm.latestBlockhash();
      claimantTransferTx.feePayer = owner.publicKey;
      claimantTransferTx.sign(owner);
      svm.sendTransaction(claimantTransferTx);
    }
    console.log("✅ Created test claimants and transferred SOL for transaction fees");

    // Create test tree nodes with controlled keypairs
    testTreeNodes = [
      { claimant: claimant1.publicKey, amount: new anchor.BN(1000) },
      { claimant: claimant2.publicKey, amount: new anchor.BN(2000) },
      { claimant: owner.publicKey, amount: new anchor.BN(3000) }, // Use owner as third claimant
      { claimant: operator.publicKey, amount: new anchor.BN(4000) }, // Use operator as fourth claimant
    ];

    // Create merkle tree with test data
    testMerkleTree = new SimpleMerkleTree(testTreeNodes);
    testMerkleRoot = testMerkleTree.getMerkleRoot();
    console.log("✅ Created test merkle tree with controlled keypairs");
    console.log("Test merkle root:", testMerkleRoot);

    // Create SPL token mint (nonce 1) using LiteSVM approach
    console.log("Creating SPL token mint...");
    const tokenMintKeypair = liteSvmCreateMint(svm, owner, 9, TOKEN_PROGRAM_ID);
    tokenMint = tokenMintKeypair.publicKey;
    console.log("✅ SPL Token mint created:", tokenMint.toString());

    // Create Token 2022 mint (nonce 2) using LiteSVM approach
    console.log("Creating Token 2022 mint...");
    const tokenMint2022Keypair = liteSvmCreateMint(svm, owner, 9, TOKEN_2022_PROGRAM_ID);
    tokenMint2022 = tokenMint2022Keypair.publicKey;
    console.log("✅ Token 2022 mint created:", tokenMint2022.toString());

    // Create token accounts using LiteSVM approach
    console.log("Creating token accounts using LiteSVM approach...");
    const ownerTokenAccountKeypair = liteSvmCreateAccount(svm, tokenMint, owner.publicKey, owner, TOKEN_PROGRAM_ID);
    ownerTokenAccount = ownerTokenAccountKeypair.publicKey;

    const ownerTokenAccount2022Keypair = liteSvmCreateAccount(
      svm,
      tokenMint2022,
      owner.publicKey,
      owner,
      TOKEN_2022_PROGRAM_ID,
    );
    ownerTokenAccount2022 = ownerTokenAccount2022Keypair.publicKey;

    console.log("✅ SPL token account created:", ownerTokenAccount.toString());
    console.log("✅ Token 2022 account created:", ownerTokenAccount2022.toString());

    // Mint some tokens to owner accounts
    console.log("Minting tokens to owner accounts...");
    const mintAmount = 1000000000000; // 1000 tokens with 9 decimals

    // Mint SPL tokens
    liteSvmMintTo(svm, tokenMint, ownerTokenAccount, owner, mintAmount, TOKEN_PROGRAM_ID);
    console.log("✅ Minted SPL tokens to owner account");

    // Mint Token 2022 tokens
    liteSvmMintTo(svm, tokenMint2022, ownerTokenAccount2022, owner, mintAmount, TOKEN_2022_PROGRAM_ID);
    console.log("✅ Minted Token 2022 tokens to owner account");

    // Calculate PDAs for first distributors (will be nonces 1 and 2)
    distributorPda = calculateDistributorPda(tokenMint, owner.publicKey, 1);
    tokenVaultPda = calculateVaultPda(distributorPda);

    distributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, 2);
    tokenVaultPda2022 = calculateVaultPda(distributorPda2022);

    console.log("✅ Calculated PDAs:");
    console.log("SPL Token Distributor PDA:", distributorPda.toString());
    console.log("SPL Token Vault PDA:", tokenVaultPda.toString());
    console.log("Token 2022 Distributor PDA:", distributorPda2022.toString());
    console.log("Token 2022 Vault PDA:", tokenVaultPda2022.toString());

    // Create a minimal provider for instruction building using LiteSVM
    // We create a custom connection-like object that works with our LiteSVM instance
    class LiteSVMConnection {
      private svm: LiteSVM;

      constructor(svm: LiteSVM) {
        this.svm = svm;
      }

      async getLatestBlockhash() {
        return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0 };
      }

      async getMinimumBalanceForRentExemption() {
        return 0; // LiteSVM handles rent automatically
      }

      async getAccountInfo(pubkey: PublicKey) {
        const account = this.svm.getAccount(pubkey);
        if (!account) return null;
        return {
          executable: account.executable,
          owner: account.owner,
          lamports: Number(account.lamports),
          data: Buffer.from(account.data), // Convert Uint8Array to Buffer for Anchor compatibility
          rentEpoch: 0,
        };
      }

      async getAccountInfoAndContext(pubkey: PublicKey) {
        const accountInfo = await this.getAccountInfo(pubkey);
        return {
          context: { slot: Number(this.svm.getClock().slot) },
          value: accountInfo,
        };
      }

      async getMultipleAccountsInfo(pubkeys: PublicKey[]) {
        return pubkeys.map((pubkey) => {
          const account = this.svm.getAccount(pubkey);
          return account
            ? {
                executable: account.executable,
                owner: account.owner,
                lamports: Number(account.lamports),
                data: Buffer.from(account.data), // Convert Uint8Array to Buffer
                rentEpoch: 0,
              }
            : null;
        });
      }

      async sendTransaction() {
        throw new Error("Use LiteSVM.sendTransaction() instead");
      }
    }

    const liteSvmConnection = new LiteSVMConnection(svm) as any;
    const wallet = new anchor.Wallet(owner);
    provider = new anchor.AnchorProvider(liteSvmConnection, wallet, { commitment: "processed" });

    // Load IDL and create program instance with corrected program ID
    const programIdl = JSON.parse(fs.readFileSync("./target/idl/token_distributor.json", "utf8"));
    // No need to override since we're using the correct program ID now
    program = new Program(programIdl, provider);

    console.log("✅ Created Anchor Program instance with LiteSVM integration");
    console.log("Program ID from LiteSVM:", programId.toString());
    console.log("Program ID in Anchor Program:", program.programId.toString());

    // Note: withdraw test PDAs will be calculated dynamically based on actual counter state
    console.log("=== LiteSVM Test Environment Ready ===");
  });

  it("Create distributor with SPL Token (nonce 1)", async () => {
    const totalAmount = new anchor.BN(500000000000); // 500 tokens

    try {
      console.log("Calling createDistributor with SPL Token, totalAmount:", totalAmount.toString());

      // Debug: Check program account exists
      const programAccount = svm.getAccount(programId);
      console.log("Program account exists:", !!programAccount);
      console.log("Program is executable:", programAccount?.executable);

      // Debug: Check all required accounts before transaction
      console.log("Owner account exists:", !!svm.getAccount(owner.publicKey));
      console.log("Token mint account exists:", !!svm.getAccount(tokenMint));
      console.log("Owner token account exists:", !!svm.getAccount(ownerTokenAccount));

      console.log("Building createDistributor instruction...");

      const ix = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: distributorPda,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          ownerTokenAccount: ownerTokenAccount,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // Execute transaction using LiteSVM
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = owner.publicKey;
      tx.sign(owner);

      try {
        const txResult = svm.sendTransaction(tx);
        console.log("LiteSVM sendTransaction result:", txResult);

        // Check if transaction failed - LiteSVM returns string representation
        const txResultStr = String(txResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ Transaction failed in LiteSVM");
          console.error("Failed transaction result:", txResultStr);

          // This indicates the program execution failed
          // Common causes: missing programs, invalid account ownership, insufficient funds, etc.
          throw new Error(`Transaction failed: ${txResultStr}`);
        }

        console.log("✅ Transaction sent to LiteSVM successfully");
      } catch (error) {
        console.error("❌ Transaction execution error:", error);
        throw error;
      }

      // Debug: Check if accounts were created
      console.log("Checking account creation...");
      const debugnonceAccount = svm.getAccount(ownerNoncePda);
      const debugDistributorAccount = svm.getAccount(distributorPda);
      const debugVaultAccount = svm.getAccount(tokenVaultPda);

      console.log("Nonce account exists:", !!debugnonceAccount);
      console.log("Distributor account exists:", !!debugDistributorAccount);
      console.log("Vault account exists:", !!debugVaultAccount);

      if (!debugnonceAccount) {
        console.log("❌ Nonce account was not created! Transaction may have failed.");
        console.log("Expected nonce PDA:", ownerNoncePda.toString());
        return;
      }

      // Verify nonce state was created/updated
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("Nonce State data:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("1");

      // Verify token vault balance after creating distributor
      console.log("Verifying SPL Token vault balance...");
      const tokenVaultAccount = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      console.log("SPL Token Vault Balance:", tokenVaultAccount.amount.toString());
      console.log("SPL Token Vault Mint:", tokenVaultAccount.mint.toString());
      console.log("Expected Total Amount:", totalAmount.toString());

      // Verify vault has correct amount and mint
      expect(tokenVaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(tokenVaultAccount.mint.toString()).to.equal(tokenMint.toString());

      // Verify distributor account exists and has data
      const fetchedDistributorAccount = await program.account.tokenDistributor.fetch(distributorPda);

      console.log("SPL Token Distributor account data:", {
        owner: fetchedDistributorAccount.owner.toString(),
        operator: fetchedDistributorAccount.operator.toString(),
        tokenMint: fetchedDistributorAccount.tokenMint.toString(),
        initialTotalAmount: fetchedDistributorAccount.initialTotalAmount.toString(),
        totalClaimed: fetchedDistributorAccount.totalClaimed.toString(),
        nonce: fetchedDistributorAccount.nonce.toString(),
      });

      // Basic verification
      expect(fetchedDistributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(fetchedDistributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(fetchedDistributorAccount.tokenMint.toString()).to.equal(tokenMint.toString());
      expect(fetchedDistributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(fetchedDistributorAccount.totalClaimed.toString()).to.equal("0"); // Should be 0 initially
      expect(fetchedDistributorAccount.nonce.toString()).to.equal("1");

      console.log("✅ Create SPL Token distributor test passed!");
    } catch (error) {
      console.error("Create SPL Token distributor test failed:", error);
      throw error;
    }
  });

  it("Create distributor with Token 2022 (nonce 2)", async () => {
    const totalAmount = new anchor.BN(500000000000); // 500 tokens

    try {
      console.log("Calling createDistributor with Token 2022, totalAmount:", totalAmount.toString());

      // Build the instruction
      const ix = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: distributorPda2022,
          tokenVault: tokenVaultPda2022,
          tokenMint: tokenMint2022,
          ownerTokenAccount: ownerTokenAccount2022,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx = new Transaction();
      tx.add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = owner.publicKey;
      tx.sign(owner);

      try {
        const txResult = svm.sendTransaction(tx);
        console.log("LiteSVM sendTransaction result:", txResult);

        // Check if transaction failed
        const txResultStr = String(txResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ Transaction failed in LiteSVM");
          console.error("Failed transaction result:", txResultStr);
          throw new Error(`Transaction failed: ${txResultStr}`);
        }

        console.log("✅ Transaction sent to LiteSVM successfully");
      } catch (error) {
        console.error("❌ Transaction execution error:", error);
        throw error;
      }

      // Debug: Check if accounts were created
      console.log("Checking account creation...");
      const debugnonceAccount = svm.getAccount(ownerNoncePda);
      const debugDistributorAccount = svm.getAccount(distributorPda2022);
      const debugVaultAccount = svm.getAccount(tokenVaultPda2022);

      console.log("Nonce account exists:", !!debugnonceAccount);
      console.log("Distributor account exists:", !!debugDistributorAccount);
      console.log("Vault account exists:", !!debugVaultAccount);

      if (!debugnonceAccount) {
        console.log("❌ Nonce account was not created! Transaction may have failed.");
        console.log("Expected nonce PDA:", ownerNoncePda.toString());
        return;
      }

      // Verify nonce state was updated to nonce 2
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("Updated Nonce State data:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("2");

      // Verify token vault balance after creating distributor
      console.log("Verifying Token 2022 vault balance...");
      const tokenVaultAccount = await getAccount2022(
        provider.connection,
        tokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      console.log("Token 2022 Vault Balance:", tokenVaultAccount.amount.toString());
      console.log("Token 2022 Vault Mint:", tokenVaultAccount.mint.toString());
      console.log("Expected Total Amount:", totalAmount.toString());

      // Verify vault has correct amount and mint
      expect(tokenVaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(tokenVaultAccount.mint.toString()).to.equal(tokenMint2022.toString());

      // Verify distributor account exists and has data
      const fetchedDistributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("Token 2022 Distributor account data:", {
        owner: fetchedDistributorAccount.owner.toString(),
        operator: fetchedDistributorAccount.operator.toString(),
        tokenMint: fetchedDistributorAccount.tokenMint.toString(),
        initialTotalAmount: fetchedDistributorAccount.initialTotalAmount.toString(),
        totalClaimed: fetchedDistributorAccount.totalClaimed.toString(),
        nonce: fetchedDistributorAccount.nonce.toString(),
      });

      // Basic verification
      expect(fetchedDistributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(fetchedDistributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(fetchedDistributorAccount.tokenMint.toString()).to.equal(tokenMint2022.toString());
      expect(fetchedDistributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(fetchedDistributorAccount.totalClaimed.toString()).to.equal("0"); // Should be 0 initially
      expect(fetchedDistributorAccount.nonce.toString()).to.equal("2");

      console.log("✅ Create Token 2022 distributor test passed!");
    } catch (error) {
      console.error("Create Token 2022 distributor test failed:", error);
      throw error;
    }
  });

  it("Set merkle root for both distributors", async () => {
    try {
      console.log("Setting merkle root using test data...");

      console.log("Generated merkle root:", testMerkleRoot);
      console.log("Merkle root length:", testMerkleRoot.length);

      console.log("Setting merkle root for SPL Token distributor (nonce 1)...");

      // Build the instruction for nonce 1 (SPL Token)
      const ix1 = await program.methods
        .setMerkleRoot(testMerkleRoot)
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      try {
        const txResult1 = svm.sendTransaction(tx1);
        console.log("Set merkle root transaction result for nonce 1:", txResult1);

        // Check if transaction failed
        const txResultStr1 = String(txResult1);
        if (txResultStr1.includes("FailedTransactionMetadata") || txResultStr1 === "FailedTransactionMetadata {}") {
          console.error("❌ Set merkle root transaction failed for nonce 1");
          throw new Error(`Transaction failed: ${txResultStr1}`);
        }

        console.log("✅ Set merkle root transaction sent successfully for nonce 1");
      } catch (error) {
        console.error("❌ Set merkle root transaction execution error for nonce 1:", error);
        throw error;
      }

      console.log("Setting merkle root for Token 2022 distributor (nonce 2)...");

      // Build the instruction for nonce 2 (Token 2022)
      const ix2 = await program.methods
        .setMerkleRoot(testMerkleRoot)
        .accounts({
          distributor: distributorPda2022,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      try {
        const txResult2 = svm.sendTransaction(tx2);
        console.log("Set merkle root transaction result for nonce 2:", txResult2);

        // Check if transaction failed
        const txResultStr2 = String(txResult2);
        if (txResultStr2.includes("FailedTransactionMetadata") || txResultStr2 === "FailedTransactionMetadata {}") {
          console.error("❌ Set merkle root transaction failed for nonce 2");
          throw new Error(`Transaction failed: ${txResultStr2}`);
        }

        console.log("✅ Set merkle root transaction sent successfully for nonce 2");
      } catch (error) {
        console.error("❌ Set merkle root transaction execution error for nonce 2:", error);
        throw error;
      }

      // Verify merkle root was set for both distributors
      const distributorAccount1 = await program.account.tokenDistributor.fetch(distributorPda);
      const distributorAccount2022 = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("Merkle root set for nonce 1:", distributorAccount1.merkleRoot);
      console.log("Merkle root set for nonce 2:", distributorAccount2022.merkleRoot);

      // Verify merkle root matches what we set
      expect(distributorAccount1.merkleRoot).to.deep.equal(testMerkleRoot);
      expect(distributorAccount2022.merkleRoot).to.deep.equal(testMerkleRoot);

      console.log("✅ Set merkle root test passed for both distributors!");
    } catch (error) {
      console.error("Set merkle root test failed:", error);
      throw error;
    }
  });

  it("Set time for nonce 1 and nonce 2 [current time]", async () => {
    try {
      console.log("Getting current LiteSVM blockchain time...");

      // Get current LiteSVM blockchain time
      const clock = svm.getClock();
      const currentTimestamp = Number(clock.unixTimestamp);

      console.log("Current LiteSVM timestamp:", currentTimestamp);
      console.log("Current LiteSVM slot:", Number(clock.slot));

      // Set time for nonce 1 (SPL Token) to 1 second in the future (minimum valid time)
      const startTimeV1 = currentTimestamp + 1; // 1 second in the future to satisfy validation
      console.log("Setting time for nonce 1 (SPL Token) to +1 second:", startTimeV1);

      // Build the instruction for nonce 1 (SPL Token)
      const ix1 = await program.methods
        .setTime(new anchor.BN(startTimeV1))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      try {
        const txResult1 = svm.sendTransaction(tx1);
        console.log("Set time transaction result for nonce 1:", txResult1);

        // Check if transaction failed
        const txResultStr1 = String(txResult1);
        if (txResultStr1.includes("FailedTransactionMetadata") || txResultStr1 === "FailedTransactionMetadata {}") {
          console.error("❌ Set time transaction failed for nonce 1");
          throw new Error(`Transaction failed: ${txResultStr1}`);
        }

        console.log("✅ Set time transaction sent successfully for nonce 1");
      } catch (error) {
        console.error("❌ Set time transaction execution error for nonce 1:", error);
        throw error;
      }

      // Set time for nonce 2 (Token 2022) to current time + 10 seconds
      const startTimeV2 = currentTimestamp + 10;
      console.log("Setting time for nonce 2 (Token 2022) to current time + 10 seconds:", startTimeV2);

      // Build the instruction for nonce 2 (Token 2022)
      const ix2 = await program.methods
        .setTime(new anchor.BN(startTimeV2))
        .accounts({
          distributor: distributorPda2022,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      try {
        const txResult2 = svm.sendTransaction(tx2);
        console.log("Set time transaction result for nonce 2:", txResult2);

        // Check if transaction failed
        const txResultStr2 = String(txResult2);
        if (txResultStr2.includes("FailedTransactionMetadata") || txResultStr2 === "FailedTransactionMetadata {}") {
          console.error("❌ Set time transaction failed for nonce 2");
          throw new Error(`Transaction failed: ${txResultStr2}`);
        }

        console.log("✅ Set time transaction sent successfully for nonce 2");
      } catch (error) {
        console.error("❌ Set time transaction execution error for nonce 2:", error);
        throw error;
      }

      // Verify times were set
      const distributorAccount1 = await program.account.tokenDistributor.fetch(distributorPda);
      const distributorAccount2022 = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("nonce 1 start time set:", distributorAccount1.startTime.toString());
      console.log("nonce 1 end time set:", distributorAccount1.endTime.toString());
      console.log("nonce 2 start time set:", distributorAccount2022.startTime.toString());
      console.log("nonce 2 end time set:", distributorAccount2022.endTime.toString());

      // Verify times match what we set
      expect(distributorAccount1.startTime.toString()).to.equal(startTimeV1.toString());
      expect(distributorAccount2022.startTime.toString()).to.equal(startTimeV2.toString());

      // Verify end times are set (should be start time + DURATION)
      expect(distributorAccount1.endTime.toNumber()).to.be.greaterThan(distributorAccount1.startTime.toNumber());
      expect(distributorAccount2022.endTime.toNumber()).to.be.greaterThan(distributorAccount2022.startTime.toNumber());

      console.log("✅ Set time test passed for both nonces!");
    } catch (error) {
      console.error("Set time test failed:", error);
      throw error;
    }
  });

  it("Modify time multiple times before distribution starts", async () => {
    try {
      console.log("=== Testing multiple time modifications before distribution starts ===");

      // Get current LiteSVM blockchain time
      const currentClock = svm.getClock();
      const blockTime = Number(currentClock.unixTimestamp);

      console.log("Current LiteSVM block time:", blockTime);

      // First time setting - set to 10 seconds in the future
      const firstStartTime = blockTime + 10;
      console.log("Setting time first time to +10 seconds:", firstStartTime);

      // Build the instruction for first time setting
      const ix1 = await program.methods
        .setTime(new anchor.BN(firstStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      const txResult1 = svm.sendTransaction(tx1);
      console.log("First time set transaction result:", txResult1);

      // Verify first time was set
      let distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(firstStartTime.toString());

      // Second time setting - modify to 20 seconds in the future
      const secondStartTime = blockTime + 20;
      console.log("Modifying time to +20 seconds:", secondStartTime);

      // Build the instruction for second time setting
      const ix2 = await program.methods
        .setTime(new anchor.BN(secondStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      const txResult2 = svm.sendTransaction(tx2);
      console.log("Second time set transaction result:", txResult2);

      // Verify second time was set
      distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(secondStartTime.toString());

      // Third time setting - modify to 30 seconds in the future
      const thirdStartTime = blockTime + 30;
      console.log("Modifying time to +30 seconds:", thirdStartTime);

      // Build the instruction for third time setting
      const ix3 = await program.methods
        .setTime(new anchor.BN(thirdStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx3 = new Transaction();
      tx3.add(ix3);
      tx3.recentBlockhash = svm.latestBlockhash();
      tx3.feePayer = operator.publicKey;
      tx3.sign(operator);

      const txResult3 = svm.sendTransaction(tx3);
      console.log("Third time set transaction result:", txResult3);

      // Verify third time was set
      distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(thirdStartTime.toString());

      console.log("✅ Multiple time modifications test passed!");
    } catch (error) {
      console.error("Multiple time modifications test failed:", error);
      throw error;
    }
  });

  it("Fail to modify time after distribution starts", async () => {
    try {
      console.log("=== Testing time modification failure after distribution starts ===");

      // Get current LiteSVM blockchain time
      const currentClock = svm.getClock();
      const blockTime = Number(currentClock.unixTimestamp);

      console.log("Current LiteSVM block time:", blockTime);

      // Set initial time to 5 seconds in the future
      const initialStartTime = blockTime + 5;
      console.log("Setting initial time to +5 seconds:", initialStartTime);

      // Build the instruction for initial time setting
      const ix1 = await program.methods
        .setTime(new anchor.BN(initialStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx1 = new Transaction();
      tx1.add(ix1);
      tx1.recentBlockhash = svm.latestBlockhash();
      tx1.feePayer = operator.publicKey;
      tx1.sign(operator);

      const txResult1 = svm.sendTransaction(tx1);
      console.log("Initial time set transaction result:", txResult1);

      // Verify initial time was set
      let distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(initialStartTime.toString());

      // Advance time to after distribution starts
      console.log("⏰ Advancing time to after distribution starts...");
      const afterStartTime = initialStartTime + 2; // 2 seconds after start time

      const updatedClock = svm.getClock();
      updatedClock.unixTimestamp = BigInt(afterStartTime);
      svm.setClock(updatedClock);

      console.log("Advanced time to:", afterStartTime);
      console.log("Distribution should have started:", afterStartTime >= initialStartTime);

      // Try to modify time after distribution has started - this should fail
      const newStartTime = afterStartTime + 10;
      console.log("Attempting to modify time to:", newStartTime);

      // Build the instruction for time modification (should fail)
      const ix2 = await program.methods
        .setTime(new anchor.BN(newStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const tx2 = new Transaction();
      tx2.add(ix2);
      tx2.recentBlockhash = svm.latestBlockhash();
      tx2.feePayer = operator.publicKey;
      tx2.sign(operator);

      const txResult2 = svm.sendTransaction(tx2);
      console.log("Time modification transaction result:", txResult2);

      // Check if transaction failed
      const txResultStr2 = String(txResult2);
      if (txResultStr2.includes("FailedTransactionMetadata") || txResultStr2 === "FailedTransactionMetadata {}") {
        console.log("✅ Time modification correctly failed after distribution started");

        // Verify the time was not actually modified
        distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
        expect(distributorAccount.startTime.toString()).to.equal(initialStartTime.toString());
        console.log("✅ Time was correctly not modified - still:", distributorAccount.startTime.toString());
      } else {
        // If we reach here, the transaction succeeded when it should have failed
        throw new Error("❌ Time modification should have failed but succeeded");
      }

      console.log("✅ Time modification failure test passed!");
    } catch (error) {
      console.error("Time modification failure test failed:", error);
      throw error;
    }
  });

  it("Claim tokens for nonce 1 (SPL Token)[current time]", async () => {
    try {
      console.log("=== Testing claim for nonce 1 (SPL Token) ===");

      // Test claim for claimant1 (1000 tokens from our pre-generated test data)
      const claimIndex = 0;
      const claimAmount = testTreeNodes[claimIndex].amount;

      console.log("Testing claim for claimant1:");
      console.log("  Claimant:", claimant1.publicKey.toString());
      console.log("  Amount:", claimAmount.toString());

      // Generate proof for claimant1
      const proof = testMerkleTree.getProof(claimIndex);
      console.log("Generated proof length:", proof.length);

      // Convert proof to the format expected by the program
      const proofArray: number[][] = proof.map((p) => Array.from(p));

      // Create token account for claimant1 using LiteSVM approach
      const claimant1TokenAccountKeypair = liteSvmCreateAccount(
        svm,
        tokenMint,
        claimant1.publicKey,
        claimant1,
        TOKEN_PROGRAM_ID,
      );
      const claimant1TokenAccount = claimant1TokenAccountKeypair.publicKey;
      console.log("Created claimant1 token account:", claimant1TokenAccount.toString());

      // Find claim status PDA for claimant1
      const [claimStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), distributorPda.toBuffer(), claimant1.publicKey.toBuffer()],
        programId,
      );

      // Get initial token balances using LiteSVM connection
      const initialVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const initialClaimantBalance = await getAccount(
        provider.connection,
        claimant1TokenAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

      // Check current distributor state and advance time if needed
      console.log("=== Checking time and advancing to allow claims ===");

      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      let currentClock = svm.getClock();
      let currentTimestamp = Number(currentClock.unixTimestamp);

      console.log("Current LiteSVM timestamp:", currentTimestamp);
      console.log("Distribution time:", distributorAccount.startTime.toString());
      console.log("Claims currently allowed:", currentTimestamp >= distributorAccount.startTime.toNumber());

      // If claims are not yet allowed, advance time
      if (currentTimestamp < distributorAccount.startTime.toNumber()) {
        console.log("⏰ Advancing time to allow claims...");

        // Use LiteSVM proper time control by directly setting the clock
        const targetTimestamp = distributorAccount.startTime.toNumber() + 1;

        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("Setting timestamp to:", targetTimestamp);

        // Check updated time
        currentClock = svm.getClock();
        currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("New timestamp after clock update:", currentTimestamp);
        console.log("Claims now allowed:", currentTimestamp >= distributorAccount.startTime.toNumber());
      }

      // Execute the claim transaction
      console.log("=== Executing claim transaction ===");

      // Build the claim instruction
      const claimIx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda,
          claimantTokenAccount: claimant1TokenAccount,
          tokenMint: tokenMint,
          claimant: claimant1.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const claimTx = new Transaction();
      claimTx.add(claimIx);
      claimTx.recentBlockhash = svm.latestBlockhash();
      claimTx.feePayer = claimant1.publicKey;
      claimTx.sign(claimant1);

      try {
        const claimResult = svm.sendTransaction(claimTx);
        console.log("Claim transaction result:", claimResult);

        // Check if transaction failed
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ Claim transaction failed");
          console.error("Full error details:", claimResult);
          throw new Error(`Claim transaction failed: ${txResultStr}`);
        }

        console.log("✅ Claim transaction sent successfully");
      } catch (error) {
        console.error("❌ Claim transaction execution error:", error);
        throw error;
      }

      // Verify balances after claim
      const finalVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const finalClaimantBalance = await getAccount(
        provider.connection,
        claimant1TokenAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      console.log("Final vault balance:", finalVaultBalance.amount.toString());
      console.log("Final claimant balance:", finalClaimantBalance.amount.toString());

      // Verify the correct amount was transferred
      const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
      const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

      expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
      expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

      console.log("✅ Token balances verified correctly!");

      // Verify claim status was updated
      const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
      expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

      console.log("✅ Claim status verified correctly!");

      // Test that double claiming fails
      console.log("=== Testing double claim prevention ===");
      try {
        // Build the double claim instruction
        const doubleClaimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        // Create and send transaction using LiteSVM
        const doubleClaimTx = new Transaction();
        doubleClaimTx.add(doubleClaimIx);
        doubleClaimTx.recentBlockhash = svm.latestBlockhash();
        doubleClaimTx.feePayer = claimant1.publicKey;
        doubleClaimTx.sign(claimant1);

        const doubleClaimResult = svm.sendTransaction(doubleClaimTx);

        // Check if transaction failed as expected
        const txResultStr = String(doubleClaimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.log("✅ Double claim correctly prevented in LiteSVM");
        } else {
          // If transaction succeeded unexpectedly, fail the test
          expect.fail("Double claim should have failed");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Double claim correctly prevented:", errorDetails);
      }

      console.log("✅ Claim test completed successfully!");
    } catch (error) {
      console.error("Claim test failed:", error);
      throw error;
    }
  });

  it("Claim tokens for nonce 2 (Token 2022)[current time]", async () => {
    try {
      console.log("=== Testing claim for nonce 2 (Token 2022) ===");

      // Test claim for claimant2 (2000 tokens from our pre-generated test data)
      const claimIndex = 1;
      const claimAmount = testTreeNodes[claimIndex].amount;

      console.log("Testing claim for claimant2:");
      console.log("  Claimant:", claimant2.publicKey.toString());
      console.log("  Amount:", claimAmount.toString());

      // Generate proof for claimant2
      const proof = testMerkleTree.getProof(claimIndex);
      console.log("Generated proof length:", proof.length);

      // Convert proof to the format expected by the program
      const proofArray: number[][] = proof.map((p) => Array.from(p));

      // Create token account for claimant2 using LiteSVM approach
      const claimant2TokenAccountKeypair = liteSvmCreateAccount(
        svm,
        tokenMint2022,
        claimant2.publicKey,
        claimant2,
        TOKEN_2022_PROGRAM_ID,
      );
      const claimant2TokenAccount = claimant2TokenAccountKeypair.publicKey;
      console.log("Created claimant2 token account:", claimant2TokenAccount.toString());

      // Find claim status PDA for claimant2
      const [claimStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), distributorPda2022.toBuffer(), claimant2.publicKey.toBuffer()],
        programId,
      );

      // Get initial token balances using LiteSVM connection
      const initialVaultBalance = await getAccount(
        provider.connection,
        tokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const initialClaimantBalance = await getAccount(
        provider.connection,
        claimant2TokenAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

      // Check current distributor state and advance time if needed
      console.log("=== Checking time and advancing to allow claims ===");

      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);
      let currentClock = svm.getClock();
      let currentTimestamp = Number(currentClock.unixTimestamp);

      console.log("Current LiteSVM timestamp:", currentTimestamp);
      console.log("Distribution start time:", distributorAccount.startTime.toString());
      console.log("Claims currently allowed:", currentTimestamp >= distributorAccount.startTime.toNumber());

      // If claims are not yet allowed, advance time
      if (currentTimestamp < distributorAccount.startTime.toNumber()) {
        console.log("⏰ Advancing time to allow claims...");

        // Use LiteSVM proper time control by directly setting the clock
        const targetTimestamp = distributorAccount.startTime.toNumber() + 1;

        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("Setting timestamp to:", targetTimestamp);

        // Check updated time
        currentClock = svm.getClock();
        currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("New timestamp after clock update:", currentTimestamp);
        console.log("Claims now allowed:", currentTimestamp >= distributorAccount.startTime.toNumber());
      }

      // Execute the claim transaction
      console.log("=== Executing claim transaction ===");

      // Build the claim instruction
      const claimIx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda2022,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda2022,
          claimantTokenAccount: claimant2TokenAccount,
          tokenMint: tokenMint2022,
          claimant: claimant2.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();

      // Create and send transaction using LiteSVM
      const claimTx = new Transaction();
      claimTx.add(claimIx);
      claimTx.recentBlockhash = svm.latestBlockhash();
      claimTx.feePayer = claimant2.publicKey;
      claimTx.sign(claimant2);

      try {
        const claimResult = svm.sendTransaction(claimTx);
        console.log("Claim transaction result:", claimResult);

        // Check if transaction failed
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          console.error("❌ Claim transaction failed");
          console.error("Full error details:", claimResult);
          throw new Error(`Claim transaction failed: ${txResultStr}`);
        }

        console.log("✅ Claim transaction sent successfully");
      } catch (error) {
        console.error("❌ Claim transaction execution error:", error);
        throw error;
      }

      // Verify balances after claim
      const finalVaultBalance = await getAccount(
        provider.connection,
        tokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const finalClaimantBalance = await getAccount(
        provider.connection,
        claimant2TokenAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      console.log("Final vault balance:", finalVaultBalance.amount.toString());
      console.log("Final claimant balance:", finalClaimantBalance.amount.toString());

      // Verify the correct amount was transferred
      const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
      const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

      expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
      expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

      console.log("✅ Token balances verified correctly!");

      // Verify claim status was updated
      const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
      expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

      console.log("✅ Claim status verified correctly!");

      console.log("✅ Token 2022 Claim test completed successfully!");
    } catch (error) {
      console.error("Token 2022 Claim test failed:", error);
      throw error;
    }
  });

  it("Withdraw tokens (SPL Token) - No start time set", async () => {
    try {
      console.log("=== Testing withdraw (SPL Token) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      // Get next nonce number dynamically
      const nextnonce = await getNextNonceForOwner(owner.publicKey);
      console.log("Next nonce for withdraw test:", nextnonce);

      // Calculate PDA for this nonce
      const withdrawTestDistributorPda = calculateDistributorPda(tokenMint, owner.publicKey, nextnonce);
      const withdrawTestTokenVaultPda = calculateVaultPda(withdrawTestDistributorPda);

      console.log("Withdraw Test SPL Token Distributor PDA:", withdrawTestDistributorPda.toString());
      console.log("Withdraw Test SPL Token Vault PDA:", withdrawTestTokenVaultPda.toString());

      // Create distributor for withdraw test
      console.log("Creating distributor for withdraw test (nonce", nextnonce, ")...");

      const createIx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: withdrawTestDistributorPda,
          tokenVault: withdrawTestTokenVaultPda,
          tokenMint: tokenMint,
          ownerTokenAccount: ownerTokenAccount,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      const createTx = new Transaction();
      createTx.add(createIx);
      createTx.recentBlockhash = svm.latestBlockhash();
      createTx.feePayer = owner.publicKey;
      createTx.sign(owner);

      const createResult = svm.sendTransaction(createTx);
      console.log("Created withdraw test distributor transaction:", createResult);

      // Verify initial vault balance
      const initialVaultBalance = await getAccount(
        provider.connection,
        withdrawTestTokenVaultPda,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      expect(initialVaultBalance.amount.toString()).to.equal(totalAmount.toString());

      // Get initial owner token balance
      const initialOwnerBalance = await getAccount(provider.connection, ownerTokenAccount, undefined, TOKEN_PROGRAM_ID);
      console.log("Initial owner balance:", initialOwnerBalance.amount.toString());

      // Verify distributor state - start time should be 0 (not set)
      const distributorAccount = await program.account.tokenDistributor.fetch(withdrawTestDistributorPda);
      console.log("Distributor start time:", distributorAccount.startTime.toString());
      console.log("Distributor end time:", distributorAccount.endTime.toString());
      expect(distributorAccount.startTime.toString()).to.equal("0");
      expect(distributorAccount.endTime.toString()).to.equal("0");

      // Execute withdraw - should succeed because start time is not set
      console.log("Executing withdraw transaction...");

      const withdrawIx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda,
          tokenVault: withdrawTestTokenVaultPda,
          ownerTokenAccount: ownerTokenAccount,
          tokenMint: tokenMint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      const withdrawTx = new Transaction();
      withdrawTx.add(withdrawIx);
      withdrawTx.recentBlockhash = svm.latestBlockhash();
      withdrawTx.feePayer = owner.publicKey;
      withdrawTx.sign(owner);

      const withdrawResult = svm.sendTransaction(withdrawTx);
      console.log("Withdraw transaction result:", withdrawResult);

      // Verify final owner token balance
      const finalOwnerBalance = await getAccount(provider.connection, ownerTokenAccount, undefined, TOKEN_PROGRAM_ID);
      console.log("Final owner balance:", finalOwnerBalance.amount.toString());

      // Verify the correct amount was withdrawn
      const expectedOwnerBalance = initialOwnerBalance.amount + BigInt(totalAmount.toString());
      expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

      console.log("✅ Token balance verified - owner received all tokens back!");

      // Verify vault account is closed (should fail to fetch)
      try {
        await getAccount(provider.connection, withdrawTestTokenVaultPda, undefined, TOKEN_PROGRAM_ID);
        expect.fail("Vault account should be closed");
      } catch (error) {
        console.log("✅ Vault account correctly closed");
      }

      // Verify distributor account is closed (should fail to fetch)
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda);
        expect.fail("Distributor account should be closed");
      } catch (error) {
        console.log("✅ Distributor account correctly closed");
      }

      console.log("✅ SPL Token Withdraw test completed successfully!");
    } catch (error) {
      console.error("SPL Token Withdraw test failed:", error);
      throw error;
    }
  });

  it("Withdraw tokens (Token 2022) - No start time set", async () => {
    try {
      console.log("=== Testing withdraw (Token 2022) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      // Get next nonce number dynamically
      const nextnonce = await getNextNonceForOwner(owner.publicKey);
      console.log("Next nonce for withdraw test:", nextnonce);

      // Calculate PDA for this nonce
      const withdrawTestDistributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, nextnonce);
      const withdrawTestTokenVaultPda2022 = calculateVaultPda(withdrawTestDistributorPda2022);

      console.log("Withdraw Test Token 2022 Distributor PDA:", withdrawTestDistributorPda2022.toString());
      console.log("Withdraw Test Token 2022 Vault PDA:", withdrawTestTokenVaultPda2022.toString());

      // Create distributor for withdraw test
      console.log("Creating distributor for withdraw test (nonce", nextnonce, ")...");

      const createIx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: withdrawTestDistributorPda2022,
          tokenVault: withdrawTestTokenVaultPda2022,
          tokenMint: tokenMint2022,
          ownerTokenAccount: ownerTokenAccount2022,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      const createTx = new Transaction();
      createTx.add(createIx);
      createTx.recentBlockhash = svm.latestBlockhash();
      createTx.feePayer = owner.publicKey;
      createTx.sign(owner);

      const createResult = svm.sendTransaction(createTx);
      console.log("Created withdraw test distributor transaction:", createResult);

      // Verify initial vault balance
      const initialVaultBalance = await getAccount(
        provider.connection,
        withdrawTestTokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      expect(initialVaultBalance.amount.toString()).to.equal(totalAmount.toString());

      // Get initial owner token balance
      const initialOwnerBalance = await getAccount(
        provider.connection,
        ownerTokenAccount2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Initial owner balance:", initialOwnerBalance.amount.toString());

      // Verify distributor state - start time should be 0 (not set)
      const distributorAccount = await program.account.tokenDistributor.fetch(withdrawTestDistributorPda2022);
      console.log("Distributor start time:", distributorAccount.startTime.toString());
      console.log("Distributor end time:", distributorAccount.endTime.toString());
      expect(distributorAccount.startTime.toString()).to.equal("0");
      expect(distributorAccount.endTime.toString()).to.equal("0");

      // Execute withdraw - should succeed because start time is not set
      console.log("Executing withdraw transaction...");

      const withdrawIx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda2022,
          tokenVault: withdrawTestTokenVaultPda2022,
          ownerTokenAccount: ownerTokenAccount2022,
          tokenMint: tokenMint2022,
          owner: owner.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();

      const withdrawTx = new Transaction();
      withdrawTx.add(withdrawIx);
      withdrawTx.recentBlockhash = svm.latestBlockhash();
      withdrawTx.feePayer = owner.publicKey;
      withdrawTx.sign(owner);

      const withdrawResult = svm.sendTransaction(withdrawTx);
      console.log("Withdraw transaction result:", withdrawResult);

      // Verify final owner token balance
      const finalOwnerBalance = await getAccount(
        provider.connection,
        ownerTokenAccount2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Final owner balance:", finalOwnerBalance.amount.toString());

      // Verify the correct amount was withdrawn
      const expectedOwnerBalance = initialOwnerBalance.amount + BigInt(totalAmount.toString());
      expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

      console.log("✅ Token balance verified - owner received all tokens back!");

      // Verify vault account is closed (should fail to fetch)
      try {
        await getAccount(provider.connection, withdrawTestTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
        expect.fail("Vault account should be closed");
      } catch (error) {
        console.log("✅ Vault account correctly closed");
      }

      // Verify distributor account is closed (should fail to fetch)
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda2022);
        expect.fail("Distributor account should be closed");
      } catch (error) {
        console.log("✅ Distributor account correctly closed");
      }

      console.log("✅ Token 2022 Withdraw test completed successfully!");
    } catch (error) {
      console.error("Token 2022 Withdraw test failed:", error);
      throw error;
    }
  });

  after(async () => {
    console.log("=== LiteSVM Test Environment Cleanup ===");
    console.log("✅ All tests completed successfully!");
    console.log("✅ LiteSVM successfully replaced Bankrun functionality");
  });

  // Additional Test Suite 1: SPL Token with 1 day start time delay
  describe("SPL Token - 1 Day Start Time Delay Tests", () => {
    let delayedDistributorPda: PublicKey;
    let delayedTokenVaultPda: PublicKey;
    let delayedClaimant1TokenAccount: PublicKey;
    let delayedClaimStatusPda: PublicKey;
    let startTimeOneDayLater: number;

    it("Create distributor with SPL Token (1 day start time delay)", async () => {
      const totalAmount = new anchor.BN(500000000000); // 500 tokens

      try {
        console.log("=== Creating SPL Token distributor with 1 day start time delay ===");

        // Get next nonce number dynamically
        const nextnonce = await getNextNonceForOwner(owner.publicKey);
        console.log("Next nonce for delayed start test:", nextnonce);

        // Calculate PDA for this nonce
        delayedDistributorPda = calculateDistributorPda(tokenMint, owner.publicKey, nextnonce);
        delayedTokenVaultPda = calculateVaultPda(delayedDistributorPda);

        console.log("Delayed SPL Token Distributor PDA:", delayedDistributorPda.toString());
        console.log("Delayed SPL Token Vault PDA:", delayedTokenVaultPda.toString());

        // Create distributor
        const createIx = await program.methods
          .createDistributor(totalAmount)
          .accounts({
            ownerNonce: ownerNoncePda,
            distributor: delayedDistributorPda,
            tokenVault: delayedTokenVaultPda,
            tokenMint: tokenMint,
            ownerTokenAccount: ownerTokenAccount,
            owner: owner.publicKey,
            operator: operator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .instruction();

        const createTx = new Transaction();
        createTx.add(createIx);
        createTx.recentBlockhash = svm.latestBlockhash();
        createTx.feePayer = owner.publicKey;
        createTx.sign(owner);

        const createResult = svm.sendTransaction(createTx);
        console.log("Created delayed start distributor:", createResult);

        // Set merkle root
        const setMerkleIx = await program.methods
          .setMerkleRoot(testMerkleRoot)
          .accounts({
            distributor: delayedDistributorPda,
            operator: operator.publicKey,
          })
          .instruction();

        const merkleRootTx = new Transaction();
        merkleRootTx.add(setMerkleIx);
        merkleRootTx.recentBlockhash = svm.latestBlockhash();
        merkleRootTx.feePayer = operator.publicKey;
        merkleRootTx.sign(operator);

        const merkleResult = svm.sendTransaction(merkleRootTx);
        console.log("Set merkle root for delayed distributor:", merkleResult);

        // Set start time to 1 day (86400 seconds) in the future
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        startTimeOneDayLater = currentTimestamp + 86400; // 1 day = 86400 seconds

        console.log("Setting start time to 1 day later:", startTimeOneDayLater);

        const setTimeIx = await program.methods
          .setTime(new anchor.BN(startTimeOneDayLater))
          .accounts({
            distributor: delayedDistributorPda,
            operator: operator.publicKey,
          })
          .instruction();

        const timeTx = new Transaction();
        timeTx.add(setTimeIx);
        timeTx.recentBlockhash = svm.latestBlockhash();
        timeTx.feePayer = operator.publicKey;
        timeTx.sign(operator);

        const timeResult = svm.sendTransaction(timeTx);
        console.log("Set time for delayed distributor:", timeResult);

        // Verify distributor state
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        expect(distributorAccount.startTime.toString()).to.equal(startTimeOneDayLater.toString());

        console.log("✅ SPL Token distributor with 1 day delay created successfully!");
      } catch (error) {
        console.error("Failed to create delayed start distributor:", error);
        throw error;
      }
    });

    it("Scenario 1: Claim now (before start time) - should fail", async () => {
      try {
        console.log("=== Testing claim before start time (should fail) ===");

        // Create token account for claimant1
        const claimant1TokenAccountKeypair = liteSvmCreateAccount(
          svm,
          tokenMint,
          claimant1.publicKey,
          claimant1,
          TOKEN_PROGRAM_ID,
        );
        delayedClaimant1TokenAccount = claimant1TokenAccountKeypair.publicKey;

        // Find claim status PDA
        [delayedClaimStatusPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), delayedDistributorPda.toBuffer(), claimant1.publicKey.toBuffer()],
          programId,
        );

        const claimIndex = 0;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // Verify current time is before start time
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        console.log("Current timestamp:", currentTimestamp);
        console.log("Start time:", startTimeOneDayLater);
        console.log("Claims should fail:", currentTimestamp < startTimeOneDayLater);

        expect(currentTimestamp).to.be.lessThan(startTimeOneDayLater);

        // Try to claim (should fail)
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            tokenVault: delayedTokenVaultPda,
            claimantTokenAccount: delayedClaimant1TokenAccount,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        claimTx.recentBlockhash = svm.latestBlockhash();
        claimTx.feePayer = claimant1.publicKey;
        claimTx.sign(claimant1);

        const claimResult = svm.sendTransaction(claimTx);
        const txResultStr = String(claimResult);

        // Should fail because claiming before start time
        if (isTransactionFailed(claimResult)) {
          console.log("✅ Claim correctly failed before start time - Transaction failed as expected");
          const errorDetails = formatError(claimResult);
          console.log("✅ Claim correctly failed before start time:", errorDetails);
        } else {
          expect.fail("Claim should have failed before start time");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Claim correctly failed before start time:", errorDetails);
      }
    });

    it("Scenario 2: Claim after 1 day - should succeed and verify token amounts", async () => {
      try {
        console.log("=== Testing claim after 1 day (should succeed) ===");

        // Advance time to 1 day + 1 second later
        const targetTimestamp = startTimeOneDayLater + 1;
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("Advanced time to:", targetTimestamp);

        // Verify time is now after start time
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        expect(currentTimestamp).to.be.greaterThan(startTimeOneDayLater);

        const claimIndex = 0;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // Get initial balances
        const initialVaultBalance = await getAccount(
          provider.connection,
          delayedTokenVaultPda,
          undefined,
          TOKEN_PROGRAM_ID,
        );
        const initialClaimantBalance = await getAccount(
          provider.connection,
          delayedClaimant1TokenAccount,
          undefined,
          TOKEN_PROGRAM_ID,
        );

        console.log("Initial vault balance:", initialVaultBalance.amount.toString());
        console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

        // Execute claim
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            tokenVault: delayedTokenVaultPda,
            claimantTokenAccount: delayedClaimant1TokenAccount,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        ensureUniqueTransaction(claimTx);
        claimTx.feePayer = claimant1.publicKey;
        claimTx.sign(claimant1);

        const claimResult = svm.sendTransaction(claimTx);
        console.log("Claim transaction result:", claimResult);

        // Verify transaction succeeded
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Claim transaction failed: ${txResultStr}`);
        }

        // Verify balances after claim
        const finalVaultBalance = await getAccount(
          provider.connection,
          delayedTokenVaultPda,
          undefined,
          TOKEN_PROGRAM_ID,
        );
        const finalClaimantBalance = await getAccount(
          provider.connection,
          delayedClaimant1TokenAccount,
          undefined,
          TOKEN_PROGRAM_ID,
        );

        console.log("Final vault balance:", finalVaultBalance.amount.toString());
        console.log("Final claimant balance:", finalClaimantBalance.amount.toString());

        // Verify correct amounts
        const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
        const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

        expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
        expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

        // Verify claim status
        const claimStatus = await program.account.claimStatus.fetch(delayedClaimStatusPda);
        expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

        console.log("✅ Claim after 1 day succeeded and token amounts verified!");
      } catch (error) {
        console.error("Claim after 1 day test failed:", error);
        throw error;
      }
    });

    it("Scenario 3: Close claim status now (before end time) - should fail", async () => {
      try {
        console.log("=== Testing close claim status before end time (should fail) ===");

        // Verify we're still before end time
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("Current timestamp:", currentTimestamp);
        console.log("End time:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // Try to close claim status (should fail)
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            claimant: claimant1.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        closeClaimTx.recentBlockhash = svm.latestBlockhash();
        closeClaimTx.feePayer = claimant1.publicKey;
        closeClaimTx.sign(claimant1);

        const closeResult = svm.sendTransaction(closeClaimTx);
        const txResultStr = String(closeResult);

        // Should fail because we're before end time
        if (isTransactionFailed(closeResult)) {
          console.log("✅ Close claim status correctly failed before end time - Transaction failed as expected");
          const errorDetails = formatError(closeResult);
          console.log("✅ Close claim status error details:", errorDetails);
        } else {
          expect.fail("Close claim status should have failed before end time");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Close claim status correctly failed before end time:", errorDetails);
      }
    });

    it("Scenario 4: Owner withdraw now (before end time) - should fail", async () => {
      try {
        console.log("=== Testing owner withdraw before end time (should fail) ===");

        // Verify we're still before end time
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("Current timestamp:", currentTimestamp);
        console.log("End time:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // Try to withdraw (should fail)
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda,
            tokenVault: delayedTokenVaultPda,
            ownerTokenAccount: ownerTokenAccount,
            tokenMint: tokenMint,
            owner: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        withdrawTx.recentBlockhash = svm.latestBlockhash();
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);
        const txResultStr = String(withdrawResult);

        // Should fail because we're before end time
        if (isTransactionFailed(withdrawResult)) {
          console.log("✅ Owner withdraw correctly failed before end time - Transaction failed as expected");
          const errorDetails = formatError(withdrawResult);
          console.log("✅ Owner withdraw error details:", errorDetails);
        } else {
          expect.fail("Owner withdraw should have failed before end time");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Owner withdraw correctly failed before end time:", errorDetails);
      }
    });

    it("Scenario 5: Close claim status after 14 days - should succeed", async () => {
      try {
        console.log("=== Testing close claim status after 14 days (should succeed) ===");

        // Advance time to 14 days after start time
        const targetTimestamp = startTimeOneDayLater + 14 * 24 * 60 * 60 + 1; // 14 days + 1 second
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("Advanced time to 14 days after start time:", targetTimestamp);

        // Verify we're now after end time
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("Current timestamp:", currentTimestamp);
        console.log("End time:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.greaterThan(distributorAccount.endTime.toNumber());

        // Close claim status (should succeed)
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda,
            claimStatus: delayedClaimStatusPda,
            claimant: claimant1.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        ensureUniqueTransaction(closeClaimTx);
        closeClaimTx.feePayer = claimant1.publicKey;
        closeClaimTx.sign(claimant1);

        const closeResult = svm.sendTransaction(closeClaimTx);
        console.log("Close claim status result:", closeResult);

        // Verify transaction succeeded
        const txResultStr = String(closeResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Close claim status failed: ${txResultStr}`);
        }

        // Verify claim status account is closed
        try {
          await program.account.claimStatus.fetch(delayedClaimStatusPda);
          expect.fail("Claim status account should be closed");
        } catch (error) {
          console.log("✅ Claim status account correctly closed");
        }

        console.log("✅ Close claim status after 14 days succeeded!");
      } catch (error) {
        console.error("Close claim status after 14 days test failed:", error);
        throw error;
      }
    });

    it("Scenario 6: Owner withdraw after 14 days - should succeed", async () => {
      try {
        console.log("=== Testing owner withdraw after 14 days (should succeed) ===");

        // Get initial owner balance
        const initialOwnerBalance = await getAccount(
          provider.connection,
          ownerTokenAccount,
          undefined,
          TOKEN_PROGRAM_ID,
        );
        console.log("Initial owner balance:", initialOwnerBalance.amount.toString());

        // Get remaining vault balance
        const vaultBalance = await getAccount(provider.connection, delayedTokenVaultPda, undefined, TOKEN_PROGRAM_ID);
        console.log("Remaining vault balance:", vaultBalance.amount.toString());

        // Execute withdraw
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda,
            tokenVault: delayedTokenVaultPda,
            ownerTokenAccount: ownerTokenAccount,
            tokenMint: tokenMint,
            owner: owner.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        ensureUniqueTransaction(withdrawTx);
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);
        console.log("Withdraw result:", withdrawResult);

        // Verify transaction succeeded
        const txResultStr = String(withdrawResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Withdraw failed: ${txResultStr}`);
        }

        // Verify final owner balance
        const finalOwnerBalance = await getAccount(provider.connection, ownerTokenAccount, undefined, TOKEN_PROGRAM_ID);
        console.log("Final owner balance:", finalOwnerBalance.amount.toString());

        // Verify the correct amount was withdrawn
        const expectedOwnerBalance = initialOwnerBalance.amount + vaultBalance.amount;
        expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

        console.log("✅ Owner withdraw after 14 days succeeded!");
      } catch (error) {
        console.error("Owner withdraw after 14 days test failed:", error);
        throw error;
      }
    });
  });

  // Additional Test Suite 2: Token 2022 with 1 day start time delay
  describe("Token 2022 - 1 Day Start Time Delay Tests", () => {
    let delayedDistributorPda2022: PublicKey;
    let delayedTokenVaultPda2022: PublicKey;
    let delayedClaimant2TokenAccount2022: PublicKey;
    let delayedClaimStatusPda2022: PublicKey;
    let startTimeOneDayLater2022: number;

    it("Create distributor with Token 2022 (1 day start time delay)", async () => {
      const totalAmount = new anchor.BN(500000000000); // 500 tokens

      try {
        console.log("=== Creating Token 2022 distributor with 1 day start time delay ===");

        // Get next nonce number dynamically
        const nextnonce = await getNextNonceForOwner(owner.publicKey);
        console.log("Next nonce for delayed start test (Token 2022):", nextnonce);

        // Calculate PDA for this nonce
        delayedDistributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, nextnonce);
        delayedTokenVaultPda2022 = calculateVaultPda(delayedDistributorPda2022);

        console.log("Delayed Token 2022 Distributor PDA:", delayedDistributorPda2022.toString());
        console.log("Delayed Token 2022 Vault PDA:", delayedTokenVaultPda2022.toString());

        // Create distributor
        const createIx = await program.methods
          .createDistributor(totalAmount)
          .accounts({
            ownerNonce: ownerNoncePda,
            distributor: delayedDistributorPda2022,
            tokenVault: delayedTokenVaultPda2022,
            tokenMint: tokenMint2022,
            ownerTokenAccount: ownerTokenAccount2022,
            owner: owner.publicKey,
            operator: operator.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .instruction();

        const createTx = new Transaction();
        createTx.add(createIx);
        createTx.recentBlockhash = svm.latestBlockhash();
        createTx.feePayer = owner.publicKey;
        createTx.sign(owner);

        const createResult = svm.sendTransaction(createTx);
        console.log("Created delayed start distributor (Token 2022):", createResult);

        // Set merkle root
        const setMerkleIx = await program.methods
          .setMerkleRoot(testMerkleRoot)
          .accounts({
            distributor: delayedDistributorPda2022,
            operator: operator.publicKey,
          })
          .instruction();

        const merkleRootTx = new Transaction();
        merkleRootTx.add(setMerkleIx);
        merkleRootTx.recentBlockhash = svm.latestBlockhash();
        merkleRootTx.feePayer = operator.publicKey;
        merkleRootTx.sign(operator);

        const merkleResult = svm.sendTransaction(merkleRootTx);
        console.log("Set merkle root for delayed distributor (Token 2022):", merkleResult);

        // Set start time to 1 day (86400 seconds) in the future
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        startTimeOneDayLater2022 = currentTimestamp + 86400; // 1 day = 86400 seconds

        console.log("Setting start time to 1 day later (Token 2022):", startTimeOneDayLater2022);

        const setTimeIx = await program.methods
          .setTime(new anchor.BN(startTimeOneDayLater2022))
          .accounts({
            distributor: delayedDistributorPda2022,
            operator: operator.publicKey,
          })
          .instruction();

        const timeTx = new Transaction();
        timeTx.add(setTimeIx);
        timeTx.recentBlockhash = svm.latestBlockhash();
        timeTx.feePayer = operator.publicKey;
        timeTx.sign(operator);

        const timeResult = svm.sendTransaction(timeTx);
        console.log("Set time for delayed distributor (Token 2022):", timeResult);

        // Verify distributor state
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        expect(distributorAccount.startTime.toString()).to.equal(startTimeOneDayLater2022.toString());

        console.log("✅ Token 2022 distributor with 1 day delay created successfully!");
      } catch (error) {
        console.error("Failed to create delayed start distributor (Token 2022):", error);
        throw error;
      }
    });

    it("Scenario 1: Claim now (before start time) - should fail", async () => {
      try {
        console.log("=== Testing Token 2022 claim before start time (should fail) ===");

        // Create token account for claimant2
        const claimant2TokenAccountKeypair = liteSvmCreateAccount(
          svm,
          tokenMint2022,
          claimant2.publicKey,
          claimant2,
          TOKEN_2022_PROGRAM_ID,
        );
        delayedClaimant2TokenAccount2022 = claimant2TokenAccountKeypair.publicKey;

        // Find claim status PDA
        [delayedClaimStatusPda2022] = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), delayedDistributorPda2022.toBuffer(), claimant2.publicKey.toBuffer()],
          programId,
        );

        const claimIndex = 1;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // Verify current time is before start time
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        console.log("Current timestamp:", currentTimestamp);
        console.log("Start time:", startTimeOneDayLater2022);
        expect(currentTimestamp).to.be.lessThan(startTimeOneDayLater2022);

        // Try to claim (should fail)
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            tokenVault: delayedTokenVaultPda2022,
            claimantTokenAccount: delayedClaimant2TokenAccount2022,
            tokenMint: tokenMint2022,
            claimant: claimant2.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        claimTx.recentBlockhash = svm.latestBlockhash();
        claimTx.feePayer = claimant2.publicKey;
        claimTx.sign(claimant2);

        const claimResult = svm.sendTransaction(claimTx);
        const txResultStr = String(claimResult);

        // Should fail because claiming before start time
        if (isTransactionFailed(claimResult)) {
          console.log("✅ Token 2022 claim correctly failed before start time - Transaction failed as expected");
          const errorDetails = formatError(claimResult);
          console.log("✅ Token 2022 claim error details:", errorDetails);
        } else {
          expect.fail("Token 2022 claim should have failed before start time");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Token 2022 claim correctly failed before start time:", errorDetails);
      }
    });

    it("Scenario 2: Claim after 1 day - should succeed and verify token amounts", async () => {
      try {
        console.log("=== Testing Token 2022 claim after 1 day (should succeed) ===");

        // Advance time to 1 day + 1 second later
        const targetTimestamp = startTimeOneDayLater2022 + 1;
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("Advanced time to:", targetTimestamp);

        // Verify time is now after start time
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);
        expect(currentTimestamp).to.be.greaterThan(startTimeOneDayLater2022);

        const claimIndex = 1;
        const claimAmount = testTreeNodes[claimIndex].amount;
        const proof = testMerkleTree.getProof(claimIndex);
        const proofArray: number[][] = proof.map((p) => Array.from(p));

        // Get initial balances
        const initialVaultBalance = await getAccount(
          provider.connection,
          delayedTokenVaultPda2022,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );
        const initialClaimantBalance = await getAccount(
          provider.connection,
          delayedClaimant2TokenAccount2022,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );

        console.log("Initial vault balance:", initialVaultBalance.amount.toString());
        console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

        // Execute claim
        const claimIx = await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            tokenVault: delayedTokenVaultPda2022,
            claimantTokenAccount: delayedClaimant2TokenAccount2022,
            tokenMint: tokenMint2022,
            claimant: claimant2.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const claimTx = new Transaction();
        claimTx.add(claimIx);
        ensureUniqueTransaction(claimTx);
        claimTx.feePayer = claimant2.publicKey;
        claimTx.sign(claimant2);

        const claimResult = svm.sendTransaction(claimTx);
        console.log("Token 2022 claim transaction result:", claimResult);

        // Verify transaction succeeded
        const txResultStr = String(claimResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Token 2022 claim transaction failed: ${txResultStr}`);
        }

        // Verify balances after claim
        const finalVaultBalance = await getAccount(
          provider.connection,
          delayedTokenVaultPda2022,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );
        const finalClaimantBalance = await getAccount(
          provider.connection,
          delayedClaimant2TokenAccount2022,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );

        console.log("Final vault balance:", finalVaultBalance.amount.toString());
        console.log("Final claimant balance:", finalClaimantBalance.amount.toString());

        // Verify correct amounts
        const expectedVaultBalance = initialVaultBalance.amount - BigInt(claimAmount.toNumber());
        const expectedClaimantBalance = initialClaimantBalance.amount + BigInt(claimAmount.toNumber());

        expect(finalVaultBalance.amount.toString()).to.equal(expectedVaultBalance.toString());
        expect(finalClaimantBalance.amount.toString()).to.equal(expectedClaimantBalance.toString());

        // Verify claim status
        const claimStatus = await program.account.claimStatus.fetch(delayedClaimStatusPda2022);
        expect(claimStatus.claimedAmount.toString()).to.equal(claimAmount.toString());

        console.log("✅ Token 2022 claim after 1 day succeeded and token amounts verified!");
      } catch (error) {
        console.error("Token 2022 claim after 1 day test failed:", error);
        throw error;
      }
    });

    it("Scenario 3: Close claim status now (before end time) - should fail", async () => {
      try {
        console.log("=== Testing Token 2022 close claim status before end time (should fail) ===");

        // Verify we're still before end time
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("Current timestamp:", currentTimestamp);
        console.log("End time:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // Try to close claim status (should fail)
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            claimant: claimant2.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        closeClaimTx.recentBlockhash = svm.latestBlockhash();
        closeClaimTx.feePayer = claimant2.publicKey;
        closeClaimTx.sign(claimant2);

        const closeResult = svm.sendTransaction(closeClaimTx);
        const txResultStr = String(closeResult);

        // Should fail because we're before end time
        if (isTransactionFailed(closeResult)) {
          console.log(
            "✅ Token 2022 close claim status correctly failed before end time - Transaction failed as expected",
          );
          const errorDetails = formatError(closeResult);
          console.log("✅ Token 2022 close claim status error details:", errorDetails);
        } else {
          expect.fail("Token 2022 close claim status should have failed before end time");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Token 2022 close claim status correctly failed before end time:", errorDetails);
      }
    });

    it("Scenario 4: Owner withdraw now (before end time) - should fail", async () => {
      try {
        console.log("=== Testing Token 2022 owner withdraw before end time (should fail) ===");

        // Verify we're still before end time
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("Current timestamp:", currentTimestamp);
        console.log("End time:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.lessThan(distributorAccount.endTime.toNumber());

        // Try to withdraw (should fail)
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda2022,
            tokenVault: delayedTokenVaultPda2022,
            ownerTokenAccount: ownerTokenAccount2022,
            tokenMint: tokenMint2022,
            owner: owner.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        withdrawTx.recentBlockhash = svm.latestBlockhash();
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);
        const txResultStr = String(withdrawResult);

        // Should fail because we're before end time
        if (isTransactionFailed(withdrawResult)) {
          console.log("✅ Token 2022 owner withdraw correctly failed before end time - Transaction failed as expected");
          const errorDetails = formatError(withdrawResult);
          console.log("✅ Token 2022 owner withdraw error details:", errorDetails);
        } else {
          expect.fail("Token 2022 owner withdraw should have failed before end time");
        }
      } catch (error) {
        const errorDetails = formatError(error);
        console.log("✅ Token 2022 owner withdraw correctly failed before end time:", errorDetails);
      }
    });

    it("Scenario 5: Close claim status after 14 days - should succeed", async () => {
      try {
        console.log("=== Testing Token 2022 close claim status after 14 days (should succeed) ===");

        // Advance time to 14 days after start time
        const targetTimestamp = startTimeOneDayLater2022 + 14 * 24 * 60 * 60 + 1; // 14 days + 1 second
        const updatedClock = svm.getClock();
        updatedClock.unixTimestamp = BigInt(targetTimestamp);
        svm.setClock(updatedClock);

        console.log("Advanced time to 14 days after start time:", targetTimestamp);

        // Verify we're now after end time
        const distributorAccount = await program.account.tokenDistributor.fetch(delayedDistributorPda2022);
        const currentClock = svm.getClock();
        const currentTimestamp = Number(currentClock.unixTimestamp);

        console.log("Current timestamp:", currentTimestamp);
        console.log("End time:", distributorAccount.endTime.toString());
        expect(currentTimestamp).to.be.greaterThan(distributorAccount.endTime.toNumber());

        // Close claim status (should succeed)
        const closeClaimIx = await program.methods
          .closeClaimStatus()
          .accounts({
            distributorKey: delayedDistributorPda2022,
            claimStatus: delayedClaimStatusPda2022,
            claimant: claimant2.publicKey,
          })
          .instruction();

        const closeClaimTx = new Transaction();
        closeClaimTx.add(closeClaimIx);
        ensureUniqueTransaction(closeClaimTx);
        closeClaimTx.feePayer = claimant2.publicKey;
        closeClaimTx.sign(claimant2);

        const closeResult = svm.sendTransaction(closeClaimTx);
        console.log("Token 2022 close claim status result:", closeResult);

        // Verify transaction succeeded
        const txResultStr = String(closeResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Token 2022 close claim status failed: ${txResultStr}`);
        }

        // Verify claim status account is closed
        try {
          await program.account.claimStatus.fetch(delayedClaimStatusPda2022);
          expect.fail("Token 2022 claim status account should be closed");
        } catch (error) {
          console.log("✅ Token 2022 claim status account correctly closed");
        }

        console.log("✅ Token 2022 close claim status after 14 days succeeded!");
      } catch (error) {
        console.error("Token 2022 close claim status after 14 days test failed:", error);
        throw error;
      }
    });

    it("Scenario 6: Owner withdraw after 14 days - should succeed", async () => {
      try {
        console.log("=== Testing Token 2022 owner withdraw after 14 days (should succeed) ===");

        // Get initial owner balance
        const initialOwnerBalance = await getAccount(
          provider.connection,
          ownerTokenAccount2022,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );
        console.log("Initial owner balance:", initialOwnerBalance.amount.toString());

        // Get remaining vault balance
        const vaultBalance = await getAccount(
          provider.connection,
          delayedTokenVaultPda2022,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );
        console.log("Remaining vault balance:", vaultBalance.amount.toString());

        // Execute withdraw
        const withdrawIx = await program.methods
          .withdraw()
          .accounts({
            distributor: delayedDistributorPda2022,
            tokenVault: delayedTokenVaultPda2022,
            ownerTokenAccount: ownerTokenAccount2022,
            tokenMint: tokenMint2022,
            owner: owner.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .instruction();

        const withdrawTx = new Transaction();
        withdrawTx.add(withdrawIx);
        ensureUniqueTransaction(withdrawTx);
        withdrawTx.feePayer = owner.publicKey;
        withdrawTx.sign(owner);

        const withdrawResult = svm.sendTransaction(withdrawTx);

        // Verify transaction succeeded
        const txResultStr = String(withdrawResult);
        if (txResultStr.includes("FailedTransactionMetadata") || txResultStr === "FailedTransactionMetadata {}") {
          throw new Error(`Token 2022 withdraw failed: ${txResultStr}`);
        }

        // Verify final owner balance
        const finalOwnerBalance = await getAccount(
          provider.connection,
          ownerTokenAccount2022,
          undefined,
          TOKEN_2022_PROGRAM_ID,
        );
        console.log("Final owner balance:", finalOwnerBalance.amount.toString());

        // Verify the correct amount was withdrawn
        const expectedOwnerBalance = initialOwnerBalance.amount + vaultBalance.amount;
        expect(finalOwnerBalance.amount.toString()).to.equal(expectedOwnerBalance.toString());

        console.log("✅ Token 2022 owner withdraw after 14 days succeeded!");
      } catch (error) {
        console.error("Token 2022 owner withdraw after 14 days test failed:", error);
        throw error;
      }
    });
  });
});
