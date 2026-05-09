use anchor_lang::prelude::*;

/// Event emitted when a new distributor is created
#[event]
pub struct DistributorCreated {
    /// The distributor account public key
    pub distributor: Pubkey,
    /// Nonce of the distributor
    pub nonce: u32,
    /// Owner of the distributor
    pub owner: Pubkey,
    /// Operator of the distributor
    pub operator: Pubkey,
    /// Token mint address
    pub token_mint: Pubkey,
    /// Token vault address
    pub token_vault: Pubkey,
    /// Initial total amount of tokens deposited
    pub initial_total_amount: u64,
}

/// Event emitted when the start time is set
#[event]
pub struct StartTimeSet {
    /// The distributor account public key
    pub distributor: Pubkey,
    /// Operator who set the start time
    pub operator: Pubkey,
    /// Start time of the distribution
    pub start_time: i64,
    /// End time of the distribution
    pub end_time: i64,
}

/// Event emitted when the merkle root is set
#[event]
pub struct MerkleRootSet {
    /// The distributor account public key
    pub distributor: Pubkey,
    /// Operator who set the merkle root
    pub operator: Pubkey,
    /// The merkle root hash
    pub merkle_root: [u8; 32],
}

/// Event emitted when tokens are claimed
#[event]
pub struct TokensClaimed {
    /// The distributor account public key
    pub distributor: Pubkey,
    /// Address of the claimant
    pub claimant: Pubkey,
    /// Amount of tokens claimed by user in this transaction
    pub user_amount_claimed: u64,
    /// Maximum amount the user is eligible to claim
    pub user_max_amount: u64,
    /// Total amount claimed from the distributor by all users
    pub total_claimed: u64,
}

/// Event emitted when remaining tokens are withdrawn
#[event]
pub struct TokensWithdrawn {
    /// The distributor account public key
    pub distributor: Pubkey,
    /// Owner who withdrew the tokens
    pub owner: Pubkey,
    /// Amount of tokens withdrawn
    pub amount_withdrawn: u64,
}

/// Event emitted when a ClaimStatus account is closed
#[event]
pub struct ClaimStatusClosed {
    /// The distributor account public key
    pub distributor: Pubkey,
    /// Address of the claimant who closed the account
    pub claimant: Pubkey,
    /// Total amount that was claimed by this user
    pub claimed_amount: u64,
}
