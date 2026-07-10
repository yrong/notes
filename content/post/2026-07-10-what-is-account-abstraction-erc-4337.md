---
author: Ron
date: 2026-07-10T13:00:00+08:00
tags:
- blockchain
- ethereum
- account-abstraction
- wallets
title: "学习笔记：Account Abstraction 与 ERC-4337"
---

[Alchemy 概述](https://www.alchemy.com/overviews/what-is-account-abstraction) 介绍了 **ERC-4337**：在不改动以太坊共识层的前提下，用智能合约钱包替代传统 EOA，实现可编程验证、代付 Gas、批量交易等能力。本文整理其核心概念、流程与后续演进（ERC-6900 / EIP-7702）。

<!--more-->

## 1. 什么是 ERC-4337？

ERC-4337 是 Account Abstraction（账户抽象）的基础标准：用户以**智能合约账户**作为主账户，验证逻辑可编程，而不再依赖单一私钥签名的 EOA。

- **上线时间**：2023-03-01 主网（EntryPoint 首次部署）
- **关键点**：跑在链之上，**无需协议层硬分叉**，任意 EVM 链可用
- **规模（文中数据）**：超 4000 万智能账户；2024 年约 2000 万新建；累计超 1 亿次 UserOperation

相对早期需改共识的方案（如 EIP-2938、EIP-3074），4337 用**替代 mempool + Bundler 生态**达成同样目标，并保留去中心化与抗审查。

## 2. 六个核心概念

| 组件 | 作用 |
|------|------|
| **UserOperation** | 伪交易对象，表达用户意图；走独立 mempool，认证可编程 |
| **Bundler** | 监听 UserOp mempool，打包成一笔普通交易提交 EntryPoint；自身持有 EOA |
| **EntryPoint** | 单例合约：验证 → 执行 UserOp，并向 Bundler 结算 Gas |
| **Paymaster** | 定义 Gas 谁付、用什么付（赞助 / ERC-20 / 自定义策略） |
| **Sender** | 发起操作的智能合约账户 |
| **Aggregator** | 聚合多签名，降低 calldata 成本 |

### 2.1 UserOperation vs 普通交易

- 额外字段（EntryPoint / Bundler / Aggregator 等）
- 发往**独立 mempool**，由 Bundler 打包
- 认证逻辑由账户合约定义，而非固定 ECDSA

### 2.2 Bundler：唯一仍需 EOA 的角色

链上交易仍须由 EOA 发起。Bundler 用自己的 EOA 把一批 UserOp 打成一笔交易交给 EntryPoint，并从 Gas 中抽成。对用户而言，**不必再持有 EOA**。

### 2.3 EntryPoint：验证与执行

1. **验证**：调用账户自定义逻辑；检查账户（或 Paymaster）能否覆盖最大 Gas
2. **执行**：按 calldata 调用账户；从账户扣费，补偿 Bundler

### 2.4 Paymaster：灵活 Gas 策略

- 应用代付（gasless onboarding）
- 用 USDC 等 ERC-20 付 Gas
- 自定义业务策略

### 2.5 Aggregator：签名聚合

多笔 UserOp 的签名合成一个，一次验证，省 calldata。

## 3. 典型流程

```text
用户 / 钱包
  → 构造 UserOperation
  → 提交到 UserOp mempool
Bundler
  → 打包多笔 UserOp
  → 以 EOA 交易调用 EntryPoint
EntryPoint
  → 验证（账户 + 可选 Paymaster）
  → 执行 calldata
  → 结算 Gas（账户或 Paymaster → Bundler）
```

## 4. 落地场景

- **无 Gas 引导**：应用赞助新用户首笔交互
- **游戏 / 社交**：减少反复签名
- **社交恢复**：可信联系人协助找回账户
- **批量交易**：一笔 UserOp 多步操作
- **Session keys**：在权限范围内自动化重复操作
- **稳定币付费**：用 USDC 等付手续费

## 5. 生态演进

### ERC-6900：模块化智能账户

Alchemy、Circle 等推动的插件 / 执行 / 验证钩子标准，偏「意见化」模块框架；部分场景（链下开关模块、签名聚合等）开发者会选更极简的替代方案。

### EIP-7702：给现有 EOA 临时智能能力

随 2025-05 Pectra 上线：EOA 可临时执行合约代码，获得批量交易、赞助 Gas 等能力，**无需部署新智能钱包地址**。

- 与 4337 **互补而非替代**
- 可复用现有 Bundler / Paymaster 基础设施
- Ambire、Trust Wallet 等已支持

## 6. 开发者怎么上手

- **应用侧**：选智能账户实现 → 接 Bundler → 可选配置 Paymaster
- **钱包侧**：实现符合标准的账户（尤其 `validateUserOp`）并对接 EntryPoint
- 主网及 Arbitrum、Optimism、Base、Polygon 等 L2 均已可用

## 参考

- [What is ERC-4337? (Alchemy)](https://www.alchemy.com/overviews/what-is-account-abstraction)
