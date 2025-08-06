use anchor_lang::prelude::*;

/**
 * Nonce state account
 *
 * This struct tracks the nonce counter for each owner, enabling automatic
 * nonce assignment for new distributors.
 *
 * Derivation: ["owner_nonce", owner]
 *
 * Lifecycle:
 * 1. Created on first distributor creation (using init_if_needed)
 * 2. Updated with each new distributor creation (nonce incremented)
 * 3. Persistent across multiple distributor campaigns
 *
 * Design Notes:
 * - One NonceState account per owner
 * - Enables automatic nonce assignment
 */
#[account]
#[derive(Default, Debug)]
pub struct NonceState {
    /// Increments with each distributor creation
    /// - Ensures unique nonces for each owner's distributors
    pub nonce: u32,
}

impl NonceState {
    /// Calculate the space required for this account
    /// - Includes 8-byte discriminator + struct size
    pub const LEN: usize = 8 + std::mem::size_of::<NonceState>();
}
