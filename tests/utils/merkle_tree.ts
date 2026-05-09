import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";

export interface TreeNode {
  claimant: PublicKey;
  amount: anchor.BN;
  proof?: Buffer[];
}

// Solana's hashv implementation using SHA-256 (not Keccak-256!)
function hashv(data: Buffer[]): Buffer {
  const combined = Buffer.concat(data);
  return Buffer.from(sha256(combined));
}

export class SimpleMerkleTree {
  private leaves: Buffer[];
  private nodes: Buffer[];
  private leafCount: number;

  constructor(treeNodes: TreeNode[]) {
    this.leafCount = treeNodes.length;
    this.leaves = [];
    this.nodes = [];

    // Generate leaf hashes
    for (const node of treeNodes) {
      const leafHash = this.hashLeaf(node.claimant, node.amount);
      this.leaves.push(leafHash);
      this.nodes.push(leafHash);
    }

    // Build the tree
    this.buildTree();
  }

  private hashLeaf(claimant: PublicKey, amount: anchor.BN): Buffer {
    // Hash leaf without prefix
    return hashv([claimant.toBuffer(), Buffer.from(amount.toArray("le", 8))]);
  }

  private hashIntermediate(left: Buffer, right: Buffer): Buffer {
    // Hash intermediate nodes without prefix, using lexicographic ordering
    if (left.compare(right) <= 0) {
      return hashv([left, right]);
    } else {
      return hashv([right, left]);
    }
  }

  private buildTree() {
    let levelLen = this.nextLevelLen(this.leafCount);
    let levelStart = this.leafCount;
    let prevLevelLen = this.leafCount;
    let prevLevelStart = 0;

    while (levelLen > 0) {
      for (let i = 0; i < levelLen; i++) {
        const prevLevelIdx = 2 * i;
        const leftSibling = this.nodes[prevLevelStart + prevLevelIdx];
        const rightSibling =
          prevLevelIdx + 1 < prevLevelLen
            ? this.nodes[prevLevelStart + prevLevelIdx + 1]
            : this.nodes[prevLevelStart + prevLevelIdx]; // Duplicate last entry if odd

        const hash = this.hashIntermediate(leftSibling, rightSibling);
        this.nodes.push(hash);
      }

      prevLevelStart = levelStart;
      prevLevelLen = levelLen;
      levelStart += levelLen;
      levelLen = this.nextLevelLen(levelLen);
    }
  }

  private nextLevelLen(levelLen: number): number {
    if (levelLen === 1) {
      return 0;
    } else {
      return Math.floor((levelLen + 1) / 2);
    }
  }

  public getMerkleRoot(): number[] {
    const root = this.getRoot();
    if (!root) {
      throw new Error("Cannot get merkle root from empty tree");
    }
    return Array.from(root);
  }

  private getRoot(): Buffer | null {
    if (this.nodes.length === 0) {
      return null;
    }
    return this.nodes[this.nodes.length - 1];
  }

  // Generate merkle proof for a leaf at given index
  public getProof(index: number): Buffer[] {
    if (index >= this.leafCount) {
      throw new Error("Index out of bounds");
    }

    const proof: Buffer[] = [];
    let currentIndex = index;
    let levelStart = 0;
    let levelLen = this.leafCount;

    while (levelLen > 1) {
      // Find sibling index
      const siblingIndex =
        currentIndex % 2 === 0
          ? currentIndex + 1 < levelLen
            ? currentIndex + 1
            : currentIndex // Right sibling or duplicate
          : currentIndex - 1; // Left sibling

      const siblingNode = this.nodes[levelStart + siblingIndex];
      proof.push(siblingNode);

      // Move to next level
      currentIndex = Math.floor(currentIndex / 2);
      levelStart += levelLen;
      levelLen = this.nextLevelLen(levelLen);
    }

    return proof;
  }
}
