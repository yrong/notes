---
title: "Merkle leaf hashing, domain separation, and sparse proofs (MerkleDropHelper)"
date: 2022-09-15
draft: false
tags: ["cryptography", "ethereum", "merkle", "security"]
author: Ron
---

## TL;DR

- **The point is not “hash twice = stronger”**: the main value of `keccak256(keccak256(...))` is **domain separation** — leaf hashes and internal-node hashes have different construction shapes, which avoids “role confusion” between leaves and internal nodes in Merkle trees.
- **More standard**: explicit prefixes (`leaf` / `internal`) are usually easier for auditors and cross-language ports than `~hash` or double keccak.
- **Verifier must match byte-for-byte**: leaf formula, internal hash order (sorted or not), and sparse missing-node default (`0`) must be identical on both sides.

## Is `keccak256(keccak256(abi.encode(member, amount)))` enough against second preimage?

In Merkle trees, the usual worry is not breaking Keccak’s preimage resistance. It is:

- If leaves and internal nodes are not clearly distinguished, one can discuss whether an **internal node value could be passed off as a leaf** — **leaf / internal role confusion**.

If internal nodes are fixed as:

```solidity
parent = keccak256(abi.encode(min(left, right), max(left, right)));
```

and leaves are:

```solidity
leaf = keccak256(keccak256(abi.encode(member, amount)));
```

that is usually enough **domain separation**: a leaf is “hash of a 32-byte digest again”; an internal node is “hash of two digests (sorted)”. The construction shapes differ.

A clearer, more common form uses explicit prefixes:

```solidity
leaf   = keccak256(abi.encodePacked(uint8(0x00), member, amount));
parent = keccak256(abi.encodePacked(uint8(0x01), min(left,right), max(left,right)));
```

## Reading `MerkleDropHelper` (sparse + sorted hashing)

### `constructTree(members, claimAmounts)`

- **Height**: repeatedly replace \(n\) with \(\lceil n/2 \rceil\) until 0 → layer count `height`.
- **Leaf layer**: each leaf is:

```solidity
nodes[i] = ~keccak256(abi.encode(members[i], claimAmounts[i]));
```

`~` (bitwise NOT) is a non-standard trick to distinguish leaves from internal nodes — another way to get domain separation.

- **Internal nodes**: missing right child is `bytes32(0)` (sparse); siblings are always hashed in sorted order:

```solidity
hashes[i / 2] = keccak256(a > b ? abi.encode(b, a) : abi.encode(a, b));
```

### `createProof(memberIndex, tree)`

- `memberIndex` is the index in the leaf array.
- Each layer: sibling index is `+1` if even, `-1` if odd; out of range → sibling `0` (sparse default).
- `leafIndex /= 2` and climb.

### Three rules the verifier must obey

A `verify(member, amount, index, proof, root)` must match tree construction:

- **Leaf**: same formula (here `~keccak256(abi.encode(...))`; if you switch to double keccak / prefixes, change both ends together).
- **Parent**: same sibling sort rule.
- **Missing sibling**: treat as `0` in the hash.

## `MerkleDropHelper` source

```solidity
contract MerkleDropHelper {
    // Construct a sparse merkle tree from a list of members and respective claim
    // amounts. This tree will be sparse in the sense that rather than padding
    // tree levels to the next power of 2, missing nodes will default to a value of
    // 0.
    function constructTree(
        address[] memory members,
        uint256[] memory claimAmounts
    )
        external
        pure
        returns (bytes32 root, bytes32[][] memory tree)
    {
        require(members.length != 0 && members.length == claimAmounts.length);
        // Determine tree height.
        uint256 height = 0;
        {
            uint256 n = members.length;
            while (n != 0) {
                n = n == 1 ? 0 : (n + 1) / 2;
                ++height;
            }
        }
        tree = new bytes32[][](height);
        // The first layer of the tree contains the leaf nodes, which are
        // hashes of each member and claim amount.
        bytes32[] memory nodes = tree[0] = new bytes32[](members.length);
        for (uint256 i = 0; i < members.length; ++i) {
            // Leaf hashes are inverted to prevent second preimage attacks.
            nodes[i] = ~keccak256(abi.encode(members[i], claimAmounts[i]));
        }
        // Build up subsequent layers until we arrive at the root hash.
        // Each parent node is the hash of the two children below it.
        // E.g.,
        //              H0         <-- root (layer 2)
        //           /     \
        //        H1        H2
        //      /   \      /  \
        //    L1     L2  L3    L4  <--- leaves (layer 0)
        for (uint256 h = 1; h < height; ++h) {
            uint256 nHashes = (nodes.length + 1) / 2;
            bytes32[] memory hashes = new bytes32[](nHashes);
            for (uint256 i = 0; i < nodes.length; i += 2) {
                bytes32 a = nodes[i];
                // Tree is sparse. Missing nodes will have a value of 0.
                bytes32 b = i + 1 < nodes.length ? nodes[i + 1] : bytes32(0);
                // Siblings are always hashed in sorted order.
                hashes[i / 2] = keccak256(a > b ? abi.encode(b, a) : abi.encode(a, b));
            }
            tree[h] = nodes = hashes;
        }
        // Note the tree root is at the bottom.
        root = tree[height - 1][0];
    }

    // Given a merkle tree and a member index (leaf node index), generate a proof.
    // The proof is simply the list of sibling nodes/hashes leading up to the root.
    function createProof(uint256 memberIndex, bytes32[][] memory tree)
        external
        pure
        returns (bytes32[] memory proof)
    {
        uint256 leafIndex = memberIndex;
        uint256 height = tree.length;
        proof = new bytes32[](height - 1);
        for (uint256 h = 0; h < proof.length; ++h) {
            uint256 siblingIndex = leafIndex % 2 == 0 ? leafIndex + 1 : leafIndex - 1;
            if (siblingIndex < tree[h].length) {
                proof[h] = tree[h][siblingIndex];
            }
            leafIndex /= 2;
        }
    }
}
```
