import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
  MINT_SIZE,
  createInitializeMintInstruction,
  ACCOUNT_SIZE,
  createInitializeAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  createMint as createMint2022,
  createAccount as createAccount2022,
  mintTo as mintTo2022,
  TOKEN_2022_PROGRAM_ID,
  getAccount as getAccount2022,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { SimpleMerkleTree } from "./utils/merkle_tree";
import * as path from "path";
import { startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import * as crypto from "crypto";
import { Clock } from "solana-bankrun";

/**
 * Manually create an SPL Token Mint (supports TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID)
 * @param provider BankrunProvider or AnchorProvider
 * @param mintAuthority Address that has mint authority
 * @param decimals Token precision (usually 6 or 9)
 * @param programId TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 * @param seed Optional seed string for generating deterministic addresses
 * @returns mint Keypair
 */
async function manualCreateMint(
  provider: any,
  mintAuthority: PublicKey,
  decimals = 9,
  programId = TOKEN_PROGRAM_ID,
  seed?: string,
): Promise<Keypair> {
  // Use seed to generate keypair with optional randomness
  let mintSeed: string;
  if (seed) {
    mintSeed = seed;
  } else {
    // Add timestamp and random component to ensure uniqueness across test runs
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    mintSeed = `mint-${mintAuthority.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;
  }

  // Use SHA256 hash to generate unique seed
  const hash = crypto.createHash("sha256").update(mintSeed).digest();
  const mint = Keypair.fromSeed(hash);

  // Rent calculation (Token 2022 uses same MINT_SIZE)
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const tx = new Transaction();

  // Create Mint account (System Program)
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
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
      mintAuthority, // mint authority
      null, // freeze authority (optional)
      programId,
    ),
  );

  // Send transaction (note: mint is signer)
  await provider.sendAndConfirm(tx, [mint]);

  return mint;
}

/**
 * Manually create a Token Account (supports TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID)
 * @param provider BankrunProvider or AnchorProvider
 * @param mint Token mint address
 * @param owner Token account owner
 * @param programId TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 * @returns token account Keypair
 */
async function manualCreateAccount(
  provider: any,
  mint: PublicKey,
  owner: PublicKey,
  programId = TOKEN_PROGRAM_ID,
): Promise<Keypair> {
  // Add timestamp and random component to ensure uniqueness across test runs
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  const accountSeed = `account-${mint.toBase58()}-${owner.toBase58()}-${programId.toBase58()}-${timestamp}-${random}`;

  // Use SHA256 hash to generate unique seed
  const hash = crypto.createHash("sha256").update(accountSeed).digest();
  const account = Keypair.fromSeed(hash);

  // Rent calculation
  const lamports = await provider.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);

  const tx = new Transaction();

  // Create Token Account (System Program)
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: provider.wallet.publicKey,
      newAccountPubkey: account.publicKey,
      lamports,
      space: ACCOUNT_SIZE,
      programId: programId,
    }),
  );

  // Initialize Token Account (SPL Token CPI)
  tx.add(createInitializeAccountInstruction(account.publicKey, mint, owner, programId));

  // Send transaction (note: account is signer)
  await provider.sendAndConfirm(tx, [account]);

  return account;
}

/**
 * Manually mint tokens to specified account (supports TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID)
 * @param provider BankrunProvider or AnchorProvider
 * @param mint Token mint address
 * @param destination Target token account address
 * @param authority mint authority
 * @param amount Amount to mint
 * @param programId TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID
 * @returns Transaction signature
 */
async function manualMintTo(
  provider: any,
  mint: PublicKey,
  destination: PublicKey,
  authority: Keypair,
  amount: number,
  programId = TOKEN_PROGRAM_ID,
): Promise<string> {
  const tx = new Transaction();

  // Add mint instruction
  tx.add(createMintToInstruction(mint, destination, authority.publicKey, amount, [], programId));

  // Send transaction (note: authority is signer)
  return await provider.sendAndConfirm(tx, [authority]);
}

describe("token_distributor_bankrun", () => {
  let context: any;
  let provider: BankrunProvider;
  let program: Program<TokenDistributor>;

  let tokenMint: PublicKey;
  let tokenMint2022: PublicKey;
  let owner: Keypair;
  let operator: Keypair;
  let ownerTokenAccount: PublicKey;
  let ownerTokenAccount2022: PublicKey;

  // nonce state PDA
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
      program.programId,
    );
    return pda;
  }

  // Helper function to calculate vault PDA
  function calculateVaultPda(distributorPda: PublicKey): PublicKey {
    const VAULT_SEED = "vault";
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(VAULT_SEED), distributorPda.toBuffer()],
      program.programId,
    );
    return pda;
  }

  before(async () => {
    // Start bankrun with Anchor integration
    context = await startAnchor("", [], []);

    // Create BankrunProvider
    provider = new BankrunProvider(context);

    // Get the program
    anchor.setProvider(provider);
    program = anchor.workspace.TokenDistributor as Program<TokenDistributor>;

    // Use context payer as owner (it has SOL)
    owner = context.payer;
    operator = Keypair.generate();

    console.log("Using bankrun payer as owner:", owner.publicKey.toString());
    console.log("Generated operator:", operator.publicKey.toString());

    // Calculate nonce state PDA
    const OWNER_NONCE_SEED = "owner_nonce";
    [ownerNoncePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(OWNER_NONCE_SEED), owner.publicKey.toBuffer()],
      program.programId,
    );
    console.log("Nonce State PDA:", ownerNoncePda.toString());

    // Check balance
    const balance = await context.banksClient.getBalance(owner.publicKey);
    console.log("Owner balance:", Number(balance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

    // Give operator some SOL from owner
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: operator.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL, // 1 SOL
      }),
    );
    transferTx.recentBlockhash = context.lastBlockhash;
    transferTx.sign(owner);
    await context.banksClient.processTransaction(transferTx);
    console.log("Transferred 1 SOL to operator");

    // Create test claimants with keypairs we control
    claimant1 = Keypair.generate();
    claimant2 = Keypair.generate();

    // Give claimants some SOL for transaction fees
    for (const claimant of [claimant1, claimant2]) {
      const claimantTransferTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: claimant.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL * 0.1, // 0.1 SOL
        }),
      );
      claimantTransferTx.recentBlockhash = context.lastBlockhash;
      claimantTransferTx.sign(owner);
      await context.banksClient.processTransaction(claimantTransferTx);
    }
    console.log("Created test claimants and transferred SOL for transaction fees");

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
    console.log("Created test merkle tree with controlled keypairs");
    console.log("Test merkle root:", testMerkleRoot);

    // Create SPL token mint (nonce 1) using manual approach
    const tokenMintKeypair = await manualCreateMint(provider, owner.publicKey, 9);
    tokenMint = tokenMintKeypair.publicKey;
    console.log("SPL Token mint created:", tokenMint.toString());

    // Create Token 2022 mint (nonce 2) using manual approach
    console.log("Creating Token 2022 mint...");
    const tokenMint2022Keypair = await manualCreateMint(provider, owner.publicKey, 9, TOKEN_2022_PROGRAM_ID);
    tokenMint2022 = tokenMint2022Keypair.publicKey;
    console.log("Token 2022 mint created:", tokenMint2022.toString());

    // Create token accounts and mint tokens
    console.log("Creating token accounts using manual approach...");
    const ownerTokenAccountKeypair = await manualCreateAccount(provider, tokenMint, owner.publicKey, TOKEN_PROGRAM_ID);
    ownerTokenAccount = ownerTokenAccountKeypair.publicKey;

    const ownerTokenAccount2022Keypair = await manualCreateAccount(
      provider,
      tokenMint2022,
      owner.publicKey,
      TOKEN_2022_PROGRAM_ID,
    );
    ownerTokenAccount2022 = ownerTokenAccount2022Keypair.publicKey;

    console.log("SPL token account created:", ownerTokenAccount.toString());
    console.log("Token 2022 account created:", ownerTokenAccount2022.toString());

    // Mint some tokens to owner accounts
    console.log("Minting tokens to owner accounts...");
    const mintAmount = 1000000000000; // 1000 tokens with 9 decimals

    // Mint SPL tokens
    await manualMintTo(provider, tokenMint, ownerTokenAccount, owner, mintAmount, TOKEN_PROGRAM_ID);
    console.log("Minted SPL tokens to owner account");

    // Mint Token 2022 tokens
    await manualMintTo(provider, tokenMint2022, ownerTokenAccount2022, owner, mintAmount, TOKEN_2022_PROGRAM_ID);
    console.log("Minted Token 2022 tokens to owner account");

    // Calculate PDAs for first distributors (will be nonces 1 and 2)
    distributorPda = calculateDistributorPda(tokenMint, owner.publicKey, 1);
    tokenVaultPda = calculateVaultPda(distributorPda);

    distributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, 2);
    tokenVaultPda2022 = calculateVaultPda(distributorPda2022);

    // Note: withdraw test PDAs will be calculated dynamically based on actual counter state

    console.log("Calculated PDAs:");
    console.log("SPL Token Distributor PDA:", distributorPda.toString());
    console.log("SPL Token Vault PDA:", tokenVaultPda.toString());
    console.log("Token 2022 Distributor PDA:", distributorPda2022.toString());
    console.log("Token 2022 Vault PDA:", tokenVaultPda2022.toString());

    // Note: withdraw test PDAs will be calculated dynamically based on actual counter state
  });

  it("Create distributor with SPL Token (nonce 1)", async () => {
    const totalAmount = new anchor.BN(500000000000); // 500 tokens

    try {
      console.log("Calling createDistributor with SPL Token, totalAmount:", totalAmount.toString());

      const tx = await program.methods
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
        .signers([owner])
        .rpc();

      console.log("Create SPL Token distributor transaction signature:", tx);

      // Verify nonce state was created/updated
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("Nonce State data:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("1");

      // Verify token vault balance after creating distributor
      console.log("Verifying SPL Token vault balance...");
      const vaultAccount = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      console.log("SPL Token Vault Balance:", vaultAccount.amount.toString());
      console.log("SPL Token Vault Mint:", vaultAccount.mint.toString());
      console.log("Expected Total Amount:", totalAmount.toString());

      // Verify vault has correct amount and mint
      expect(vaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(vaultAccount.mint.toString()).to.equal(tokenMint.toString());

      // Verify distributor account exists and has data
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);

      console.log("SPL Token Distributor account data:", {
        owner: distributorAccount.owner.toString(),
        operator: distributorAccount.operator.toString(),
        tokenMint: distributorAccount.tokenMint.toString(),
        initialTotalAmount: distributorAccount.initialTotalAmount.toString(),
        totalClaimed: distributorAccount.totalClaimed.toString(),
        nonce: distributorAccount.nonce.toString(),
      });

      // Basic verification
      expect(distributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(distributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(distributorAccount.tokenMint.toString()).to.equal(tokenMint.toString());
      expect(distributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(distributorAccount.totalClaimed.toString()).to.equal("0"); // Should be 0 initially
      expect(distributorAccount.nonce.toString()).to.equal("1");

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

      const tx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: distributorPda2022,
          tokenVault: tokenVaultPda2022,
          tokenMint: tokenMint2022,
          ownerTokenAccount: ownerTokenAccount2022,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([owner])
        .rpc();

      console.log("Create Token 2022 distributor transaction signature:", tx);

      // Verify nonce state was updated
      const ownerNonceAccount = await program.account.nonceState.fetch(ownerNoncePda);
      console.log("Updated Nonce State data:", {
        currentNonce: ownerNonceAccount.nonce.toString(),
      });

      expect(ownerNonceAccount.nonce.toString()).to.equal("2");

      // Verify token vault balance after creating distributor
      console.log("Verifying Token 2022 vault balance...");
      const vaultAccount = await getAccount(provider.connection, tokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);

      console.log("Token 2022 Vault Balance:", vaultAccount.amount.toString());
      console.log("Token 2022 Vault Mint:", vaultAccount.mint.toString());
      console.log("Expected Total Amount:", totalAmount.toString());

      // Verify vault has correct amount and mint
      expect(vaultAccount.amount.toString()).to.equal(totalAmount.toString());
      expect(vaultAccount.mint.toString()).to.equal(tokenMint2022.toString());

      // Verify distributor account exists and has data
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);

      console.log("Token 2022 Distributor account data:", {
        owner: distributorAccount.owner.toString(),
        operator: distributorAccount.operator.toString(),
        tokenMint: distributorAccount.tokenMint.toString(),
        initialTotalAmount: distributorAccount.initialTotalAmount.toString(),
        totalClaimed: distributorAccount.totalClaimed.toString(),
        nonce: distributorAccount.nonce.toString(),
      });

      // Basic verification
      expect(distributorAccount.owner.toString()).to.equal(owner.publicKey.toString());
      expect(distributorAccount.operator.toString()).to.equal(operator.publicKey.toString());
      expect(distributorAccount.tokenMint.toString()).to.equal(tokenMint2022.toString());
      expect(distributorAccount.initialTotalAmount.toString()).to.equal(totalAmount.toString());
      expect(distributorAccount.totalClaimed.toString()).to.equal("0"); // Should be 0 initially
      expect(distributorAccount.nonce.toString()).to.equal("2");

      console.log("✅ Create Token 2022 distributor test passed!");
    } catch (error) {
      console.error("Create Token 2022 distributor test failed:", error);
      throw error;
    }
  });

  it("Set merkle root for both distributors", async () => {
    console.log("Using predefined test merkle root...");

    // Use the predefined test merkle root
    const merkleRoot = testMerkleRoot;

    console.log("Test merkle root:", merkleRoot);
    console.log("Merkle root length:", merkleRoot.length);

    console.log("Setting merkle root for SPL Token distributor (nonce 1)...");

    const tx1 = await program.methods
      .setMerkleRoot(merkleRoot)
      .accounts({
        distributor: distributorPda,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("Set merkle root transaction signature for nonce 1:", tx1);

    console.log("Setting merkle root for Token 2022 distributor (nonce 2)...");

    const tx2 = await program.methods
      .setMerkleRoot(merkleRoot)
      .accounts({
        distributor: distributorPda2022,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("Set merkle root transaction signature for nonce 2:", tx2);

    // Verify merkle root was set for both distributors
    const distributorAccount1 = await program.account.tokenDistributor.fetch(distributorPda);
    const distributorAccount2022 = await program.account.tokenDistributor.fetch(distributorPda2022);

    console.log("Merkle root set for nonce 1:", distributorAccount1.merkleRoot);
    console.log("Merkle root set for nonce 2:", distributorAccount2022.merkleRoot);

    // Verify merkle root matches what we set
    expect(distributorAccount1.merkleRoot).to.deep.equal(merkleRoot);
    expect(distributorAccount2022.merkleRoot).to.deep.equal(merkleRoot);

    console.log("✅ Set merkle root test passed for both distributors!");
  });

  it("Set time for nonce 1 and nonce 2 [current time]", async () => {
    console.log("Getting current Solana blockchain time...");

    // Get current Solana blockchain time using context.banksClient
    const clock = await context.banksClient.getClock();
    const blockTime = Number(clock.unixTimestamp);

    console.log("Current Solana block time:", blockTime);

    // Set time for nonce 1 (SPL Token) to current time + 4 seconds
    const startTimeV1 = blockTime + 4; // 4 seconds from now to satisfy validation
    console.log("Setting time for nonce 1 (SPL Token) to current time + 4 seconds:", startTimeV1);

    const tx1 = await program.methods
      .setTime(new anchor.BN(startTimeV1))
      .accounts({
        distributor: distributorPda,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("Set time transaction signature for nonce 1:", tx1);

    // Set time for nonce 2 (Token 2022) to after nonce 1 ends
    // nonce 1 duration is 14 days (1,209,600 seconds), so nonce 2 starts after that + 10 seconds buffer
    const DURATION = 14 * 24 * 60 * 60; // 14 days in seconds
    const startTimeV2 = startTimeV1 + DURATION + 10; // nonce 1 end time + 10 seconds buffer
    console.log("Setting time for nonce 2 (Token 2022) to after nonce 1 ends (+ 10 seconds buffer):", startTimeV2);

    const tx2 = await program.methods
      .setTime(new anchor.BN(startTimeV2))
      .accounts({
        distributor: distributorPda2022,
        operator: operator.publicKey,
      })
      .signers([operator])
      .rpc();

    console.log("Set time transaction signature for nonce 2:", tx2);

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
  });

  it("Claim tokens for nonce 1 (SPL Token)[current time]", async () => {
    try {
      console.log("=== Testing claim for nonce 1 (SPL Token) ===");

      console.log("Using predefined test claimants and merkle tree data");

      // Test claim for claimant1 (1000 tokens)
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

      // Create token account for claimant1 using our manual function
      const claimant1TokenAccount = await manualCreateAccount(
        provider,
        tokenMint,
        claimant1.publicKey,
        TOKEN_PROGRAM_ID,
      );
      console.log("Created claimant1 token account:", claimant1TokenAccount.publicKey.toString());

      // Find claim status PDA for claimant1
      const [claimStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), distributorPda.toBuffer(), claimant1.publicKey.toBuffer()],
        program.programId,
      );

      // Get initial token balances
      const initialVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const initialClaimantBalance = await getAccount(
        provider.connection,
        claimant1TokenAccount.publicKey,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

      // Test that early claim before distribution time fails
      console.log("=== Testing early claim before distribution time (should fail) ===");

      try {
        console.log("Attempting to claim before distribution time (expecting failure)...");

        // Check current time vs distribution time
        const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
        const currentClock = await context.banksClient.getClock();
        const currentBlockTime = Number(currentClock.unixTimestamp);

        console.log("Current block time:", currentBlockTime);
        console.log("Distribution time:", distributorAccount.startTime.toString());
        console.log("Time until start:", distributorAccount.startTime.toNumber() - currentBlockTime, "seconds");

        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount.publicKey,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([claimant1])
          .rpc();

        // If we reach here, the test should fail because claim should have been rejected
        expect.fail("Early claim should have failed but succeeded unexpectedly");
      } catch (error) {
        // This is expected - the claim should fail
        console.log("✅ Early claim correctly failed with error:", error.message);

        // Verify it's the right kind of error (distribution not started)
        expect(error.message).to.include("DistributionNotStarted");
        console.log("✅ Error type verified: DistributionNotStarted");
        console.log("✅ Early claim test passed - claim correctly rejected before distribution time!");
      }

      // Use time travel to jump to distribution time instead of waiting
      console.log("=== Using time travel to jump to distribution time ===");
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      const startTime = distributorAccount.startTime.toNumber();

      // Get current clock and create new clock with updated timestamp
      const currentClock = await context.banksClient.getClock();
      console.log("Current time:", Number(currentClock.unixTimestamp));
      console.log("Jumping to distribution time:", startTime);

      // Use setClock to jump to the distribution start time
      context.setClock(
        new Clock(
          currentClock.slot,
          currentClock.epochStartTimestamp,
          currentClock.epoch,
          currentClock.leaderScheduleEpoch,
          BigInt(startTime + 1), // +1 second to ensure we're past the start time
        ),
      );

      const newClock = await context.banksClient.getClock();
      console.log("New time after time travel:", Number(newClock.unixTimestamp));
      console.log("✅ Time travel successful!");

      // Execute the claim transaction
      console.log("Executing claim transaction...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda,
          claimantTokenAccount: claimant1TokenAccount.publicKey,
          tokenMint: tokenMint,
          claimant: claimant1.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([claimant1])
        .rpc();

      console.log("Claim transaction signature:", claimTx);

      // Verify balances after claim
      const finalVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const finalClaimantBalance = await getAccount(
        provider.connection,
        claimant1TokenAccount.publicKey,
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
      console.log("Testing double claim prevention...");
      try {
        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount.publicKey,
            tokenMint: tokenMint,
            claimant: claimant1.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([claimant1])
          .rpc();

        // If we get here, the test should fail
        expect.fail("Double claim should have failed");
      } catch (error) {
        console.log("✅ Double claim correctly prevented:", error.message);
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

      console.log("Using predefined test claimants and merkle tree data");

      // Test claim for claimant2 (2000 tokens)
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

      // Create token account for claimant2 using our manual function
      const claimant2TokenAccount = await manualCreateAccount(
        provider,
        tokenMint2022,
        claimant2.publicKey,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Created claimant2 token account:", claimant2TokenAccount.publicKey.toString());

      // Find claim status PDA for claimant2
      const [claimStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), distributorPda2022.toBuffer(), claimant2.publicKey.toBuffer()],
        program.programId,
      );

      // Get initial token balances
      const initialVaultBalance = await getAccount2022(
        provider.connection,
        tokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const initialClaimantBalance = await getAccount2022(
        provider.connection,
        claimant2TokenAccount.publicKey,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

      // Note: Early claim testing is already covered in SPL Token test above

      // Use time travel to jump to distribution start time instead of waiting
      console.log("=== Using time travel to jump to distribution start time ===");
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);
      const startTime = distributorAccount.startTime.toNumber();

      // Get current clock and create new clock with updated timestamp
      const currentClock = await context.banksClient.getClock();
      console.log("Current time:", Number(currentClock.unixTimestamp));
      console.log("Jumping to distribution start time:", startTime);

      // Use setClock to jump to the distribution start time
      context.setClock(
        new Clock(
          currentClock.slot,
          currentClock.epochStartTimestamp,
          currentClock.epoch,
          currentClock.leaderScheduleEpoch,
          BigInt(startTime + 1), // +1 second to ensure we're past the start time
        ),
      );

      const newClock = await context.banksClient.getClock();
      console.log("New time after time travel:", Number(newClock.unixTimestamp));
      console.log("✅ Time travel successful!");

      // Execute the claim transaction
      console.log("Executing claim transaction...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda2022,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda2022,
          claimantTokenAccount: claimant2TokenAccount.publicKey,
          tokenMint: tokenMint2022,
          claimant: claimant2.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([claimant2])
        .rpc();

      console.log("Claim transaction signature:", claimTx);

      // Verify balances after claim
      const finalVaultBalance = await getAccount2022(
        provider.connection,
        tokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const finalClaimantBalance = await getAccount2022(
        provider.connection,
        claimant2TokenAccount.publicKey,
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

      // Test that double claiming fails
      console.log("Testing double claim prevention...");
      try {
        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda2022,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda2022,
            claimantTokenAccount: claimant2TokenAccount.publicKey,
            tokenMint: tokenMint2022,
            claimant: claimant2.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([claimant2])
          .rpc();

        // If we get here, the test should fail
        expect.fail("Double claim should have failed");
      } catch (error) {
        console.log("✅ Double claim correctly prevented:", error.message);
      }

      console.log("✅ Claim test completed successfully!");
    } catch (error) {
      console.error("Claim test failed:", error);
      throw error;
    }
  });

  it("Withdraw tokens (SPL Token) - No start time set", async () => {
    // Get next nonce number dynamically (declared outside try-catch for scope)
    const nextnonce = await getNextNonceForOwner(owner.publicKey);

    try {
      console.log("=== Testing withdraw (SPL Token) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      console.log("Next nonce for withdraw test:", nextnonce);

      // Calculate PDA for this nonce
      withdrawTestDistributorPda = calculateDistributorPda(tokenMint, owner.publicKey, nextnonce);
      withdrawTestTokenVaultPda = calculateVaultPda(withdrawTestDistributorPda);

      console.log("Withdraw Test SPL Token Distributor PDA:", withdrawTestDistributorPda.toString());
      console.log("Withdraw Test SPL Token Vault PDA:", withdrawTestTokenVaultPda.toString());

      // Get initial owner SOL balance
      const initialOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("Initial owner SOL balance:", Number(initialOwnerSolBalance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Create distributor for withdraw test
      console.log("Creating distributor for withdraw test (nonce", nextnonce, ")...");
      const createTx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: withdrawTestDistributorPda,
          tokenVault: withdrawTestTokenVaultPda,
          tokenMint: tokenMint,
          ownerTokenAccount: ownerTokenAccount,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([owner])
        .rpc();

      console.log("Created withdraw test distributor transaction:", createTx);

      // Get SOL balance after creating distributor (should be lower due to rent and tx fees)
      const afterCreateSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log(
        "Owner SOL balance after create:",
        Number(afterCreateSolBalance) / anchor.web3.LAMPORTS_PER_SOL,
        "SOL",
      );

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

      // Get SOL balance just before withdraw
      const beforeWithdrawSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log(
        "Owner SOL balance before withdraw:",
        Number(beforeWithdrawSolBalance) / anchor.web3.LAMPORTS_PER_SOL,
        "SOL",
      );

      // Execute withdraw - should succeed because start time is not set (scenario 1)
      console.log("Executing withdraw transaction...");
      const withdrawTx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda,
          tokenVault: withdrawTestTokenVaultPda,
          ownerTokenAccount: ownerTokenAccount,
          tokenMint: tokenMint,
          owner: owner.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      console.log("Withdraw transaction signature:", withdrawTx);

      // Get final owner SOL balance
      const finalOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("Final owner SOL balance:", Number(finalOwnerSolBalance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Calculate SOL balance changes
      const solBalanceChange = Number(finalOwnerSolBalance) - Number(beforeWithdrawSolBalance);
      console.log("SOL balance change from withdraw:", solBalanceChange, "lamports");
      console.log("SOL balance change from withdraw:", solBalanceChange / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // The owner should receive rent refunds from both accounts minus transaction fee
      // Transaction fee is typically 5000 lamports
      const expectedTransactionFee = 5000; // 5000 lamports
      const netSolGain = solBalanceChange + expectedTransactionFee;
      console.log("Net SOL gain (rent refunds):", netSolGain, "lamports");
      console.log("Net SOL gain (rent refunds):", netSolGain / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Verify that owner received rent refunds (should be positive after accounting for tx fee)
      expect(netSolGain).to.be.greaterThan(0, "Owner should receive rent refunds from closed accounts");

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
        console.log("✅ Vault account correctly closed:", error.message);
      }

      // Verify distributor account is closed (should fail to fetch)
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda);
        expect.fail("Distributor account should be closed");
      } catch (error) {
        console.log("✅ Distributor account correctly closed:", error.message);
      }

      console.log("✅ Withdraw test completed successfully for nonce", nextnonce, "!");
      console.log("✅ SOL balance verified - owner received rent refunds from both closed accounts!");
    } catch (error) {
      console.error("Withdraw test failed for nonce", nextnonce, ":", error);
      throw error;
    }
  });

  it("Withdraw tokens (Token 2022) - No start time set", async () => {
    // Get next nonce number dynamically (declared outside try-catch for scope)
    const nextnonce = await getNextNonceForOwner(owner.publicKey);

    try {
      console.log("=== Testing withdraw (Token 2022) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      console.log("Next nonce for withdraw test:", nextnonce);

      // Calculate PDA for this nonce
      withdrawTestDistributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, nextnonce);
      withdrawTestTokenVaultPda2022 = calculateVaultPda(withdrawTestDistributorPda2022);

      console.log("Withdraw Test Token 2022 Distributor PDA:", withdrawTestDistributorPda2022.toString());
      console.log("Withdraw Test Token 2022 Vault PDA:", withdrawTestTokenVaultPda2022.toString());

      // Get initial owner SOL balance
      const initialOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("Initial owner SOL balance:", Number(initialOwnerSolBalance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Create distributor for withdraw test
      console.log("Creating distributor for withdraw test (nonce", nextnonce, ")...");
      const createTx = await program.methods
        .createDistributor(totalAmount)
        .accounts({
          ownerNonce: ownerNoncePda,
          distributor: withdrawTestDistributorPda2022,
          tokenVault: withdrawTestTokenVaultPda2022,
          tokenMint: tokenMint2022,
          ownerTokenAccount: ownerTokenAccount2022,
          owner: owner.publicKey,
          operator: operator.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([owner])
        .rpc();

      console.log("Created withdraw test distributor transaction:", createTx);

      // Get SOL balance after creating distributor (should be lower due to rent and tx fees)
      const afterCreateSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log(
        "Owner SOL balance after create:",
        Number(afterCreateSolBalance) / anchor.web3.LAMPORTS_PER_SOL,
        "SOL",
      );

      // Verify initial vault balance
      const initialVaultBalance = await getAccount2022(
        provider.connection,
        withdrawTestTokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      expect(initialVaultBalance.amount.toString()).to.equal(totalAmount.toString());

      // Get initial owner token balance
      const initialOwnerBalance = await getAccount2022(
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

      // Get SOL balance just before withdraw
      const beforeWithdrawSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log(
        "Owner SOL balance before withdraw:",
        Number(beforeWithdrawSolBalance) / anchor.web3.LAMPORTS_PER_SOL,
        "SOL",
      );

      // Execute withdraw - should succeed because start time is not set (scenario 1)
      console.log("Executing withdraw transaction...");
      const withdrawTx = await program.methods
        .withdraw()
        .accounts({
          distributor: withdrawTestDistributorPda2022,
          tokenVault: withdrawTestTokenVaultPda2022,
          ownerTokenAccount: ownerTokenAccount2022,
          tokenMint: tokenMint2022,
          owner: owner.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      console.log("Withdraw transaction signature:", withdrawTx);

      // Get final owner SOL balance
      const finalOwnerSolBalance = await context.banksClient.getBalance(owner.publicKey);
      console.log("Final owner SOL balance:", Number(finalOwnerSolBalance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Calculate SOL balance changes
      const solBalanceChange = Number(finalOwnerSolBalance) - Number(beforeWithdrawSolBalance);
      console.log("SOL balance change from withdraw:", solBalanceChange, "lamports");
      console.log("SOL balance change from withdraw:", solBalanceChange / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // The owner should receive rent refunds from both accounts minus transaction fee
      // Transaction fee is typically 5000 lamports
      const expectedTransactionFee = 5000; // 5000 lamports
      const netSolGain = solBalanceChange + expectedTransactionFee;
      console.log("Net SOL gain (rent refunds):", netSolGain, "lamports");
      console.log("Net SOL gain (rent refunds):", netSolGain / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Verify that owner received rent refunds (should be positive after accounting for tx fee)
      expect(netSolGain).to.be.greaterThan(0, "Owner should receive rent refunds from closed accounts");

      // Verify final owner token balance
      const finalOwnerBalance = await getAccount2022(
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
        await getAccount2022(provider.connection, withdrawTestTokenVaultPda2022, undefined, TOKEN_2022_PROGRAM_ID);
        expect.fail("Vault account should be closed");
      } catch (error) {
        console.log("✅ Vault account correctly closed:", error.message);
      }

      // Verify distributor account is closed (should fail to fetch)
      try {
        await program.account.tokenDistributor.fetch(withdrawTestDistributorPda2022);
        expect.fail("Distributor account should be closed");
      } catch (error) {
        console.log("✅ Distributor account correctly closed:", error.message);
      }

      console.log("✅ Withdraw test completed successfully for nonce", nextnonce, "!");
      console.log("✅ SOL balance verified - owner received rent refunds from both closed accounts!");
    } catch (error) {
      console.error("Withdraw test failed for nonce", nextnonce, ":", error);
      throw error;
    }
  });

  it("Close claim status for SPL Token", async () => {
    try {
      console.log("=== Testing close claim status for SPL Token ===");

      // Use existing owner from global test data for this test (index 2 in testTreeNodes)
      const testClaimant = owner; // owner has 3000 tokens in testTreeNodes[2]
      console.log("Test claimant (owner):", testClaimant.publicKey.toString());

      // Derive claim status PDA
      const [claimStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), distributorPda.toBuffer(), testClaimant.publicKey.toBuffer()],
        program.programId,
      );

      console.log("Claim status PDA:", claimStatusPda.toString());

      // Get claimant's initial SOL balance
      const initialSolBalance = await context.banksClient.getBalance(testClaimant.publicKey);
      console.log("Initial claimant SOL balance:", Number(initialSolBalance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Create token account for claimant
      const testClaimantTokenAccount = await manualCreateAccount(
        provider,
        tokenMint,
        testClaimant.publicKey,
        TOKEN_PROGRAM_ID,
      );

      console.log("Test claimant token account:", testClaimantTokenAccount.publicKey.toString());

      // Time travel to distribution start time first
      const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      const targetTime = distributorAccount.startTime.toNumber();

      await context.setClock(
        new Clock(
          BigInt(0), // slot
          BigInt(targetTime * 1000000), // epoch_start_timestamp (microseconds)
          BigInt(0), // epoch
          BigInt(0), // leader_schedule_epoch
          BigInt(targetTime), // unix_timestamp (seconds)
        ),
      );

      console.log("Time traveled to distribution start time:", targetTime);

      // Execute claim to create the claim status account
      // Use owner (testTreeNodes[2]: 3000 tokens)
      const claimIndex = 2;
      const claimAmount = testTreeNodes[claimIndex].amount;
      const proof = testMerkleTree.getProof(claimIndex);
      const proofArray: number[][] = proof.map((p) => Array.from(p));

      console.log("Executing claim to create claim status account...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda,
          claimantTokenAccount: testClaimantTokenAccount.publicKey,
          tokenMint: tokenMint,
          claimant: testClaimant.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([testClaimant])
        .rpc();

      console.log("Claim transaction signature:", claimTx);

      // Verify claim status account exists
      const claimStatus = await program.account.claimStatus.fetch(claimStatusPda);
      console.log("Claim status created with amount:", claimStatus.claimedAmount.toString());

      // Get SOL balance after claim (before close)
      const beforeCloseSolBalance = await context.banksClient.getBalance(testClaimant.publicKey);
      console.log("SOL balance before close:", Number(beforeCloseSolBalance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Time travel to after distribution end time
      const distributorAccountAfterClaim = await program.account.tokenDistributor.fetch(distributorPda);
      const endTime = distributorAccountAfterClaim.endTime.toNumber();
      const afterEndTime = endTime + 100; // 100 seconds after end time

      await context.setClock(
        new Clock(
          BigInt(0), // slot
          BigInt(afterEndTime * 1000000), // epoch_start_timestamp (microseconds)
          BigInt(0), // epoch
          BigInt(0), // leader_schedule_epoch
          BigInt(afterEndTime), // unix_timestamp (seconds)
        ),
      );

      console.log("Time traveled to after distribution end time:", afterEndTime);

      // Execute close claim status
      console.log("Executing close claim status...");
      const closeTx = await program.methods
        .closeClaimStatus()
        .accounts({
          claimStatus: claimStatusPda,
          claimant: testClaimant.publicKey,
          distributorKey: distributorPda,
        })
        .signers([testClaimant])
        .rpc();

      console.log("Close claim status transaction signature:", closeTx);

      // Get final SOL balance
      const finalSolBalance = await context.banksClient.getBalance(testClaimant.publicKey);
      console.log("Final claimant SOL balance:", Number(finalSolBalance) / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Calculate SOL balance change (should be positive due to rent refund)
      const solBalanceChange = Number(finalSolBalance) - Number(beforeCloseSolBalance);
      console.log("SOL balance change from close:", solBalanceChange, "lamports");
      console.log("SOL balance change from close:", solBalanceChange / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Verify rent was returned (should be positive, accounting for tx fee)
      expect(solBalanceChange).to.be.greaterThan(-10000, "Should receive rent refund minus transaction fee");

      // Verify claim status account is closed (should fail to fetch)
      try {
        await program.account.claimStatus.fetch(claimStatusPda);
        expect.fail("Claim status account should be closed");
      } catch (error) {
        console.log("✅ Claim status account correctly closed:", error.message);
      }

      console.log("✅ Close claim status test completed successfully!");
    } catch (error) {
      console.error("Close claim status test failed:", error);
      throw error;
    }
  });
});
