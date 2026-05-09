use anchor_lang::prelude::*;
use crate::state::*;
use crate::error::*;
use crate::constants::*;
use crate::event::*;

/**
 * Account context for setting the distribution time
 * 
 * This instruction allows the designated operator to set when the token distribution
 * will begin and automatically calculates the end time based on the DURATION constant.
 * 
 * Access Control: Only the operator can set the time
 * 
 * Business Logic:
 * - Time can be modified multiple times before distribution starts
 * - Once distribution starts, time cannot be modified anymore
 * - Time must be in the future (prevents backdating)
 * - Each modification limited to max 90 days from current time (prevents setting times too far ahead in single operation)
 * - End time is automatically calculated as time + DURATION
 */
#[event_cpi]
#[derive(Accounts)]
pub struct SetTime<'info> {
    /// The distributor account to update
    /// - Must be a valid existing distributor PDA
    /// - Will be modified to set start_time and end_time
    #[account(mut)]
    pub distributor: Account<'info, TokenDistributor>,
    
    /// The operator who can set the time
    /// - Must match the operator stored in the distributor state
    /// - Only this account can call this instruction
    #[account(constraint = operator.key() == distributor.operator @ TokenDistributorError::OnlyOperator)]
    pub operator: Signer<'info>,
}

/**
 * Sets the time for the token distribution
 * 
 * @param ctx - The account context containing distributor and operator accounts
 * @param start_time - Unix timestamp when distribution should begin
 * 
 */
pub fn handle_set_time(
    ctx: Context<SetTime>,
    start_time: i64,
) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;
    
    // Validate timing constraints
    let current_time = Clock::get()?.unix_timestamp;
    
    // Check if distribution has already started - if so, cannot modify time
    if distributor.start_time > 0 && current_time >= distributor.start_time {
        return err!(TokenDistributorError::DistributionAlreadyStarted);
    }
    
    // Time must be in the future to prevent backdating
    require!(start_time > current_time, TokenDistributorError::InvalidStartTime);
    
    // Time cannot be too far in the future (MAX_START_TIME = 90 days)
    require!(start_time <= current_time + MAX_START_TIME, TokenDistributorError::StartTimeTooFar);
    
    // Set the distribution period
    distributor.start_time = start_time;
    distributor.end_time = start_time + DURATION;  // DURATION = 14 days
    
    // Emit event for off-chain indexing and monitoring
    emit_cpi!(StartTimeSet {
        distributor: distributor.key(),
        operator: ctx.accounts.operator.key(),
        start_time,
        end_time: distributor.end_time,
    });

    Ok(())
} 