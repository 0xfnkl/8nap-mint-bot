# SALES_MONITORING_SPEC.md

## Purpose

This document defines how secondary sales monitoring is intended to work in the 8NAP bot.

It exists so future changes do not reintroduce incorrect assumptions about:
- Alchemy reliability
- historical backfill
- supported sale shapes
- marketplace scope
- price decoding behavior

---

## Design Intent

The sales system is for **live monitoring of secondary sales as they happen**.

It is not intended to be a full historical indexer by default.

Primary goals:
- detect supported live sales reliably
- post newly detected sales to Discord
- persist enough state to avoid duplicate posts
- stay narrow and debuggable

---

## High-Level Flow

For each collection in `config.sales.collections`:

1. load sales state
2. determine current safe head
3. derive sales block window from cursor to safe head
4. run the trusted onchain detection path for supported collections
5. normalize sale rows
6. dedupe against processed state
7. post new sales to Discord
8. persist updated sales state

---

## Live Monitoring, Not Historical Backfill

### Intended default behavior

Sales monitoring starts near the current safe head.

If state is missing or stale, the sales cursor is initialized or fast-forwarded near head instead of crawling through old history.

### Why

The bot's goal is to record sales as they happen, not backfill weeks or months of old sales before becoming useful.

### Consequence

If the bot is down for a long time, old missed sales outside the live near-head window are intentionally skipped.

That is acceptable for this system's intended use.

---

## Current Source Strategy

## Trusted path

The trusted runtime path for supported collections is the reusable **onchain detection path**.

This onchain path is the canonical sales detection system for supported sale shapes.

---

## Onchain Eligibility

A collection is eligible for the current onchain sales detection path when:
- it is in `config.sales.collections`
- it has a non-empty `contractAddress`
- and one of these supported standards/shapes applies:
  - `erc721`
  - `erc1155` with a sale transaction that resolves to exactly one token ID

---

## Supported Sale Shapes

The current onchain sales path intentionally supports only a narrow set of sale shapes:

- ERC-721 transfer-based sale candidates
- ERC-1155 transfer-based sale candidates that resolve to exactly one token ID in the transaction
- Seaport/OpenSea-style marketplace detection using receipt/log matching
- ETH-denominated sales detected from `tx.value`
- WETH-denominated sales detected from WETH `Transfer` logs in the matched receipt

For the supported ERC-1155 shape:
- the full receipt NFT transfer context must stay consistent with that one tracked ERC-1155 token sale
- post one sale for the token ID
- quantity is the total quantity transferred for that token ID in the transaction
- price is the total ETH/WETH paid for that token transaction
- do not divide price per unit
- do not post one message per unit

This is deliberate. Narrow and correct is better than broad and flaky.

---

## Unsupported or Intentionally Deferred

The current system does **not** attempt to fully support:

- ERC-1155 sales where multiple token IDs are involved and price attribution is ambiguous
- ERC-1155 sales where the receipt includes additional NFT asset transfers that make full-tx price attribution ambiguous
- non-Seaport marketplace detection beyond the currently recognized matcher scope
- broad multi-currency pricing
- ambiguous transaction shapes where sale classification is not confident
- full historical backfill as the default runtime behavior
- off-chain sale reconciliation

When the system cannot classify confidently, it should skip rather than guess.

---

## Marketplace Scope

Current trusted marketplace scope is effectively:
- Seaport/OpenSea-style onchain sale patterns recognized by known marketplace matcher logic

This is narrower than “all NFT marketplaces”.

That is intentional.

---

## Price Decoding

### Goal

Discord sales posts should display price like:

`Price: 0.113 ETH ($246.57)`

### Supported decoding

For supported onchain sales:
- if `tx.value > 0`, treat it as ETH sale price
- otherwise, sum WETH `Transfer` logs from the buyer to derive WETH amount

### USD value

If the sale currency is ETH or WETH:
- use the bot's ETH/USD price mechanism
- display USD with 2 decimals

### Fallback display behavior

- if native price is unavailable: show unavailable
- if native price exists but USD is unavailable: show native only
- if currency is not ETH/WETH: show native only

---

## Normalized Sale Record Expectations

A usable normalized sale row should include, at minimum:
- collection name
- artist
- standard
- contract
- token ID
- quantity
- seller wallet
- buyer wallet
- transaction hash
- block number
- marketplace
- `salePriceNative`
- `currencySymbol`

The normalized shape should remain consistent across detection paths.

---

## Dedupe and Processed State

Newly detected sales must be deduped using persisted processed state.

Goals:
- do not repost the same sale
- survive restarts without replaying already-posted sales
- keep state handling deterministic and easy to inspect

---

## Discord Posting

New sales that survive dedupe should be posted to Discord.

Current expectations:
- supported collection name and metadata
- token reference
- quantity for ERC-1155 sales
- buyer and seller display
- marketplace reference
- price line with native and USD when available

---

## Logging

Operational logs should remain useful but not noisy.

Keep:
- poll start/skip
- checked block window
- cursor advance
- onchain candidate counts
- matched candidate counts
- real errors

Remove:
- one-off target-specific debug instrumentation once validation is complete

---

## Configuration Expectations

Sales-monitored collections belong in:

`config.sales.collections`

This is separate from mint monitoring configuration.

A collection may be:
- mint-monitored
- sales-monitored
- both
- or only one of the two

Do not assume the two lists serve the same purpose.

---

## Change Guidelines

When extending the sales system:
- prefer generic collection-driven logic over collection-specific branches
- preserve working ERC-721 onchain behavior
- do not broaden marketplace scope casually
- do not add historical backfill as default runtime behavior
- keep unsupported paths explicitly unsupported until intentionally implemented

---

## When to Update This Doc

Update this spec only when sales monitoring truth changes materially, such as:
- onchain eligibility changes
- marketplace support changes
- pricing support changes
- state/cursor behavior changes
- Discord posting expectations change
