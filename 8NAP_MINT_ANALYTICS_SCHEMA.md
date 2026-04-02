# 8NAP Mint Analytics Schema

## Purpose

This spreadsheet is the canonical analytics system for tracking all mints across 8NAP ART projects.

Its goals:
- Normalize ERC721 and ERC1155 mint behavior
- Accurately track collector mints, house mints, and phase activity
- Support a dashboard for historical comparison and decision-making
- Remain extensible and debuggable long-term

Explicitly **out of scope**:
- Secondary sales
- Off-chain ETH payments
- Wallet-level profit analysis

---

## High-Level Tab Overview

| Tab Name | Role | Editable | Notes |
|--------|------|---------|------|
| Raw Imports | Source-of-truth mint data | Append-only | Never edit historical rows |
| Mint Master | Normalized working table | No | Formula-driven only |
| Projects | Project metadata | Yes (rare) | Canonical project list |
| Project Phases | Phase timing rules | Yes (rare) | Drives phase classification |
| Wallet Roles | Wallet classification | Yes | Used to detect house mints |
| Dashboard | Human-readable metrics | No upstream formulas | Presentation layer |

---

## Core Concepts

### ProjectKey Rules

ProjectKey uniquely identifies a mintable unit.

- **ERC721**
  - `ProjectKey = contract address`
- **ERC1155**
  - `ProjectKey = contract address:tokenId`
  - Each tokenId is treated as its own sub-collection for phase logic

---

## Raw Imports Tab

### Role
Immutable source data representing **all known mint events**.

This is the only tab where missing mints are ever manually added.

### Rules
- Append-only
- Never reorder columns
- Never edit past rows
- ETHPrice reflects **only ETH in that transaction**

### Schema

| Column | Meaning |
|------|--------|
| DateUTC | UTC timestamp of mint |
| ProjectKey | Contract (721) or contract:tokenId (1155) |
| Collection | Human-readable collection name |
| Standard | erc721 or erc1155 |
| Quantity | Units minted in tx (can be >1 for 1155) |
| MinterWallet | Wallet receiving token |
| ETHPrice | ETH paid in this tx only |
| TokenID | Token ID |
| Contract | Contract address |
| TxHash | Transaction hash |
| BlockNumber | Block number |
| LogIndex | Event index within tx |
| Source | bot-script \| monthly-csv \| manual-backfill |

---

## Mint Master Tab

### Role
Normalized working table derived entirely from Raw Imports.

No manual edits allowed.

Each row represents a **mint event**, not supply.

### Derived Concepts

- **MintPhase**
  - Derived by matching DateUTC against Project Phases
- **House Mint**
  - ETHPrice = 0 OR wallet appears in Wallet Roles
- **Collector Mint**
  - Quantity minus house units

---

## Projects Tab

### Role
Canonical metadata for each project or sub-project.

Each row represents a **single ProjectKey**.

---

## Project Phases Tab

### Rule

`StartUTC ≤ DateUTC < EndUTC`

---

## Dashboard Metrics

- Collector Mints = Non-house units
- House Mints = ETHPrice = 0 or wallet-role mints
- % Minted = Collector Mints / Total Pieces
- Avg Daily Mints = Collector Mints / Days Live

---

## End of Schema
