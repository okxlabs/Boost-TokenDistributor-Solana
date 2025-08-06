use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenInterface, TokenAccount};
use crate::state::*;
use crate::error::*;
use crate::constants::*;
use crate::utils::{transfer_token, close_token_account_with_pda};
use crate::event::*;

/**
 * Account context for withdrawing remaining tokens
 * 
 * This instruction allows the distributor owner to withdraw any remaining tokens
 * from the vault. This serves as a cleanup mechanism to recover undistributed tokens.
 * 
 * Access Control: Only the owner can withdraw remaining tokens
 * 
 * Business Logic:
 * - Can be called in two scenarios:
 *   1. After the distribution period has ended (current_time > end_time)
 *   2. If distribution time was never set (start_time = 0, end_time = 0)
 * - Withdraws all remaining tokens from the vault
 * - Closes the token vault account to reclaim rent
 * - Closes the distributor account to reclaim rent
 */
#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// The distributor account to withdraw from and close
    /// - Must be a valid existing distributor PDA
    /// - Will be closed and rent returned to owner
    #[account(
        mut,
        close = owner
    )]
    pub distributor: Account<'info, TokenDistributor>,
    
    /// Token vault containing the remaining tokens
    /// - Controlled by the distributor PDA
    /// - Derived from: ["vault", distributor_key]
    /// - Will be emptied and closed
    #[account(
        mut,
        seeds = [VAULT_SEED.as_bytes(), distributor.key().as_ref()],
        bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,
    
    /// Owner's token account to receive the remaining tokens
    /// - Must be owned by the owner
    /// - Must be for the correct token mint
    /// - Will be credited with all remaining tokens
    #[account(
        mut,
        token::mint = distributor.token_mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub owner_token_account: InterfaceAccount<'info, TokenAccount>,
    
    /// The token mint for verification
    /// - Must match the distributor's token mint
    /// - Used for transfer_checked validation
    #[account(
        token::token_program = token_program,
        constraint = token_mint.key() == distributor.token_mint @ TokenDistributorError::TokenMintMismatch
    )]
    pub token_mint: InterfaceAccount<'info, anchor_spl::token_interface::Mint>,
    
    /// The owner of the distributor
    /// - Must match the owner stored in the distributor state
    /// - Only this account can call this instruction
    /// - Receives the remaining tokens and reclaimed rent
    #[account(
        mut,
        constraint = owner.key() == distributor.owner @ TokenDistributorError::OnlyOwner
    )]
    pub owner: Signer<'info>,
    
    /// Token program (supports both SPL Token and Token 2022)
    pub token_program: Interface<'info, TokenInterface>,
}

/**
 * Withdraws remaining tokens from the distributor
 * 
 * @param ctx - The account context containing all required accounts
 * 
 * @returns Result<()> - Success or error
 * 
 * Validation Rules:
 * - Distribution must have ended or never been started
 * - Only the owner can call this function
 */
pub fn handle_withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let distributor = &ctx.accounts.distributor;
    
    // ===== VALIDATION PHASE =====
    
    // Ensure distribution has ended or was never started before allowing withdrawal
    let current_time = Clock::get()?.unix_timestamp;
    require!(current_time > distributor.end_time, TokenDistributorError::DistributionNotEnded);
    
    // Get remaining balance for potential transfer and event emission
    let remaining_balance = ctx.accounts.token_vault.amount;
    
    // ===== INTERACTIONS PHASE (Token Transfer and Cleanup) =====
    
    // Prepare PDA signing seeds for token operations
    let nonce_bytes = distributor.nonce.to_le_bytes();
    let seeds = &[
        DISTRIBUTOR_SEED.as_bytes(),
        distributor.token_mint.as_ref(),
        distributor.owner.as_ref(),
        nonce_bytes.as_ref(),
        &[distributor.bump],
    ];
    let signer = &[&seeds[..]];
    
    // Transfer remaining tokens only if there are any
    if remaining_balance > 0 {
        // Compatibility with both SPL Token and Token 2022
        transfer_token(
            ctx.accounts.distributor.to_account_info(),
            ctx.accounts.token_vault.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.token_mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            remaining_balance,
            ctx.accounts.token_mint.decimals,
            Some(signer),  // PDA signing for secure transfer
        )?;
    }
    
    // Close the token vault account to reclaim rent
    // This returns the rent to the owner and cleans up the account
    close_token_account_with_pda(
        ctx.accounts.token_vault.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.distributor.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        signer,  // PDA signing for secure closure
    )?;
    
    // Emit event for off-chain indexing and monitoring
    emit_cpi!(TokensWithdrawn {
        distributor: distributor.key(),
        owner: ctx.accounts.owner.key(),
        amount_withdrawn: remaining_balance,
    });
    
    // Note: The distributor account will be automatically closed due to the
    // close = owner constraint in the account definition, returning rent to owner
    Ok(())
} 