use anchor_lang::prelude::*;

declare_id!("2Ab8No85xrnnd2rFamKjQqGAK6Qu9EQ4eEh59oaZEPBL");

pub mod constants;
pub mod error;
pub mod event;
pub mod instructions;
pub mod state;
pub mod utils;

#[cfg(test)]
pub mod test;

use instructions::*;

/**
 * Token Distributor Program
 *
 * A Solana program for distributing tokens to multiple recipients using merkle tree verification.
 * This program enables efficient and secure token airdrops with the following features:
 *
 * Key Features:
 * - Merkle tree-based claim verification
 * - Supports single claim (when root set once) or incremental distributions by adjusting max_amount without resetting previous claims
 * - Flexible merkle root updates (operator can update root anytime without time restrictions)
 * - Time-bounded distributions (configurable start and end times)
 * - Operator delegation (separate owner and operator roles)
 * - Cross-program call event emission for composability
 * - Support for both SPL Token and Token 2022
 *
 * Architecture:
 * - Nonce State PDA: Tracks nonce counter for each owner (automatic nonce management)
 * - Distributor PDA: Stores distribution parameters and state
 * - Token Vault PDA: Holds tokens to be distributed
 * - Claim Status PDAs: Track how much each user has claimed
 *
 * Workflow:
 * 1. Owner creates distributor and deposits tokens
 * 2. Operator sets start time and merkle root
 * 3. Users claim tokens with valid merkle proofs
 * 4. Owner withdraws remaining tokens after distribution ends
 * 5. Users can optionally close ClaimStatus accounts to reclaim rent
 */
#[program]
pub mod token_distributor {
    use super::*;

    /**
     * Creates a new token distributor
     *
     * Initializes a new token distribution campaign with automatic nonce management.
     * The owner deposits tokens into a vault controlled by the distributor PDA.
     * Nonce numbers are automatically assigned using an owner-specific counter.
     *
     * @param ctx - Account context containing distributor, vault, counter, and owner accounts
     * @param initial_total_amount - Total amount of tokens to distribute
     *
     * Access Control: Owner only
     */
    pub fn create_distributor(ctx: Context<CreateDistributor>, initial_total_amount: u64) -> Result<()> {
        handle_create_distributor(ctx, initial_total_amount)
    }

    /**
     * Sets the time for the distribution
     *
     * Configures when the token distribution will begin and automatically
     * calculates the end time(start_time + 14 days).
     *
     * @param ctx - Account context containing distributor and operator accounts
     * @param start_time - Unix timestamp when distribution should begin
     *
     * Access Control: Operator only
     */
    pub fn set_time(ctx: Context<SetTime>, start_time: i64) -> Result<()> {
        handle_set_time(ctx, start_time)
    }

    /**
     * Sets the merkle root for claim verification
     *
     * Configures the merkle root hash that will be used to verify token claims.
     * The merkle root represents a tree of all eligible (claimant, amount) pairs.
     *
     * @param ctx - Account context containing distributor and operator accounts
     * @param merkle_root - 32-byte hash representing the merkle tree root
     *
     * Access Control: Operator only
     * Note: The merkle root can be updated multiple times if needed
     */
    pub fn set_merkle_root(ctx: Context<SetMerkleRoot>, merkle_root: [u8; 32]) -> Result<()> {
        handle_set_merkle_root(ctx, merkle_root)
    }

    /**
     * Claims tokens with merkle proof verification
     *
     * Allows eligible users to claim their allocated tokens by providing a valid merkle proof
     * @param ctx - Account context containing distributor, claim status, and token accounts
     * @param max_amount - Maximum amount this user is eligible to claim
     * @param proof - Array of 32-byte hashes forming the merkle proof
     *
     * Access Control: Any user with valid merkle proof
     */
    pub fn claim(ctx: Context<Claim>, max_amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        handle_claim(ctx, max_amount, proof)
    }

    /**
     * Withdraws remaining tokens after distribution ends
     *
     * Allows the owner to reclaim any undistributed tokens after the distribution
     * period has ended. This also closes the distributor and vault accounts.
     *
     * @param ctx - Account context containing distributor, vault, and owner accounts
     *
     * Access Control: Owner only
     * Note: This provides complete cleanup and rent recovery
     */
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        handle_withdraw(ctx)
    }

    /**
     * Closes a ClaimStatus account and reclaims rent
     *
     * Allows users to close their ClaimStatus accounts after the distribution
     * has ended to reclaim the rent they paid during account creation.
     *
     * @param ctx - Account context containing claim status and claimant accounts
     *
     * Access Control: Claimant only (enforced by PDA seeds)
     *
     * Note: This enables users to optionally recover the cost of claim participation
     */
    pub fn close_claim_status(ctx: Context<CloseClaimStatus>) -> Result<()> {
        handle_close_claim_status(ctx)
    }
}
