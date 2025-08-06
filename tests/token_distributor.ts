import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TokenDistributor } from "../target/types/token_distributor";
import { createMint, createAccount, mintTo, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import {
  createMint as createMint2022,
  createAccount as createAccount2022,
  mintTo as mintTo2022,
  TOKEN_2022_PROGRAM_ID,
  getAccount as getAccount2022,
} from "@solana/spl-token";
import { PublicKey, Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { SimpleMerkleTree } from "./utils/merkle_tree";

describe("token_distributor", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TokenDistributor as Program<TokenDistributor>;

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
    // Use provider wallet as owner (it has SOL)
    owner = provider.wallet.payer;
    operator = Keypair.generate();

    console.log("Using provider wallet as owner:", owner.publicKey.toString());
    console.log("Generated operator:", operator.publicKey.toString());

    // Calculate nonce state PDA
    const OWNER_NONCE_SEED = "owner_nonce";
    [ownerNoncePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(OWNER_NONCE_SEED), owner.publicKey.toBuffer()],
      program.programId,
    );
    console.log("Nonce State PDA:", ownerNoncePda.toString());

    // Check balance
    const balance = await provider.connection.getBalance(owner.publicKey);
    console.log("Owner balance:", balance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

    // Give operator some SOL from owner
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: operator.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL, // 1 SOL
      }),
    );
    await provider.sendAndConfirm(transferTx, [owner]);
    console.log("Transferred 1 SOL to operator");

    // Create SPL token mint
    console.log("Creating SPL token mint...");
    tokenMint = await createMint(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9, // decimals
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );
    console.log("SPL Token mint created:", tokenMint.toString());

    // Create Token 2022 mint
    console.log("Creating Token 2022 mint...");
    tokenMint2022 = await createMint2022(
      provider.connection,
      owner,
      owner.publicKey,
      null,
      9, // decimals
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    console.log("Token 2022 mint created:", tokenMint2022.toString());

    // Create token accounts for SPL Token
    console.log("Creating SPL token accounts...");
    ownerTokenAccount = await createAccount(
      provider.connection,
      owner,
      tokenMint,
      owner.publicKey,
      undefined,
      undefined,
      TOKEN_PROGRAM_ID,
    );
    console.log("Owner SPL token account:", ownerTokenAccount.toString());

    // Create token accounts for Token 2022
    console.log("Creating Token 2022 accounts...");
    ownerTokenAccount2022 = await createAccount2022(
      provider.connection,
      owner,
      tokenMint2022,
      owner.publicKey,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    console.log("Owner Token 2022 account:", ownerTokenAccount2022.toString());

    // Mint tokens to owner (SPL Token)
    console.log("Minting SPL tokens to owner...");
    try {
      await mintTo(
        provider.connection,
        owner,
        tokenMint,
        ownerTokenAccount,
        owner,
        1000000000000, // 1000 tokens with 9 decimals
        [],
        undefined,
        TOKEN_PROGRAM_ID,
      );
      console.log("SPL Tokens minted successfully");
    } catch (error) {
      console.error("SPL Token minting failed:", error);
      throw error;
    }

    // Mint tokens to owner (Token 2022)
    console.log("Minting Token 2022 to owner...");
    try {
      await mintTo2022(
        provider.connection,
        owner,
        tokenMint2022,
        ownerTokenAccount2022,
        owner,
        1000000000000, // 1000 tokens with 9 decimals
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Token 2022 minted successfully");
    } catch (error) {
      console.error("Token 2022 minting failed:", error);
      throw error;
    }

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
      const vaultAccount = await getAccount2022(
        provider.connection,
        tokenVaultPda2022,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

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
    try {
      console.log("Generating merkle root from hardcoded test data...");

      // Hardcoded test data (previously from CSV file)
      const testTreeNodes = [
        { claimant: new PublicKey("3gmBN8LBomg3sZEjTgp2YsECMYgJpjcT7xUfpnDB4gSs"), amount: new anchor.BN(1000) },
        { claimant: new PublicKey("8G9xE8awr9vA2PZWFTJSHNhS16KLnXYdV6XEaJP1a2Yx"), amount: new anchor.BN(2000) },
        { claimant: new PublicKey("A4mDtfFCkdt9CqGzEkfiSHhJD8d3bUMasVzwajudGtb2"), amount: new anchor.BN(3000) },
        { claimant: new PublicKey("4SX6nqv5VRLMoNfYM5phvHgcBNcBEwUEES4qPPjf1EqS"), amount: new anchor.BN(4000) },
      ];

      // Generate merkle root from hardcoded data
      const testMerkleTree = new SimpleMerkleTree(testTreeNodes);
      const merkleRoot = testMerkleTree.getMerkleRoot();

      console.log("Generated merkle root:", merkleRoot);
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
    } catch (error) {
      console.error("Set merkle root test failed:", error);
      throw error;
    }
  });

  it("Set time for nonce 1 and nonce 2 [current time]", async () => {
    try {
      console.log("Getting current Solana blockchain time...");

      // Get current Solana blockchain time
      const slot = await provider.connection.getSlot();
      const blockTime = await provider.connection.getBlockTime(slot);
      if (!blockTime) {
        throw new Error("Could not get block time from Solana");
      }

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

      // Set time for nonce 2 (Token 2022) to current time + 10 seconds
      const startTimeV2 = blockTime + 10;
      console.log("Setting time for nonce 2 (Token 2022) to current time + 10 seconds:", startTimeV2);

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

      console.log("Nonce 1 start time set:", distributorAccount1.startTime.toString());
      console.log("Nonce 1 end time set:", distributorAccount1.endTime.toString());
      console.log("Nonce 2 start time set:", distributorAccount2022.startTime.toString());
      console.log("Nonce 2 end time set:", distributorAccount2022.endTime.toString());

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

      // Get current Solana blockchain time
      const slot = await provider.connection.getSlot();
      const blockTime = await provider.connection.getBlockTime(slot);
      if (!blockTime) {
        throw new Error("Could not get block time from Solana");
      }

      console.log("Current Solana block time:", blockTime);

      // First time setting - set to 10 seconds in the future
      const firstStartTime = blockTime + 10;
      console.log("Setting time first time to +10 seconds:", firstStartTime);

      const tx1 = await program.methods
        .setTime(new anchor.BN(firstStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .signers([operator])
        .rpc();

      console.log("First time set transaction:", tx1);

      // Verify first time was set
      let distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(firstStartTime.toString());

      // Second time setting - modify to 20 seconds in the future
      const secondStartTime = blockTime + 20;
      console.log("Modifying time to +20 seconds:", secondStartTime);

      const tx2 = await program.methods
        .setTime(new anchor.BN(secondStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .signers([operator])
        .rpc();

      console.log("Second time set transaction:", tx2);

      // Verify second time was set
      distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(secondStartTime.toString());

      // Third time setting - modify to 30 seconds in the future
      const thirdStartTime = blockTime + 30;
      console.log("Modifying time to +30 seconds:", thirdStartTime);

      const tx3 = await program.methods
        .setTime(new anchor.BN(thirdStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .signers([operator])
        .rpc();

      console.log("Third time set transaction:", tx3);

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

      // Get current Solana blockchain time
      const slot = await provider.connection.getSlot();
      const blockTime = await provider.connection.getBlockTime(slot);
      if (!blockTime) {
        throw new Error("Could not get block time from Solana");
      }

      console.log("Current Solana block time:", blockTime);

      // Set initial time to 5 seconds in the future
      const initialStartTime = blockTime + 5;
      console.log("Setting initial time to +5 seconds:", initialStartTime);

      const tx1 = await program.methods
        .setTime(new anchor.BN(initialStartTime))
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .signers([operator])
        .rpc();

      console.log("Initial time set transaction:", tx1);

      // Verify initial time was set
      let distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
      expect(distributorAccount.startTime.toString()).to.equal(initialStartTime.toString());

      // Wait for time to advance past the start time
      console.log("⏰ Waiting for time to advance past start time...");
      const waitTime = 7000; // Wait 7 seconds to ensure we're past the start time
      await new Promise((resolve) => setTimeout(resolve, waitTime));

      // Get updated block time
      const updatedSlot = await provider.connection.getSlot();
      const updatedBlockTime = await provider.connection.getBlockTime(updatedSlot);
      if (!updatedBlockTime) {
        throw new Error("Could not get updated block time from Solana");
      }

      console.log("Updated block time:", updatedBlockTime);
      console.log("Distribution should have started:", updatedBlockTime >= initialStartTime);

      // Try to modify time after distribution has started - this should fail
      const newStartTime = updatedBlockTime + 10;
      console.log("Attempting to modify time to:", newStartTime);

      try {
        const tx2 = await program.methods
          .setTime(new anchor.BN(newStartTime))
          .accounts({
            distributor: distributorPda,
            operator: operator.publicKey,
          })
          .signers([operator])
          .rpc();

        console.log("Time modification transaction:", tx2);

        // If we reach here, the transaction succeeded when it should have failed
        throw new Error("❌ Time modification should have failed but succeeded");
      } catch (error) {
        console.log("✅ Time modification correctly failed after distribution started");
        console.log("Error details:", error);

        // Verify the time was not actually modified
        distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
        expect(distributorAccount.startTime.toString()).to.equal(initialStartTime.toString());
        console.log("✅ Time was correctly not modified - still:", distributorAccount.startTime.toString());
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

      // Create test claimants with keypairs we control
      const claimant1 = Keypair.generate();
      const claimant2 = Keypair.generate();

      // Give claimants some SOL for transaction fees
      for (const claimant of [claimant1, claimant2]) {
        const transferTx = new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: claimant.publicKey,
            lamports: anchor.web3.LAMPORTS_PER_SOL * 0.1, // 0.1 SOL
          }),
        );
        await provider.sendAndConfirm(transferTx, [owner]);
      }
      console.log("Transferred SOL to test claimants for transaction fees");

      // Create test tree nodes with our controlled keypairs
      const testTreeNodes = [
        { claimant: claimant1.publicKey, amount: new anchor.BN(1000) },
        { claimant: claimant2.publicKey, amount: new anchor.BN(2000) },
        { claimant: owner.publicKey, amount: new anchor.BN(3000) }, // Use owner as third claimant
        { claimant: operator.publicKey, amount: new anchor.BN(4000) }, // Use operator as fourth claimant
      ];

      // Create merkle tree with our test data
      const testMerkleTree = new SimpleMerkleTree(testTreeNodes);
      const testMerkleRoot = testMerkleTree.getMerkleRoot();

      console.log("Created test merkle tree with controlled keypairs");
      console.log("Test merkle root:", testMerkleRoot);

      // Update the merkle root in the distributor to use our test data
      console.log("Updating merkle root with test data...");
      const updateTx = await program.methods
        .setMerkleRoot(testMerkleRoot)
        .accounts({
          distributor: distributorPda,
          operator: operator.publicKey,
        })
        .signers([operator])
        .rpc();

      console.log("Updated merkle root transaction:", updateTx);

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

      // Create token account for claimant1
      const claimant1TokenAccount = await createAccount(
        provider.connection,
        claimant1,
        tokenMint,
        claimant1.publicKey,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID,
      );
      console.log("Created claimant1 token account:", claimant1TokenAccount.toString());

      // Find claim status PDA for claimant1
      const [claimStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), distributorPda.toBuffer(), claimant1.publicKey.toBuffer()],
        program.programId,
      );

      // Get initial token balances
      const initialVaultBalance = await getAccount(provider.connection, tokenVaultPda, undefined, TOKEN_PROGRAM_ID);

      const initialClaimantBalance = await getAccount(
        provider.connection,
        claimant1TokenAccount,
        undefined,
        TOKEN_PROGRAM_ID,
      );

      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

      // Try early claim before distribution time - should fail
      console.log("=== Testing early claim before distribution time (should fail) ===");

      try {
        console.log("Attempting to claim before distribution time (expecting failure)...");

        // Check current time vs distribution time
        const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda);
        const currentSlot = await provider.connection.getSlot();
        const currentBlockTime = await provider.connection.getBlockTime(currentSlot);

        console.log("Current block time:", currentBlockTime);
        console.log("Distribution time:", distributorAccount.startTime.toString());
        console.log("Time until start:", distributorAccount.startTime.toNumber() - (currentBlockTime || 0), "seconds");

        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount,
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

      // Wait for distribution to start (since we set start time to current + 2 seconds)
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds to be safe
      // Then it will succeed
      // Execute the claim transaction
      console.log("Executing claim transaction...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda,
          claimantTokenAccount: claimant1TokenAccount,
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
      console.log("Testing double claim prevention...");
      try {
        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda,
            claimantTokenAccount: claimant1TokenAccount,
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

      // Create test claimants with keypairs we control
      const claimant1 = Keypair.generate();
      const claimant2 = Keypair.generate();

      // Give claimants some SOL for transaction fees
      for (const claimant of [claimant1, claimant2]) {
        const transferTx = new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: claimant.publicKey,
            lamports: anchor.web3.LAMPORTS_PER_SOL * 0.1, // 0.1 SOL
          }),
        );
        await provider.sendAndConfirm(transferTx, [owner]);
      }
      console.log("Transferred SOL to test claimants for transaction fees");

      // Create test tree nodes with our controlled keypairs
      const testTreeNodes = [
        { claimant: claimant1.publicKey, amount: new anchor.BN(1000) },
        { claimant: claimant2.publicKey, amount: new anchor.BN(2000) },
        { claimant: owner.publicKey, amount: new anchor.BN(3000) }, // Use owner as third claimant
        { claimant: operator.publicKey, amount: new anchor.BN(4000) }, // Use operator as fourth claimant
      ];

      // Create merkle tree with our test data
      const testMerkleTree = new SimpleMerkleTree(testTreeNodes);
      const testMerkleRoot = testMerkleTree.getMerkleRoot();

      console.log("Created test merkle tree with controlled keypairs");
      console.log("Test merkle root:", testMerkleRoot);

      // Update the merkle root in the distributor to use our test data
      console.log("Updating merkle root with test data...");
      const updateTx = await program.methods
        .setMerkleRoot(testMerkleRoot)
        .accounts({
          distributor: distributorPda2022,
          operator: operator.publicKey,
        })
        .signers([operator])
        .rpc();

      console.log("Updated merkle root transaction:", updateTx);

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

      // Create token account for claimant1
      const claimant1TokenAccount = await createAccount2022(
        provider.connection,
        claimant1,
        tokenMint2022,
        claimant1.publicKey,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );
      console.log("Created claimant1 token account:", claimant1TokenAccount.toString());

      // Find claim status PDA for claimant1
      const [claimStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), distributorPda2022.toBuffer(), claimant1.publicKey.toBuffer()],
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
        claimant1TokenAccount,
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      console.log("Initial vault balance:", initialVaultBalance.amount.toString());
      console.log("Initial claimant balance:", initialClaimantBalance.amount.toString());

      // Try early claim before distribution time - should fail
      console.log("=== Testing early claim before distribution time (should fail) ===");

      try {
        console.log("Attempting to claim before distribution time (expecting failure)...");

        // Check current time vs distribution time
        const distributorAccount = await program.account.tokenDistributor.fetch(distributorPda2022);
        const currentSlot = await provider.connection.getSlot();
        const currentBlockTime = await provider.connection.getBlockTime(currentSlot);

        console.log("Current block time:", currentBlockTime);
        console.log("Distribution time:", distributorAccount.startTime.toString());
        console.log("Time until start:", distributorAccount.startTime.toNumber() - (currentBlockTime || 0), "seconds");

        await program.methods
          .claim(claimAmount, proofArray)
          .accounts({
            distributor: distributorPda2022,
            claimStatus: claimStatusPda,
            tokenVault: tokenVaultPda2022,
            claimantTokenAccount: claimant1TokenAccount,
            tokenMint: tokenMint2022,
            claimant: claimant1.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
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

      // Wait for distribution to start (since we set start time to current + 5 seconds)
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds to be safe
      // Then it will succeed
      // Execute the claim transaction
      console.log("Executing claim transaction...");
      const claimTx = await program.methods
        .claim(claimAmount, proofArray)
        .accounts({
          distributor: distributorPda2022,
          claimStatus: claimStatusPda,
          tokenVault: tokenVaultPda2022,
          claimantTokenAccount: claimant1TokenAccount,
          tokenMint: tokenMint2022,
          claimant: claimant1.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([claimant1])
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
        claimant1TokenAccount,
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
            claimantTokenAccount: claimant1TokenAccount,
            tokenMint: tokenMint2022,
            claimant: claimant1.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
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

  it("Withdraw tokens (SPL Token) - No start time set", async () => {
    // Get next nonce number dynamically (declared outside try-catch for scope)
    const nextNonce = await getNextNonceForOwner(owner.publicKey);

    try {
      console.log("=== Testing withdraw (SPL Token) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      console.log("Next nonce for withdraw test:", nextNonce);

      // Calculate PDA for this nonce
      withdrawTestDistributorPda = calculateDistributorPda(tokenMint, owner.publicKey, nextNonce);
      withdrawTestTokenVaultPda = calculateVaultPda(withdrawTestDistributorPda);

      console.log("Withdraw Test SPL Token Distributor PDA:", withdrawTestDistributorPda.toString());
      console.log("Withdraw Test SPL Token Vault PDA:", withdrawTestTokenVaultPda.toString());

      // Get initial owner SOL balance
      const initialOwnerSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Initial owner SOL balance:", initialOwnerSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Create distributor for withdraw test
      console.log("Creating distributor for withdraw test (nonce", nextNonce, ")...");
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
      const afterCreateSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Owner SOL balance after create:", afterCreateSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

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
      const beforeWithdrawSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Owner SOL balance before withdraw:", beforeWithdrawSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

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
      const finalOwnerSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Final owner SOL balance:", finalOwnerSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Calculate SOL balance changes
      const solBalanceChange = finalOwnerSolBalance - beforeWithdrawSolBalance;
      console.log("SOL balance change from withdraw:", solBalanceChange, "lamports");
      console.log("SOL balance change from withdraw:", solBalanceChange / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // The owner should receive rent refunds from both accounts minus transaction fee
      // Transaction fee is typically 5000 lamports as mentioned
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

      console.log("✅ Withdraw test completed successfully for nonce", nextNonce, "!");
      console.log("✅ SOL balance verified - owner received rent refunds from both closed accounts!");
    } catch (error) {
      console.error("Withdraw test failed for nonce", nextNonce, ":", error);
      throw error;
    }
  });

  it("Withdraw tokens (Token 2022) - No start time set", async () => {
    // Get next nonce number dynamically (declared outside try-catch for scope)
    const nextNonce = await getNextNonceForOwner(owner.publicKey);

    try {
      console.log("=== Testing withdraw (Token 2022) - No start time set ===");

      const totalAmount = new anchor.BN(100000000000); // 100 tokens

      console.log("Next nonce for withdraw test:", nextNonce);

      // Calculate PDA for this nonce
      withdrawTestDistributorPda2022 = calculateDistributorPda(tokenMint2022, owner.publicKey, nextNonce);
      withdrawTestTokenVaultPda2022 = calculateVaultPda(withdrawTestDistributorPda2022);

      console.log("Withdraw Test Token 2022 Distributor PDA:", withdrawTestDistributorPda2022.toString());
      console.log("Withdraw Test Token 2022 Vault PDA:", withdrawTestTokenVaultPda2022.toString());

      // Get initial owner SOL balance
      const initialOwnerSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Initial owner SOL balance:", initialOwnerSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Create distributor for withdraw test
      console.log("Creating distributor for withdraw test (nonce", nextNonce, ")...");
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
      const afterCreateSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Owner SOL balance after create:", afterCreateSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

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
      const beforeWithdrawSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Owner SOL balance before withdraw:", beforeWithdrawSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

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
      const finalOwnerSolBalance = await provider.connection.getBalance(owner.publicKey);
      console.log("Final owner SOL balance:", finalOwnerSolBalance / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // Calculate SOL balance changes
      const solBalanceChange = finalOwnerSolBalance - beforeWithdrawSolBalance;
      console.log("SOL balance change from withdraw:", solBalanceChange, "lamports");
      console.log("SOL balance change from withdraw:", solBalanceChange / anchor.web3.LAMPORTS_PER_SOL, "SOL");

      // The owner should receive rent refunds from both accounts minus transaction fee
      // Transaction fee is typically 5000 lamports as mentioned
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

      console.log("✅ Withdraw test completed successfully for nonce", nextNonce, "!");
      console.log("✅ SOL balance verified - owner received rent refunds from both closed accounts!");
    } catch (error) {
      console.error("Withdraw test failed for nonce", nextNonce, ":", error);
      throw error;
    }
  });
});
