use anchor_lang::prelude::*;

/**
 * Individual claim status account
 * 
 * This struct tracks the claim progress for each individual user in a distribution.
 * Supports single claim (when root set once) or incremental distributions
 * by adjusting maxAmount without resetting previous claims.
 * 
 * Derivation: ["claim", distributor_key, claimant_key]
 * 
 * Lifecycle:
 * 1. Created on first claim (using init_if_needed)
 * 2. Updated with each subsequent claim
 * 3. Can be closed after distribution ends for rent reclamation
 * 
 * Design Notes:
 * - One ClaimStatus account per (distributor, claimant) pair
 * - Enables efficient tracking of individual claim progress
 * - Prevents double-claiming when operator updates merkle root
 */
#[account]
#[derive(Default, Debug)]
pub struct ClaimStatus {
    /// Total amount claimed by this user (cumulative)
    pub claimed_amount: u64,
}

impl ClaimStatus {
    /// Calculate the space required for this account
    /// - Includes 8-byte discriminator + struct size
    pub const LEN: usize = 8 + std::mem::size_of::<ClaimStatus>();
} 