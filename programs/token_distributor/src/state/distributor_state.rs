use anchor_lang::prelude::*;

/**
 * Main distributor state account
 * 
 * This struct represents the core state of a token distribution campaign.
 * It stores all the necessary parameters and tracking information for
 * managing a merkle tree-based token distribution.
 * 
 * Derivation: ["distributor", token_mint, owner, nonce]
 * 
 * Lifecycle:
 * 1. Created during create_distributor instruction
 * 2. Updated when start_time and merkle_root are set
 * 3. Updated during claims (total_claimed increments)
 * 4. Closed during withdraw instruction
 */
#[account]
#[derive(Default, Debug)]
pub struct TokenDistributor {
    /// Bump seed for PDA derivation
    /// - Saved to avoid recomputation during claim operations
    pub bump: u8,
    
    /// Nonce number for this distributor
    /// - Allows multiple distribution campaigns for the same token/owner pair
    pub nonce: u32,
    
    /// Owner of the distributor
    /// - Can withdraw remaining tokens after distribution ends
    pub owner: Pubkey,
    
    /// Operator who can manage the distribution
    /// - Can set start time and update merkle root
    pub operator: Pubkey,
    
    /// Token mint address
    /// - Specifies which token is being distributed
    pub token_mint: Pubkey,
    
    /// Token vault account address
    /// - PDA that holds the tokens to be distributed
    /// - Controlled by the distributor PDA
    /// - Derived from: ["vault", distributor_key]
    pub token_vault: Pubkey,
    
    /// Initial total amount of tokens deposited
    /// - Set during distributor creation
    pub initial_total_amount: u64,
    
    /// Total amount of tokens claimed by all users
    /// - Incremented with each successful claim
    /// - Used to track distribution progress
    pub total_claimed: u64,
    
    /// Start time of distribution (Unix timestamp)
    /// - Set by operator before distribution begins
    /// - Claims are only allowed after this time
    pub start_time: i64,
    
    /// End time of distribution (Unix timestamp)
    /// - Automatically calculated as start_time + DURATION
    /// - Claims are only allowed before this time
    /// - Withdrawal is only allowed after this time
    pub end_time: i64,
    
    /// Merkle root for claim verification
    /// - 32-byte hash representing the root of the merkle tree
    /// - Used to verify user claims with merkle proofs
    /// - Can be updated by operator at any time
    pub merkle_root: [u8; 32],
}

impl TokenDistributor {
    /// Calculate the space required for this account
    /// - Includes 8-byte discriminator + struct size
    pub const LEN: usize = 8 + std::mem::size_of::<TokenDistributor>();
} 