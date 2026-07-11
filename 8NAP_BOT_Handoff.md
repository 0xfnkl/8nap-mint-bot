# 8NAP Mint Bot (Discord + Ledger) Handoff

## What this bot does
A Node.js Discord bot that:
1) Polls Ethereum logs for configured NFT contracts (ERC721 + ERC1155).
2) Posts mint alerts to a Discord “mints” channel.
3) Posts auction lifecycle alerts (piece revealed, first bid, new bid, auction ended) to a Discord “auction” channel for auction-based collections.
4) Writes every detected mint into a monthly CSV ledger on a persistent Railway volume.
5) On the 1st of each month, posts the previous month’s CSV into a Discord channel (“ledger-csv”).
6) Provides slash commands for ledger downloads and fresh NFT holder snapshots.

This is designed to be robust and restart-safe via persisted state on `/data`.

---

## Temporary Note
Redeploy trigger after Railway initialization stall.

---

## Repo structure (root)
- `index.js`                Main entry point and all bot logic
- `config.json`             Discord channel IDs + collections list
- `package.json`            Dependencies, main file
- `package-lock.json`       Locked dependency versions
- `media-posters/`          Repo-hosted poster images for video NFT Discord embeds
- `scripts/review-diff.sh`  Generates `current-diff.md` for external review
- `.env`                    Local only (NOT committed)
- `.github/copilot-instructions.md` (optional notes)

Railway runs Node (Railpack/Nixpacks). No custom start command is set. Recommended: add `"start": "node index.js"`.

---

## Review diff workflow
- Run `bash scripts/review-diff.sh` from repo root before external review or before finishing a Codex task.
- Optional alias: `npm run review:diff`
- This overwrites `current-diff.md` with the current uncommitted diff in Markdown format.
- `current-diff.md` is gitignored and should not be committed.
- Reusable Codex prompt snippet:
  `Before finishing, run bash scripts/review-diff.sh and use current-diff.md as the reviewer handoff artifact.`

---

## Config (`config.json`)
Top-level fields:
- `discordChannelId`        Discord channel for mint posts
- `auctionChannelId`        Discord channel for auction posts
- `mediaPosterBaseUrl`      Optional base raw URL for Discord poster images
- `mediaPosters`            Optional contract/token poster filename map for video NFT media
- `collections[]` list entries:
  - `name`
  - `artist`
  - `standard` (`erc721` or `erc1155`)
  - `contractAddress`

To add/remove a collection: edit `config.json`, commit, deploy.

---

## Discord media rendering for video NFTs
Mint and sales Discord embeds use shared media resolution logic for NFT media.

- Discord embed images should only receive actual image URLs.
- Video metadata should not be passed directly to `embed.setImage(...)`.
- The helper checks common metadata fields including `image`, `image_url`, `animation_url`, `animationUrl`, `animation`, and `media`.
- If metadata resolves to a real image, the bot uses it in `embed.setImage(...)`.
- If metadata resolves to video and a configured poster exists, the bot uses the poster image in `embed.setImage(...)`.
- If video media exists, the bot may add a `Media: View video` field.
- If no valid image and no poster exists, the bot still posts the mint/sale and falls back to video link behavior.

Poster files live in:

```text
media-posters/<lowercase-contract-address>/<token-id>.<ext>
```

`config.json` uses:
- `mediaPosterBaseUrl`: raw base URL for poster images
- `mediaPosters`: lowercase contract address -> token ID -> poster filename

The final poster URL is:

```text
<mediaPosterBaseUrl>/<lowercase-contract-address>/<filename>
```

This is presentation-only. It does not affect ledger rows, mint detection, sales detection, polling, or persisted state.

For future video tokens, add a poster file and a matching `mediaPosters` entry. If token metadata already provides a real image URL, no poster is needed.

---

## Railway environment variables (names)
- `DISCORD_BOT_TOKEN`       Discord bot token
- `GUILD_ID`                Guild for registering slash commands (guild-scoped)
- `RPC_HTTP_URL`            Ethereum RPC URL (Alchemy)
- `ALCHEMY_NFT_API_KEY`     Dedicated Alchemy NFT API key used only by `/holders`
- `DATA_DIR`                Must be `/data` (Railway volume mount)
- `POLL_MS`                 Poll interval ms (example 60000)
- `CONFIRMATIONS`           Confirmation depth (example 2)
- `MAX_BLOCK_RANGE`         Max block span per fetch (example 10)

---

## Persistent volume layout (`/data`)
The bot persists state and ledgers here. Key folders/files:

- `/data/state/`
  - `<contractAddress>.json`
  Per-contract state including last processed block and other tracking needed for dedupe and auction logic.

- `/data/ledger/`
  - `mints-YYYY-MM.csv`
  Monthly CSV ledger files (append-only per month).

- `/data/state/ledger_post_state.json`
  Tracks which monthly CSV has already been posted so the bot doesn’t double-post on restarts.

- `/data/state/eth_price_usd.json`
  Cached ETH/USD price used ONLY for Discord display. Not written into the ledger.

If the volume is missing or `DATA_DIR` is wrong, the bot may “work” but will not persist correctly across deploys.

---

## Ledger CSV format
Columns:
- `DateUTC`
- `ProjectKey`
- `Collection`
- `Standard`
- `Quantity`
- `MinterWallet`
- `ETHPrice`
- `TokenID`
- `Contract`
- `TxHash`
- `BlockNumber`
- `LogIndex`

Notes:
- Ledger stores ETH values only (no USD).
- ERC1155 rows may represent multi-quantity mints.
- The code contains logic to correctly compute ETH for multi-mint transactions (ERC721 per-token split; ERC1155 total spend per row).

---

## Slash command
- `/ledgercsv` with optional `month` (YYYY-MM)
Returns `mints-YYYY-MM.csv` from `/data/ledger`.

- `/holders contract:<address>` exports a current ERC-721 or ERC-1155 whole-contract snapshot.
- `/holders contract:<address> token_id:<id>` exports one ERC-1155 token ID. ERC-721 token-specific exports are rejected.

`/holders` uses Alchemy NFT API v3 `getOwnersForContract` with token balances for every supported mode. Token-specific ERC-1155 snapshots include only balances matching the requested token ID. The CSV contains exactly `wallet,quantity`, where quantity is collection-wide NFT count for ERC-721, total units across token IDs for whole-contract ERC-1155, or units of the selected ERC-1155 token.

Holder snapshots do not persist ownership state and do not reconstruct ownership from historical transfer logs. Alchemy is the only ownership source: incomplete, empty, malformed, timed-out, or failed API results produce no CSV and have no onchain fallback. Metadata and trait filtering are intentionally out of scope.

---

## Auction behavior (Issues + Metamorphosis)
The bot listens for the auction contract’s events and posts:
- New Piece Revealed
- Auction Started (First Bid)
- New Bid Placed
- Auction Ended

The hardest part is correct token mapping (auction “current token” vs timing). The code uses a “best source of truth at this block” approach and stores per-contract state so restarts don’t break sequencing.

Known edge cases:
- Bids and reveals can happen close together.
- Auction settlement transactions may have 0 value and/or misleading OpenSea labels.
- Token numbering can be 0-based vs 1-based; the code includes handling for tokenId base logic.

---

## How polling works (high level)
- Runs every `POLL_MS`
- For each configured contract:
  - Loads persisted state
  - Fetches logs in a bounded block range
  - Parses logs by standard (ERC721 Transfer mint, ERC1155 TransferSingle/TransferBatch mint, plus auction events for auction collections)
  - Dedupe is handled via stored “processed” keys (txHash + logIndex)
  - Appends ledger row + posts Discord message

---

## Operating rules
- Do not store secrets in git. Railway vars are source of truth.
- Always keep `DATA_DIR=/data` so the volume is used.
- When debugging, confirm `/data/state` and `/data/ledger` are being written (Railway logs print volume checks on boot).

---

## Common troubleshooting
1) Bot posts but ledger is empty after deploy:
   - `DATA_DIR` wrong or volume not mounted.
2) `/ledgercsv` says file not found:
   - No mints yet for that month OR ledger directory path mismatch.
3) USD missing in Discord posts:
   - ETH/USD cache not yet refreshed; cache is stored in `/data/state/eth_price_usd.json` and updates on heartbeat.
4) Multi-mint tx shows wrong ETH:
   - Ensure tx.value splitting logic is enabled (ERC721 per token; ERC1155 total spent).

---

## Cost/volume expectations
- Storage growth is mainly monthly CSVs + small JSON state files.
- CSV size is tiny for typical mint volumes.
- Removing a collection reduces polling calls and log parsing work slightly, but the biggest cost driver is polling frequency + RPC usage, not disk.
