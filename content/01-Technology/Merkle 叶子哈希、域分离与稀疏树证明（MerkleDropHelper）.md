---
title: "Merkle 叶子哈希、域分离与稀疏树证明（MerkleDropHelper）"
source: obsidian/01-Technology
---

# Merkle 叶子哈希、域分离与稀疏树证明（MerkleDropHelper）

## 结论速记

- **要点不是「多 hash 一次更安全」**：`keccak256(keccak256(...))` 主要价值在于**域分离**（让叶子哈希与内部节点哈希的“形状”可区分），避免“叶子/内部节点角色混淆”的结构性问题。
- **更标准/更易审计**：用显式前缀（`0x00` leaf / `0x01` internal）做域分离通常更直观；双 keccak 是同类目标的实现方式之一。
- **验证端必须逐字对齐**：叶子公式、兄弟排序规则、缺失节点默认值（稀疏=0）必须与建树完全一致。

## `keccak256(keccak256(abi.encode(member, amount)))` 是否足以避免 second preimage？

这里讨论的“second preimage / preimage”通常不是要攻击 keccak 本身，而是 Merkle 结构里常见的：

- 叶子与内部节点的构造如果不区分，可能出现“把某个内部节点值当作叶子来提交/验证”的**角色混淆**讨论。

在内部节点形如 `keccak256(abi.encode(min(a,b), max(a,b)))`（两个 `bytes32` 排序后再哈希）的前提下，把叶子定义为：

- `leaf = keccak256(keccak256(abi.encode(member, amount)))`

通常可认为实现了足够的**域分离**：叶子是“对 32 字节 digest 再 hash”，与内部节点“对两个 digest 做排序拼接再 hash”的形状不同。

更常见的等价目标写法是显式前缀：

```solidity
leaf = keccak256(abi.encodePacked(uint8(0x00), member, amount));
parent = keccak256(abi.encodePacked(uint8(0x01), min(left,right), max(left,right)));
```

## `MerkleDropHelper` 代码解读

下面按构造/证明两部分理解。

### 1) `constructTree(members, claimAmounts)`：构造稀疏（sparse）排序 Merkle

- **高度计算**：反复把 \(n\) 变成 \(\lceil n/2 \rceil\)，直到 0；得到层数 `height`。
- **叶子层（layer 0）**：
  - 叶子是 `~keccak256(abi.encode(member, amount))`
  - `~`（按位取反）是一个非标准但有效的“与内部节点区分开”的技巧（域分离思路的一种）。
- **内部层**：
  - 每两个孩子合成一个父节点；若缺右孩子，右孩子视为 `bytes32(0)`（稀疏，不 padding 到 2 的幂）。
  - **兄弟排序**：`hash = keccak256(abi.encode(min(a,b), max(a,b)))`

这决定了验证规则必须也使用“排序后哈希”的父节点规则。

### 2) `createProof(memberIndex, tree)`：生成稀疏证明

- `memberIndex` 是叶子数组中的位置（不是地址映射索引）。
- 每一层把当前 `leafIndex` 的兄弟下标取出：
  - 偶数：`leafIndex + 1`
  - 奇数：`leafIndex - 1`
- 若兄弟越界（不存在），证明该层的 sibling 留为 `0`，与稀疏规则对齐。
- 然后 `leafIndex /= 2` 上移到父层继续。

### 3) 验证端的最小要点（必须一致）

若你要写 `verify(member, amount, index, proof, root)`，它必须满足：

- 叶子：与构造一致（这里是 `~keccak256(abi.encode(member, amount))`，或你替换成“双 keccak/前缀”也行，但两端要一致）。
- 每层：与 sibling 做排序后哈希。
- 缺失 sibling：按 `0` 参与计算。

## `MerkleDropHelper` 源码

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

---
Saved: 2026-04-15

