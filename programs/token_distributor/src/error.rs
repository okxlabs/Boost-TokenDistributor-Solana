use anchor_lang::prelude::*;

#[error_code]
pub enum TokenDistributorError {
    // Access control errors
    #[msg("Only operator can perform this action")]
    OnlyOperator,
    #[msg("Only owner can perform this action")]
    OnlyOwner,
    #[msg("Invalid operator account")]
    InvalidOperator,
    
    // Time validation errors
    #[msg("Start time not set")]
    StartTimeNotSet,
    #[msg("Distribution has already started, cannot modify time")]
    DistributionAlreadyStarted,
    #[msg("Invalid start time")]
    InvalidStartTime,
    #[msg("Start time cannot be more than 90 days in the future")]
    StartTimeTooFar,
    
    // Distribution state errors
    #[msg("Distribution not started")]
    DistributionNotStarted,
    #[msg("Distribution has ended")]
    DistributionEnded,
    #[msg("Distribution has not ended yet")]
    DistributionNotEnded,
    
    // Merkle proof errors
    #[msg("No merkle root set")]
    NoMerkleRoot,
    #[msg("Invalid merkle root")]
    InvalidMerkleRoot,
    #[msg("Invalid proof")]
    InvalidProof,
    
    // Amount validation errors
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient vault balance for this claim")]
    InsufficientVaultBalance,
    
    // System level errors
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Distributor account must be owned by this program")]
    DistributorNotOwnedByProgram,
    #[msg("Token mint does not match distributor's token mint")]
    TokenMintMismatch,
} 