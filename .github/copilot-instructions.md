<!-- Copilot instructions for 8nap-mint-bot -->
# 8nap-mint-bot — AI coding instructions

Short, actionable guidance for AI agents working on this repository.

- **Big picture:** This is a single-process Node.js Discord bot (entry: `index.js`) that watches Ethereum logs (via an RPC HTTP provider) to record mints to append-only monthly CSV ledgers and post CSVs to a Discord channel. Contract list and Discord channel IDs live in `config.json`. Persistent runtime state and ledger CSVs are stored under `data/` (defaults to a local `data/` directory; in deployments a volume should mount to `/data`).

- **Key files:**
  - `index.js`: main program; contains provider setup, ABI definitions, ledger logic, Discord interactions, and state handling.
  - `config.json`: list of tracked collections and channel IDs. Add or update collections here.
  - `package.json`: dependency list (discord.js, dotenv, ethers); no `start` script is provided.

- **How to run (local/dev):**
  1. Install deps: `npm install`
 2. Create a `.env` with at minimum:
```bash
DISCORD_BOT_TOKEN=your_token_here
RPC_HTTP_URL=https://eth-mainnet.alchemyapi.io/v2/XXX
# optional: POLL_MS, CONFIRMATIONS, MAX_BLOCK_RANGE, DATA_DIR
```
 3. Run: `node index.js`

- **Important environment variables and defaults:**
  - `DISCORD_BOT_TOKEN` (required) — Bot token.
  - `RPC_HTTP_URL` (required) — JSON-RPC HTTPS endpoint.
  - `POLL_MS` (default `15000`) — poll interval.
  - `CONFIRMATIONS` (default `2`) — confirmations to wait for reorg safety.
  - `MAX_BLOCK_RANGE` (default `5`) — max blocks queried per poll (keeps Alchemy usage low).
  - `DATA_DIR` (default `./data`) — persistent storage root. The agent should use this path for state and ledger files.

- **Persistence and data layout (important to respect):**
  - Per-contract state: `data/state/{lowercased_contract_address}.json` (created via `stateFileFor()` / `loadState()` / `saveState()`). Do not change filename scheme.
  - Ledger CSVs: `data/ledger/mints-YYYY-MM.csv` (created/updated via `appendMintToLedger()` and `ensureLedgerHeader()`).
  - Ledger post tracking: `data/state/ledger_post_state.json`.

- **Patterns & conventions to follow when editing code:**
  - Keep work in `index.js` minimal and consistent — the project is intentionally single-file; prefer small, focused edits rather than large refactors unless requested.
  - When adding collections, update `config.json` entries with keys: `name`, `artist`, `standard` (`erc721` or `erc1155`), `contractAddress`.
  - State pruning behavior: `saveState()` prunes `processed` to ~3000 keys if >6000; preserve that logic when modifying state storage.
  - Networking helpers use short timeouts and retries (`retryAsync()` with exponential-ish delay). Keep the existing retry semantics.

- **Discord interactions worth noting:**
  - Slash command `/ledgercsv` is implemented in `interactionCreate` to return monthly CSVs. The bot defers replies for longer work.
  - `postLedgerCsvForMonth(monthKey, channelId)` posts a CSV file to a channel; it uses a `rateLimiter.send()` helper that waits ~1.2s between messages.

- **Ethereum / Web3 specifics:**
  - Uses `ethers` JsonRpcProvider (polling-first). ABI fragments are defined inline for `ERC721`, `ERC1155`, and auction contracts. When adding contract-specific logic, reuse these ABIs or extend them in the same style.
  - Metadata fetching: `loadMetadata()` normalizes `ipfs://` and handles base64 data URIs; `fix1155Uri()` fills `{id}` placeholders with 64-hex padding.

- **Debugging and common checks:**
  - If the bot exits immediately, check required envs: `DISCORD_BOT_TOKEN` and `RPC_HTTP_URL`.
  - For missing ledger files, look under `data/ledger/` (files named `mints-YYYY-MM.csv`).
  - Check `data/state/` for per-contract JSON to inspect `lastProcessedBlock`, `pendingAuctions`, and `processed` maps.

- **When modifying behavior or adding features:**
  - Keep migration-safe reads/writes: `loadState()` is defensive (migrates legacy `pendingAuction`). If you add new state fields, make `loadState()` tolerant to missing fields.
  - Avoid adding heavy dependencies; this repo is small and runs in constrained hosting (e.g., Railway). If adding a start script, update `package.json` and mention it in PR description.

- **No tests in repo:** `package.json` has no meaningful `test` script. If you add tests, include instructions for running them in `package.json` scripts.

If any part of the runtime assumptions or deployment setup is missing (for example, specific hosting or volume mount instructions), tell me what you want included and I'll refine these instructions.
