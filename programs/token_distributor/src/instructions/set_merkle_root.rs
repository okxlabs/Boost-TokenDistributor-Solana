use anchor_lang::prelude::*;
use crate::state::*;
use crate::error::*;
use crate::event::*;

/**
 * Account context for setting the merkle root
 * 
 * This instruction allows the designated operator to set the merkle root hash
 * that will be used to verify token claims. The merkle root represents the
 * root of a merkle tree containing all eligible claimants and their allocations.
 * 
 * Access Control: Only the operator can set the merkle root
 * 
 * Business Logic:
 * - The merkle root defines who can claim tokens and how much
 * - Each leaf in the merkle tree represents a (claimant, amount) pair
 * - Claimants must provide a valid merkle proof to claim their tokens
 * - The merkle root can be updated by the operator if needed
 */
#[event_cpi]
#[derive(Accounts)]
pub struct SetMerkleRoot<'info> {
    /// The distributor account to update
    /// - Must be a valid existing distributor PDA
    /// - Will be modified to set the merkle_root
    #[account(mut)]
    pub distributor: Account<'info, TokenDistributor>,
    
    /// The operator who can set the merkle root
    /// - Must match the operator stored in the distributor state
    /// - Only this account can call this instruction
    #[account(constraint = operator.key() == distributor.operator @ TokenDistributorError::OnlyOperator)]
    pub operator: Signer<'info>,
}

/**
 * Sets the merkle root for the token distribution
 * 
 * This function configures the merkle root hash that will be used to verify token claims
 * 
 * @param ctx - The account context containing distributor and operator accounts
 * @param merkle_root - 32-byte hash representing the root of the merkle tree
 * 
 * Merkle Tree Structure:
 * - Each leaf: hash(claimant_pubkey + max_amount)
 * - Intermediate nodes: hash(left_child + right_child) with lexicographic ordering
 * - Root: The final hash at the top of the tree
 * 
 * Validation Rules:
 * - Merkle root cannot be all zeros (empty hash)
 * - Only the designated operator can set the merkle root
 * - The merkle root can be updated multiple times if needed
 * 
 * Usage Notes:
 * - The merkle root should be generated off-chain from the complete list of eligible claimants
 * - Each claimant will need a merkle proof to verify their eligibility during claims
 * - The merkle tree construction should use the same hashing algorithm as the verify function
 */
pub fn handle_set_merkle_root(
    ctx: Context<SetMerkleRoot>,
    merkle_root: [u8; 32],
) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;
    
    // Validate that the merkle root is not empty
    // An empty merkle root would allow no valid claims
    require!(merkle_root != [0; 32], TokenDistributorError::InvalidMerkleRoot);
    
    // Set the merkle root for claim verification
    distributor.merkle_root = merkle_root;
    
    // Emit event for off-chain indexing and monitoring
    emit_cpi!(MerkleRootSet {
        distributor: distributor.key(),
        operator: ctx.accounts.operator.key(),
        merkle_root,
    });
    
    Ok(())
} 