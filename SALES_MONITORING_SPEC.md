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
4. try the normal sales source
5. if needed, run the trusted onchain ERC-721 fallback
6. normalize sale rows
7. dedupe against processed state
8. post new sales to Discord
9. persist updated sales state

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

## Alchemy

Alchemy may still be queried, but it is **not trusted as sole truth source**.

Reason:
- it proved stale/unreliable for live sales detection in practice

Do not assume that a zero or incomplete Alchemy result means no sale occurred.

## Trusted path

The trusted path for supported collections is the reusable **onchain ERC-721 fallback**.

This fallback is the system that should be trusted for supported sale shapes when the normal source is empty or unusable.

---

## Fallback Eligibility

A collection is eligible for the generic sales fallback when:
- it is in `config.sales.collections`
- its `standard` is `erc721`
- it has a non-empty `contractAddress`

ERC-1155 collections are intentionally not covered by the current fallback.

---

## Supported Sale Shapes

The current generalized fallback intentionally supports only a narrow set of sale shapes:

- ERC-721 transfer-based sale candidates
- Seaport/OpenSea-style marketplace detection using receipt/log matching
- ETH-denominated sales detected from `tx.value`
- WETH-denominated sales detected from WETH `Transfer` logs in the matched receipt

This is deliberate. Narrow and correct is better than broad and flaky.

---

## Unsupported or Intentionally Deferred

The current system does **not** attempt to fully support:

- ERC-1155 fallback sales
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

For supported fallback sales:
- if `tx.value > 0`, treat it as ETH sale price
- otherwise, for supported single-transfer sale candidates, sum WETH `Transfer` logs from the buyer to derive WETH amount

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
- fallback execution counts
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
- preserve working ERC-721 fallback behavior
- do not broaden marketplace scope casually
- do not add historical backfill as default runtime behavior
- keep unsupported paths explicitly unsupported until intentionally implemented

---

## When to Update This Doc

Update this spec only when sales monitoring truth changes materially, such as:
- fallback eligibility changes
- marketplace support changes
- pricing support changes
- state/cursor behavior changes
- Discord posting expectations change
