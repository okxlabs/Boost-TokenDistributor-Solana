use anchor_lang::prelude::*;

/**
 * Program Constants
 * 
 * This module defines all the constant values used throughout the token distributor program.
 * These constants control timing, PDA derivation, and other program behavior.
 */

#[constant]
/// ===== TIMING CONSTANTS =====

/// Duration of each distribution period (14 days)
/// - Applied when setting start_time to calculate end_time
/// - Provides a reasonable window for users to claim their tokens
/// - Value: 14 days * 24 hours * 60 minutes * 60 seconds = 1,209,600 seconds
pub const DURATION: i64 = 14 * 24 * 60 * 60; // 14 days in seconds

/// Maximum allowed start time in the future (90 days)
/// - Each modification limited to max 90 days from current time
/// - Prevents setting times too far ahead in single operation
/// - Value: 90 days * 24 hours * 60 minutes * 60 seconds = 7,776,000 seconds
pub const MAX_START_TIME: i64 = 90 * 24 * 60 * 60; // 90 days in seconds

/// ===== PDA SEED CONSTANTS =====

/// Seed for owner nonce PDA derivation
/// - Used in: ["owner_nonce", owner]
/// - Creates unique nonce tracking accounts for each owner
/// - Enables automatic nonce assignment for distributors
pub const OWNER_NONCE_SEED: &str = "owner_nonce";

/// Seed for distributor PDA derivation
/// - Used in: ["distributor", token_mint, owner, nonce]
/// - Creates unique distributor accounts for each (token, owner, nonce) combination
/// - Ensures deterministic and collision-free PDA generation
pub const DISTRIBUTOR_SEED: &str = "distributor";

/// Seed for token vault PDA derivation
/// - Used in: ["vault", distributor_key]
/// - Creates a unique vault for each distributor
/// - Ensures the vault is controlled by the distributor PDA
pub const VAULT_SEED: &str = "vault";

/// Seed for claim status PDA derivation
/// - Used in: ["claim", distributor_key, claimant_key]
/// - Creates unique claim tracking for each (distributor, claimant) pair
/// - Enables efficient claim status management and prevents double-claiming
/// - Tracks cumulative claimed amount even when operator updates merkle root
pub const CLAIM_SEED: &str = "claim";
