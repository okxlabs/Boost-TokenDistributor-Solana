use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::pubkey::Pubkey;
use std::str::FromStr;

#[derive(Debug, Clone)]
struct TreeNode {
    claimant: Pubkey,
    amount: u64,
}

struct SimpleMerkleTree {
    nodes: Vec<[u8; 32]>,
    leaf_count: usize,
}

impl SimpleMerkleTree {
    fn new(tree_nodes: Vec<TreeNode>) -> Self {
        let leaf_count = tree_nodes.len();
        let mut nodes = Vec::new();

        // Generate leaf hashes
        for node in tree_nodes {
            let leaf_hash = Self::hash_leaf(&node.claimant, node.amount);
            nodes.push(leaf_hash.to_bytes());
        }

        let mut tree = SimpleMerkleTree {
            nodes,
            leaf_count,
        };

        // Build the tree
        tree.build_tree();
        tree
    }

    fn hash_leaf(claimant: &Pubkey, amount: u64) -> anchor_lang::solana_program::hash::Hash {
        // Hash leaf without prefix
        hashv(&[
            &claimant.to_bytes(),
            &amount.to_le_bytes(),
        ])
    }

    fn hash_intermediate(left: &[u8; 32], right: &[u8; 32]) -> anchor_lang::solana_program::hash::Hash {
        // Hash intermediate nodes without prefix, using the same ordering as verify function
        if left <= right {
            hashv(&[left, right])
        } else {
            hashv(&[right, left])
        }
    }

    fn build_tree(&mut self) {
        let mut level_len = self.next_level_len(self.leaf_count);
        let mut level_start = self.leaf_count;
        let mut prev_level_len = self.leaf_count;
        let mut prev_level_start = 0;

        while level_len > 0 {
            for i in 0..level_len {
                let prev_level_idx = 2 * i;
                let left_sibling = &self.nodes[prev_level_start + prev_level_idx];
                let right_sibling = if prev_level_idx + 1 < prev_level_len {
                    &self.nodes[prev_level_start + prev_level_idx + 1]
                } else {
                    // Duplicate last entry if odd
                    &self.nodes[prev_level_start + prev_level_idx]
                };

                let hash = Self::hash_intermediate(left_sibling, right_sibling);
                let hash_bytes = hash.to_bytes();
                self.nodes.push(hash_bytes);
            }

            prev_level_start = level_start;
            prev_level_len = level_len;
            level_start += level_len;
            level_len = self.next_level_len(level_len);
        }
    }

    fn next_level_len(&self, level_len: usize) -> usize {
        if level_len == 1 {
            0
        } else {
            (level_len + 1) / 2
        }
    }

    fn get_root(&self) -> Option<&[u8; 32]> {
        if self.nodes.is_empty() {
            None
        } else {
            Some(&self.nodes[self.nodes.len() - 1])
        }
    }

    fn get_merkle_root(&self) -> Result<Vec<u8>, &'static str> {
        match self.get_root() {
            Some(root) => Ok(root.to_vec()),
            None => Err("Cannot get merkle root from empty tree"),
        }
    }

    /// Generate merkle proof for a leaf at given index
    fn get_proof(&self, index: usize) -> Result<Vec<[u8; 32]>, &'static str> {
        if index >= self.leaf_count {
            return Err("Index out of bounds");
        }

        let mut proof = Vec::new();
        let mut current_index = index;
        let mut level_start = 0;
        let mut level_len = self.leaf_count;

        while level_len > 1 {
            // Find sibling index
            let sibling_index = if current_index % 2 == 0 {
                // Current node is left child, sibling is right
                if current_index + 1 < level_len {
                    current_index + 1
                } else {
                    // No right sibling, duplicate current node (shouldn't happen in our case)
                    current_index
                }
            } else {
                // Current node is right child, sibling is left
                current_index - 1
            };
            
            let sibling_node = self.nodes[level_start + sibling_index];
            proof.push(sibling_node);
            
            // Move to next level
            current_index /= 2;
            level_start += level_len;
            level_len = self.next_level_len(level_len);
        }

        Ok(proof)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::verify;

    fn get_test_data() -> Vec<TreeNode> {
        // Data from test_fixtures.csv
        vec![
            TreeNode {
                claimant: Pubkey::from_str("3gmBN8LBomg3sZEjTgp2YsECMYgJpjcT7xUfpnDB4gSs").unwrap(),
                amount: 1000,
            },
            TreeNode {
                claimant: Pubkey::from_str("8G9xE8awr9vA2PZWFTJSHNhS16KLnXYdV6XEaJP1a2Yx").unwrap(),
                amount: 2000,
            },
            TreeNode {
                claimant: Pubkey::from_str("A4mDtfFCkdt9CqGzEkfiSHhJD8d3bUMasVzwajudGtb2").unwrap(),
                amount: 3000,
            },
            TreeNode {
                claimant: Pubkey::from_str("4SX6nqv5VRLMoNfYM5phvHgcBNcBEwUEES4qPPjf1EqS").unwrap(),
                amount: 4000,
            },
        ]
    }

    #[test]
    fn test_merkle_tree_consistency() {
        println!("=== Testing Merkle Tree Consistency ===");
        
        let tree_nodes = get_test_data();

        println!("Creating Merkle Tree with {} nodes", tree_nodes.len());
        
        // Print individual leaf hashes for debugging
        for (i, node) in tree_nodes.iter().enumerate() {
            let leaf_hash = SimpleMerkleTree::hash_leaf(&node.claimant, node.amount);
            println!("Leaf {}: claimant={}, amount={}, hash={:?}", 
                i, node.claimant, node.amount, leaf_hash.to_bytes());
        }

        let merkle_tree = SimpleMerkleTree::new(tree_nodes);
        let root = merkle_tree.get_merkle_root().unwrap();
        
        println!("Rust Merkle Root: {:?}", root);
        println!("Rust Merkle Root length: {}", root.len());
        
        // Convert to the same format as TypeScript output
        let root_array: Vec<u8> = root.into_iter().collect();
        println!("Rust Merkle Root as array: {:?}", root_array);
        
        // Expected TypeScript result (after removing prefixes and using lexicographic ordering)
        let expected_ts_root = vec![
            51, 122, 158, 29, 92, 151, 242, 153,
            236, 252, 41, 211, 22, 50, 250, 139,
            218, 189, 37, 163, 61, 102, 114, 92,
            184, 219, 198, 184, 3, 245, 63, 91
        ];
        
        println!("Expected TypeScript root: {:?}", expected_ts_root);
        
        // Compare results
        if root_array == expected_ts_root {
            println!("✅ SUCCESS: Rust and TypeScript Merkle roots match!");
        } else {
            println!("❌ MISMATCH: Rust and TypeScript Merkle roots differ!");
            println!("Difference found at positions:");
            for (i, (rust_byte, ts_byte)) in root_array.iter().zip(expected_ts_root.iter()).enumerate() {
                if rust_byte != ts_byte {
                    println!("  Position {}: Rust={}, TypeScript={}", i, rust_byte, ts_byte);
                }
            }
        }
    }

    #[test]
    fn test_get_proof_and_verify() {
        println!("=== Testing get_proof and verify ===");
        
        let tree_nodes = get_test_data();
        let merkle_tree = SimpleMerkleTree::new(tree_nodes.clone());
        let root = merkle_tree.get_root().unwrap();
        
        println!("Merkle root: {:?}", root);
        
        // Test proof generation and verification for each leaf
        for (index, node) in tree_nodes.iter().enumerate() {
            println!("\n--- Testing node {} ---", index);
            println!("Claimant: {}", node.claimant);
            println!("Amount: {}", node.amount);
            
            // Generate leaf hash
            let leaf_hash = SimpleMerkleTree::hash_leaf(&node.claimant, node.amount);
            println!("Leaf hash: {:?}", leaf_hash.to_bytes());
            
            // Get proof
            let proof = merkle_tree.get_proof(index).expect("Failed to get proof");
            println!("Proof length: {}", proof.len());
            println!("Proof: {:?}", proof);
            
            // Verify proof
            let is_valid = verify(proof.clone(), *root, leaf_hash.to_bytes());
            println!("Proof verification: {}", if is_valid { "✅ VALID" } else { "❌ INVALID" });
            
            assert!(is_valid, "Proof verification failed for index {}", index);
        }
        
        println!("\n✅ All proofs verified successfully!");
    }

    #[test]
    fn test_invalid_proof() {
        println!("=== Testing invalid proof ===");
        
        let tree_nodes = get_test_data();
        let merkle_tree = SimpleMerkleTree::new(tree_nodes.clone());
        let root = merkle_tree.get_root().unwrap();
        
        // Test with wrong leaf
        let wrong_leaf = SimpleMerkleTree::hash_leaf(
            &Pubkey::from_str("11111111111111111111111111111112").unwrap(), 
            9999
        );
        let proof = merkle_tree.get_proof(0).expect("Failed to get proof");
        
        let is_valid = verify(proof, *root, wrong_leaf.to_bytes());
        println!("Invalid proof verification: {}", if is_valid { "❌ UNEXPECTEDLY VALID" } else { "✅ CORRECTLY INVALID" });
        
        assert!(!is_valid, "Invalid proof should not verify");
        
        // Test with tampered proof
        let correct_leaf = SimpleMerkleTree::hash_leaf(&tree_nodes[0].claimant, tree_nodes[0].amount);
        let mut tampered_proof = merkle_tree.get_proof(0).expect("Failed to get proof");
        if !tampered_proof.is_empty() {
            tampered_proof[0][0] = tampered_proof[0][0].wrapping_add(1); // Tamper with first byte
        }
        
        let is_valid_tampered = verify(tampered_proof, *root, correct_leaf.to_bytes());
        println!("Tampered proof verification: {}", if is_valid_tampered { "❌ UNEXPECTEDLY VALID" } else { "✅ CORRECTLY INVALID" });
        
        assert!(!is_valid_tampered, "Tampered proof should not verify");
        
        println!("✅ Invalid proof tests passed!");
    }

    #[test]
    fn test_proof_edge_cases() {
        println!("=== Testing proof edge cases ===");
        
        // Test with single node
        let single_node = vec![TreeNode {
            claimant: Pubkey::from_str("3gmBN8LBomg3sZEjTgp2YsECMYgJpjcT7xUfpnDB4gSs").unwrap(),
            amount: 1000,
        }];
        
        let single_tree = SimpleMerkleTree::new(single_node.clone());
        let single_root = single_tree.get_root().unwrap();
        let single_proof = single_tree.get_proof(0).expect("Failed to get proof for single node");
        
        println!("Single node proof length: {}", single_proof.len());
        assert_eq!(single_proof.len(), 0, "Single node should have empty proof");
        
        let single_leaf = SimpleMerkleTree::hash_leaf(&single_node[0].claimant, single_node[0].amount);
        let single_valid = verify(single_proof, *single_root, single_leaf.to_bytes());
        println!("Single node verification: {}", if single_valid { "✅ VALID" } else { "❌ INVALID" });
        assert!(single_valid, "Single node proof should be valid");
        
        // Test out of bounds
        let tree_nodes = get_test_data();
        let merkle_tree = SimpleMerkleTree::new(tree_nodes);
        let out_of_bounds_result = merkle_tree.get_proof(10);
        assert!(out_of_bounds_result.is_err(), "Out of bounds should return error");
        
        println!("✅ Edge case tests passed!");
    }
} 