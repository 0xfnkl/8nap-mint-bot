# BOT_RUNBOOK.md

## Purpose

This document is the operational runbook for the 8NAP bot.

Use it to:
- operate the bot safely
- validate startup and runtime health
- review code changes before commit/push
- troubleshoot the most common deployment and polling issues

This is not the full architecture history. That belongs in `8NAP_BOT_Handoff.md`.

---

## Core Principles

- Make narrow changes.
- Treat `8NAP_BOT_Handoff.md` as source of truth for current architecture and recent decisions.
- Do not let Codex broaden scope without explicit instruction.
- Review diffs before commit and push.
- Prefer behavior changes first, cleanup second.
- For sales, prioritize live monitoring over historical backfill unless explicitly doing a manual backfill workflow.

---

## Daily Development Workflow

### Standard loop

1. Define the exact change.
2. Ask Codex to implement it narrowly.
3. Before commit, have Codex generate `current-diff.md`.
4. Send `current-diff.md` to external reviewer.
5. Review the diff.
6. Commit only after review.
7. Push.
8. Confirm Railway deploy and healthy startup logs.

### Required Codex ending

Use this in future Codex prompts:

```text
Before finishing, run bash scripts/review-diff.sh and use current-diff.md as the reviewer handoff artifact. Do not commit or push.
```

---

## Review Diff Workflow

### Purpose

Avoid reviewing changes by screenshot.

### Files

- `scripts/review-diff.sh`
- `current-diff.md`
- `package.json` script: `npm run review:diff`

### How to generate the review artifact

Run:

```bash
bash scripts/review-diff.sh
```

or:

```bash
npm run review:diff
```

This overwrites `current-diff.md` with:
- a short markdown header
- timestamp
- command used
- current uncommitted diff in a fenced `diff` block

### Notes

- `current-diff.md` is gitignored.
- Do not commit `current-diff.md`.
- Always regenerate it after Codex edits and before asking for review.

---

## Deployment Workflow

### Expected normal flow

- Commit to `main`
- Push to GitHub
- Railway should deploy from the connected `main` branch

### If Railway does not auto-deploy

First check:
1. Railway service is connected to the correct repo
2. production branch is `main`
3. `Wait for CI` is off unless intentionally used

If settings look correct and auto-deploy still does not trigger:
1. disconnect the GitHub source for the service
2. reconnect the same repo
3. reselect `main`
4. verify env vars remain intact
5. push a tiny test commit or use the next real commit to verify automatic deploy resumes

### Manual deploy fallback

If needed, use Railway's deploy latest commit action for the service.

---

## What Healthy Startup Looks Like

## Mint side

You should see:
- config loaded and validated
- provider constructed
- Discord login succeeds
- slash commands registered
- `startPolling()` runs
- `initializeStateToHeadIfEmpty` runs for mint-monitored collections
- `pollOnce()` runs for mint-monitored collections
- recurring mint poll interval starts

Typical healthy signals:
- `[startup] config loaded successfully`
- `✅ Discord bot logged in as ...`
- `[startup:startPolling] entering startPolling()`
- `[pollOnce] collection=...`

## Sales side

You should also see:
- `initializeSalesStateNearHead` for each sales-monitored collection
- immediate `pollSalesOnce()`
- recurring sales poll interval started
- each sales collection being checked with a block window
- cursor advance for each sales collection

Typical healthy signals:
- `[startup:startPolling] before initializeSalesStateNearHead collection=...`
- `[startup:startPolling] before first immediate pollSalesOnce()`
- `[sales] checking collection=... fromBlock=... toBlock=... safeHead=... lagBlocks=...`
- `[sales] cursor advance collection=...`
- `[startup:startPolling] recurring sales poll interval started`

---

## Current Intended Monitoring Split

## Mint monitoring

Mint monitoring is driven by the main mint collection configuration and mint poller flow.

## Sales monitoring

Sales monitoring is driven by `config.sales.collections`.

Sales behavior is intentionally separate from mint behavior.

### Current sales expectations

- live monitoring only
- no default historical backfill
- cursor initializes near head
- existing cursors advance sequentially and do not skip unchecked blocks by default
- sales polling uses `SALES_MAX_BLOCK_RANGE`, default `250`
- onchain ERC-721 sales detection is the runtime path for supported sale shapes
- narrow onchain ERC-1155 sales detection supports single-token-ID sale transactions
- Discord posting should occur for newly detected sales
- `/status` includes sales cursor, safe head, lag, and lag status

---

## Common Troubleshooting

## Problem: `/holders` cannot generate a snapshot

Check:
- `ALCHEMY_NFT_API_KEY` is configured separately from `RPC_HTTP_URL`
- startup/runtime logs for the structured `[holders]` failure category
- whether another holder export is already active (the command permits one at a time)
- Alchemy authentication, rate-limit, or service health

`/holders` uses Alchemy NFT API v3 as its only ownership source. It retries bounded temporary failures, but it will not generate partial/empty CSVs and will not fall back to historical transfer-log reconstruction. Supported modes are ERC-721 whole contract, ERC-1155 whole contract, and ERC-1155 specific token ID. Metadata filtering is not currently supported.

## Problem: mint polling works but sales polling does not appear in logs

Check:
- whether `pollSalesOnce()` is wired into startup
- whether recurring sales poll interval is running
- whether `config.sales.enabled` is true

Healthy sign:
- logs should show `before first immediate pollSalesOnce()`

## Problem: bot misses a recent sale

First determine which of these is true:
1. sales poller did not run
2. sales cursor was too far behind
3. collection was not in `sales.collections`
4. onchain detection did not classify the sale
5. sale was deduped as already processed

For live monitoring, first inspect:
- current sales block window
- cursor state
- `/status` sales monitoring health
- whether collection is sales-monitored
- whether sale shape is supported by the current onchain path

## Problem: sales cursor is far behind head

Use `/status` to inspect each sales-monitored collection's `salesCursor`, `safeHead`, `lagBlocks`, and status.

Lag thresholds:
- `SALES_LAG_ALERT_BLOCKS=500`
- `SALES_HARD_LAG_ALERT_BLOCKS=2000`

Lag alerts post to admin channel `1432785087828852776`. The alert means no blocks have been skipped; the sales cursor is behind and the bot is still checking sequentially.

Preferred recovery:
- Run `/salescatchup` to process sales ranges sequentially without skipping.
- Use `collection` to target one collection, or omit it to catch up all sales-monitored collections.
- Use `max_batches` to bound RPC work. Each batch uses `SALES_MAX_BLOCK_RANGE`.
- Use `dry_run: true` to preview ranges without mutating sales state or posting sales.

Emergency-only recovery:
- Run `/salesfastforward` only when willing to skip unchecked sales blocks.
- It requires confirmation text `yes`, case-insensitive.
- Use collection `ALL` to fast-forward every sales-monitored collection.
- It only changes sales state for the selected collection, or all sales-monitored collections when `ALL` is used, and posts an audit message to admin channel `1432785087828852776`.

`SALES_MAX_BLOCK_RANGE` must be high enough to cover expected blocks produced between sales polls. With a 30 minute `SALES_POLL_MS`, a 10-block range will naturally fall behind; the default 250-block range is intended to keep up with normal Ethereum block production while leaving buffer.

## Problem: Railway deploys only when manually triggered

Likely causes:
- stale GitHub integration state
- repo/source wiring drift
- Railway not responding to push events

Recommended fix:
- disconnect and reconnect GitHub source for the service

## Problem: video NFT Discord post has no image

Check:
1. Confirm whether `metadata.image` or `animation_url` is actually a video URL.
2. Confirm a poster image exists at `media-posters/<lowercase-contract-address>/<token-id>.<ext>`.
3. Confirm `config.json` has a matching `mediaPosters` entry for that contract/token ID.
4. Confirm `mediaPosterBaseUrl` points to the raw GitHub `media-posters` path.
5. Confirm the poster file was committed and pushed to `main`.
6. Open the raw GitHub poster URL directly to confirm it is reachable.
7. If no poster exists, the bot should still post the mint/sale, but it may only show the video link fallback.

Review reminder:
- When adding poster files, make sure both `config.json` and the poster image files are staged and committed together. Do not commit config pointing to poster files that are not yet in the repo.

---

## Operational Guardrails for Codex

When changing the bot:
- do not touch mint polling unless the task is specifically about mint polling
- do not mass-delete collection references
- do not overgeneralize working logic
- do not refactor broad architecture unless explicitly instructed
- prefer parameterization over duplication
- keep diffs small
- preserve logs that are operationally useful
- remove only temporary debug instrumentation after validation

---

## What to Review Before Commit

For every non-trivial change, review:
- config impact
- state persistence impact
- startup/runtime wiring
- whether the change broadens scope accidentally
- whether working sales/mint behavior is preserved
- whether review artifact (`current-diff.md`) matches Codex's summary

---

## Known Good Current Patterns

- narrow config-only collection additions when possible
- sales-only changes isolated to sales flow
- generic ERC-721 onchain sales detection for sales-tracked ERC-721 collections
- live near-head sales cursor initialization
- external diff review before commit/push

---

## When to Update This Doc

Update this runbook only when operational truth changes, such as:
- deployment workflow changes
- review workflow changes
- startup health signals change materially
- sales or mint polling lifecycle changes materially
