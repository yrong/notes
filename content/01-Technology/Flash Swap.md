---
title: "Uniswap V2 Flash Swap & `swap()` 机制总结"
source: obsidian/01-Technology
---

# Uniswap V2 Flash Swap & `swap()` 机制总结

## 🧠 核心概念

**Flash Swap = 先拿 token → 执行逻辑 → 同一交易内归还，否则回滚**

- 基于 Ethereum 的 **原子性（atomicity）**
    
- 不需要提前提供资金（无抵押瞬时借贷）
    

---

## 🔄 普通 Swap vs Flash Swap

### 普通 Swap

1. 用户先把 token 转入 Pair
    
2. 调用 `swap`
    
3. Pair 转出目标 token
    

👉 **先付钱 → 再拿货**

---

### Flash Swap

1. 调用 `swap`
    
2. Pair 先转出 token
    
3. 触发 callback（用户合约）
    
4. 在 callback 中归还 token + fee
    
5. 未归还 → revert
    

👉 **先拿货 → 再付钱**

---

## ⚙️ `swap()` 函数

```solidity
function swap(
    uint amount0Out,
    uint amount1Out,
    address to,
    bytes calldata data
);
```

---

## 📌 参数说明

- `amount0Out`：要取出的 token0 数量
    
- `amount1Out`：要取出的 token1 数量
    
- `to`：接收 token 的地址（通常是合约）
    
- `data`：
    
    - 为空 → 普通 swap
        
    - 非空 → **触发 flash swap**
        

---

## 🧱 token 地址从哪里来？

Pair 合约内部已经固定：

```solidity
address public token0;
address public token1;
```

👉 每个 Pair = 一个固定交易对（如 DAI/WETH）

---

## 🧪 示例（DAI/WETH）

假设：

- token0 = DAI
    
- token1 = WETH
    

```solidity
swap(1000e18, 0, to, data); // 拿 1000 DAI
swap(0, 1e18, to, data);    // 拿 1 WETH
```

---

## 🔥 Flash Swap 关键机制（Callback）

当 `data != ""` 时：

Pair 会调用：

```solidity
uniswapV2Call(address sender, uint amount0, uint amount1, bytes data)
```

👉 必须在这里完成：

- 业务逻辑（套利 / 清算 / etc）
    
- 归还 token + 手续费
    

---

## 💡 本质理解

> 所有 swap 本质上都是 flash swap（先转出，再校验）

---

## 🔐 安全机制（Invariant）

Uniswap 会检查：

```
(x + Δx) * (y - Δy) >= k
```

👉 不满足 → revert

---

## 🚀 常见用途

- 套利（DEX 价差）
    
- 清算（借钱执行 liquidation）
    
- 杠杆 / 再融资
    

---

## ⚠️ 开发注意事项

- 必须实现 `uniswapV2Call`
- 必须在同一交易内归还资产
- 注意手续费计算（0.3%）
- 注意滑点 & 重入风险

---

## 🧠 一句话总结

> Flash Swap 是一种利用 Ethereum 原子性，实现“无抵押借贷 + 同交易归还”的机制。