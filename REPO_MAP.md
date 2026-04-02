# REPO_MAP.md

## Purpose

This document is a quick orientation map for the 8NAP bot repository.

Use it to understand:
- where the important logic lives
- what files are safe to change
- what parts of the system are easy to break
- how bot behavior is divided between mint and sales monitoring

This is not the full architecture history. That belongs in `8NAP_BOT_Handoff.md`.

---

## Core Files

## `index.js`

Primary bot logic lives here.

This file currently contains:
- startup flow
- Discord client lifecycle
- slash command registration
- mint polling
- sales polling
- state load/save helpers
- ledger helpers
- marketplace matchers
- Discord posting helpers

Because this file is large, changes should be narrow and well targeted.

## `config.json`

Main runtime configuration.

Holds:
- mint-monitored collections
- sales-monitored collections
- collection metadata
- feature/config toggles used at runtime

Important:
- mint monitoring config and sales monitoring config are not the same thing
- do not assume removing a collection from one means removing it from the other

## `package.json`

Project scripts and package metadata.

Includes the diff review helper script entry:
- `review:diff`

## `scripts/review-diff.sh`

Generates `current-diff.md` for external code review before commit/push.

## `8NAP_BOT_Handoff.md`

Current architecture handoff and recent decision history.
Treat this as source of truth before making non-trivial changes.

---

## Runtime Subsystems

## Mint polling

Purpose:
- detect mint activity for configured mint-monitored collections

Typical pieces involved:
- mint collection config
- startup mint state initialization
- `pollOnce()`
- mint state persistence
- mint ledger / CSV-related helpers

Guardrail:
- do not touch mint polling when working on sales unless explicitly required

## Sales polling

Purpose:
- detect live secondary sales for collections in `config.sales.collections`

Typical pieces involved:
- sales state initialization near head
- `pollSalesOnce()`
- generic onchain sales detection path
- processed-state dedupe
- Discord sale posting

Guardrail:
- do not assume historical backfill is intended
- do not assume Alchemy is fully trustworthy
- preserve working onchain sales behavior

---

## State and Persistence

The bot persists runtime data under the data directories ensured at startup.

Important persistent concerns:
- per-collection state
- processed sale keys
- mint ledgers / monthly CSVs
- temp/generated artifacts are separate from runtime state

If changing state logic:
- be explicit about what is loaded
- be explicit about what is saved
- be careful not to create replay or skip bugs

---

## Safe vs Dangerous Changes

## Usually safe

- config-only collection additions
- narrow logging adjustments
- isolated helper improvements
- sales-only changes that do not touch mint flow
- review workflow/documentation updates

## Dangerous

- broad refactors inside `index.js`
- changing startup sequencing
- changing state persistence without understanding migration effects
- touching mint and sales logic together without reason
- mass-deleting collection references
- widening onchain sales logic into unsupported sale shapes without validation

---

## Collection Configuration Model

## Mint collections

Used by mint polling and mint-state initialization.

## Sales collections

Used by sales polling and sales-state initialization.

A collection can appear in both, but the two purposes are separate.

Example use cases:
- remove a collection from mint monitoring but keep it in sales monitoring
- add a collection to sales monitoring without changing mint monitoring

---

## Current Sales Architecture Snapshot

The current trusted sales model is:

- live monitoring near head
- no default backfill
- generic onchain ERC-721 detection for supported sales-monitored ERC-721 collections
- narrow onchain ERC-1155 detection for supported single-token-ID sale transactions
- Seaport/OpenSea-style marketplace detection
- ETH/WETH price decoding for supported sale shapes
- Discord sale posting after dedupe

If changing this, update `SALES_MONITORING_SPEC.md`.

---

## Review Workflow Map

Before commit/push:
1. make the change
2. run `bash scripts/review-diff.sh`
3. review `current-diff.md`
4. only then commit/push

`current-diff.md` is generated and gitignored.

---

## Practical Rules for Future Changes

- prefer parameterizing working logic over duplicating it
- preserve collection-driven behavior
- keep logs useful, not noisy
- remove temporary debugging once the issue is validated
- keep diffs small enough to review cleanly

---

## When to Update This Doc

Update this map only when:
- file locations change materially
- a new important subsystem is added
- repo workflow changes materially
- the mint/sales boundary changes materially
