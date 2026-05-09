use anchor_lang::prelude::*;
use crate::state::*;
use crate::error::*;
use crate::event::*;
use crate::constants::*;

/**
 * Account context for closing claim status accounts
 * 
 * This instruction allows users to close their ClaimStatus accounts after
 * the distribution has ended to reclaim the rent paid during account creation.
 * 
 * Access Control: Only the original claimant can close their ClaimStatus account
 * 
 */
#[event_cpi]
#[derive(Accounts)]
pub struct CloseClaimStatus<'info> {
    /// ClaimStatus account to be closed, rent returned to claimant
    /// - Must be a valid existing ClaimStatus account
    /// - Derived from: ["claim", distributor_key, claimant_key]
    /// - Will be closed and rent returned to claimant
    #[account(
        mut,
        close = claimant,
        seeds = [CLAIM_SEED.as_bytes(), distributor_key.key().as_ref(), claimant.key().as_ref()],
        bump 
    )]
    pub claim_status: Account<'info, ClaimStatus>,
    
    /// The claimant who originally created the ClaimStatus account
    /// - Must be the same claimant who paid for the account creation
    /// - Will receive the reclaimed rent
    #[account(mut)]
    pub claimant: Signer<'info>,
    
    /// Distributor account used for PDA derivation and time validation
    /// CHECK: Either closed or valid TokenDistributor
    pub distributor_key: AccountInfo<'info>,
}

/**
 * Closes a ClaimStatus account and returns rent to the claimant
 *
 * @param ctx - The account context containing the ClaimStatus and claimant accounts
 * 
 * Validation Process:
 * 1. Check that distribution has ended using stored end_time
 * 2. Anchor automatically transfers lamports and closes account
 */
pub fn handle_close_claim_status(ctx: Context<CloseClaimStatus>) -> Result<()> {
    let distributor_key = &ctx.accounts.distributor_key;
    
    // Only validate if distributor account still exists
    if distributor_key.data_len() != 0 {
        // Explicitly verify the distributor account is owned by this program
        require!(
            distributor_key.owner == &crate::ID,
            TokenDistributorError::DistributorNotOwnedByProgram
        );
        
        // Deserialize distributor data to access end_time
        let distributor_data = distributor_key.try_borrow_data()?;
        let distributor = TokenDistributor::try_deserialize(&mut distributor_data.as_ref())?;
        
        // Check if distribution has ended
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            current_time > distributor.end_time,
            TokenDistributorError::DistributionNotEnded
        );
    }
    
    // Emit event for off-chain indexing and monitoring
    emit_cpi!(ClaimStatusClosed {
        distributor: ctx.accounts.distributor_key.key(),
        claimant: ctx.accounts.claimant.key(),
        claimed_amount: ctx.accounts.claim_status.claimed_amount,
    });
    
    Ok(())
}