use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenInterface, TokenAccount};
use crate::state::*;
use crate::error::*;
use crate::utils::verify;
use crate::constants::*;
use crate::utils::transfer_token;
use crate::event::*;

/**
 * Account context for claiming tokens
 * 
 * This instruction allows eligible users to claim their allocated tokens by providing
 * a valid merkle proof. The instruction verifies the proof, updates claim status,
 * and transfers tokens from the vault to the claimant.
 * 
 * Access Control: Any user with a valid merkle proof can claim their tokens
 * 
 */
#[event_cpi]
#[derive(Accounts)]
pub struct Claim<'info> {
    /// The distributor account containing distribution parameters
    /// - Must be a valid existing distributor PDA
    /// - Will be modified to update total_claimed amount
    #[account(mut)]
    pub distributor: Account<'info, TokenDistributor>,
    
    /// Individual claim status for this claimant
    /// - Tracks how much this user has already claimed
    /// - Derived from: ["claim", distributor_key, claimant_key]
    #[account(
        init_if_needed,
        payer = claimant,
        space = ClaimStatus::LEN,
        seeds = [CLAIM_SEED.as_bytes(), distributor.key().as_ref(), claimant.key().as_ref()],
        bump
    )]
    pub claim_status: Account<'info, ClaimStatus>,
    
    /// Token vault holding the tokens to be distributed
    /// - Controlled by the distributor PDA
    /// - Derived from: ["vault", distributor_key]
    #[account(
        mut,
        seeds = [VAULT_SEED.as_bytes(), distributor.key().as_ref()],
        bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    
    /// Claimant's token account to receive the tokens
    /// - Must be owned by the claimant
    /// - Must be for the correct token mint
    #[account(
        mut,
        token::mint = distributor.token_mint,
        token::authority = claimant,
        token::token_program = token_program,
    )]
    pub claimant_token_account: InterfaceAccount<'info, TokenAccount>,
    
    /// The token mint for verification
    /// - Must match the distributor's token mint
    #[account(
        token::token_program = token_program,
        constraint = token_mint.key() == distributor.token_mint @ TokenDistributorError::TokenMintMismatch
    )]
    pub token_mint: InterfaceAccount<'info, anchor_spl::token_interface::Mint>,
    
    /// The claimant attempting to claim tokens
    /// - Must sign the transaction
    /// - Must have a valid merkle proof for the claim
    #[account(mut)]
    pub claimant: Signer<'info>,
    
    /// System program for account creation
    pub system_program: Program<'info, System>,
    
    /// Token program (supports both SPL Token and Token 2022)
    pub token_program: Interface<'info, TokenInterface>,
}

/**
 * Processes a token claim with merkle proof verification
 * 
 * @param ctx - The account context containing all required accounts
 * @param max_amount - Maximum amount this user is eligible to claim (from merkle tree)
 * @param proof - Array of 32-byte hashes forming the merkle proof path
 * 
 * Validation Process:
 * 1. Verify merkle root is set and distribution is active
 * 2. Check that current time is within distribution window
 * 3. Verify merkle proof for (claimant, max_amount) pair
 * 4. Calculate and transfer pending amount
 */
pub fn handle_claim(
    ctx: Context<Claim>,
    max_amount: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;
    let claim_status = &mut ctx.accounts.claim_status;
    
    // ===== VALIDATION PHASE =====
    
    // Ensure merkle root has been set (required for claim verification)
    require!(distributor.merkle_root != [0; 32], TokenDistributorError::NoMerkleRoot);
    
    // Verify distribution is active (within time window)
    let current_time = Clock::get()?.unix_timestamp;
    // Check if start time has been set
    require!(distributor.start_time > 0, TokenDistributorError::StartTimeNotSet);
    
    // Check if distribution time is within the window
    require!(current_time >= distributor.start_time, TokenDistributorError::DistributionNotStarted);
    require!(current_time <= distributor.end_time, TokenDistributorError::DistributionEnded);
    
    // Check if user can still claim more tokens
    let claimed_amount = claim_status.claimed_amount;
    require!(max_amount > claimed_amount, TokenDistributorError::InvalidAmount);
    
    // ===== MERKLE PROOF VERIFICATION =====
    
    let claimant_account = &ctx.accounts.claimant;
    
    // Create the leaf node hash (claimant_pubkey + max_amount)
    // This represents the user's entry in the merkle tree
    let leaf: anchor_lang::solana_program::hash::Hash = anchor_lang::solana_program::hash::hashv(&[
        &claimant_account.key().to_bytes(),
        &max_amount.to_le_bytes(),
    ]);
    
    // Verify the merkle proof
    // This ensures the user is eligible for the claimed amount
    require!(
        verify(proof, distributor.merkle_root, leaf.to_bytes()),
        TokenDistributorError::InvalidProof
    );
    
    // ===== EFFECTS PHASE (State Updates) =====
    
    // Calculate the amount to transfer (incremental claiming)
    let pending_amount = max_amount - claimed_amount;
    
    // Check vault has sufficient balance before proceeding
    require!(
        ctx.accounts.token_vault.amount >= pending_amount,
        TokenDistributorError::InsufficientVaultBalance
    );
    
    // Prepare other immutable references
    let nonce_bytes = distributor.nonce.to_le_bytes();
    let token_mint_key = distributor.token_mint;
    let owner_key = distributor.owner;
    let distributor_bump = distributor.bump;
    let distributor_key = distributor.key();
    
    // Update claim status (CEI pattern - effects before interactions)
    claim_status.claimed_amount = max_amount;  // Set to full amount (cumulative)
    
    // Calculate new total claimed amount with overflow protection
    let new_total_claimed = distributor.total_claimed
        .checked_add(pending_amount)
        .ok_or(TokenDistributorError::ArithmeticOverflow)?;
    
    // Update distributor's total claimed amount
    distributor.total_claimed = new_total_claimed;
    
    // ===== INTERACTIONS PHASE (Token Transfer) =====
    
    // Prepare PDA signing seeds for token transfer
    let seeds = &[
        DISTRIBUTOR_SEED.as_bytes(),
        token_mint_key.as_ref(),
        owner_key.as_ref(),
        nonce_bytes.as_ref(),
        &[distributor_bump],
    ];
    let signer = &[&seeds[..]];

    // Transfer tokens from vault to claimant using PDA authority
    transfer_token(
        ctx.accounts.distributor.to_account_info(),  // Delayed AccountInfo acquisition
        ctx.accounts.token_vault.to_account_info(),
        ctx.accounts.claimant_token_account.to_account_info(),
        ctx.accounts.token_mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        pending_amount,
        ctx.accounts.token_mint.decimals,
        Some(signer),  // PDA signing for secure transfer
    )?;
    
    // Emit event for off-chain indexing and monitoring
    emit_cpi!(TokensClaimed {
        distributor: distributor_key,
        claimant: ctx.accounts.claimant.key(),
        user_amount_claimed: pending_amount,        // Amount claimed by user in this transaction
        user_max_amount: max_amount,               // Maximum amount the user is eligible to claim
        total_claimed: new_total_claimed,          // Total amount claimed from the distributor by all users
    });
    
    Ok(())
} 