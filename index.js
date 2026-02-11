require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { ethers } = require("ethers");

// =========================
// Config + Env validation
// =========================

const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("❌ Missing env var: DISCORD_BOT_TOKEN");
  process.exit(1);
}
if (!process.env.RPC_HTTP_URL) {
  console.error("❌ Missing env var: RPC_HTTP_URL (Alchemy HTTPS endpoint)");
  process.exit(1);
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CHAIN = "ethereum";

const POLL_MS = Number(process.env.POLL_MS || 15000);          // 15s
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS || 2);  // reorg safety
const MAX_BLOCK_RANGE = Number(process.env.MAX_BLOCK_RANGE || 5); // <= 10 for Alchemy free constraints

// =========================
// Provider (polling-first)
// =========================

const provider = new ethers.JsonRpcProvider(process.env.RPC_HTTP_URL);

// =========================
// Persistent data dir (Railway Volume should mount to /data)
// =========================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const STATE_DIR = path.join(DATA_DIR, "state");
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR);

// Persisted ETH/USD cache (for Discord display only, not used in the ledger)
const ETH_PRICE_CACHE_PATH = path.join(STATE_DIR, "eth_price_usd.json");

function loadEthPriceCacheFromDisk() {
  try {
    if (!fs.existsSync(ETH_PRICE_CACHE_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(ETH_PRICE_CACHE_PATH, "utf8"));
    const usd = Number(parsed?.usd);
    const ts = Number(parsed?.ts);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return { usd, ts: Number.isFinite(ts) ? ts : 0 };
  } catch {
    return null;
  }
}

function saveEthPriceCacheToDisk(usd) {
  try {
    fs.writeFileSync(
      ETH_PRICE_CACHE_PATH,
      JSON.stringify({ usd: Number(usd), ts: Date.now() }, null, 2)
    );
  } catch {
    // ignore disk write errors
  }
}


function stateFileFor(address) {
  return path.join(STATE_DIR, `${address.toLowerCase()}.json`);
}

function loadState(address) {
  const fallback = {
  lastProcessedBlock: 0,
  processed: {},
  pendingAuctions: {},         // tokenIdStr -> { winner, settlementTx, amountWei }
  currentAuctionTokenId: null, // tokenIdStr
  lastBidWeiByToken: {},       // tokenIdStr -> amountWeiStr
  lastBidderByToken: {},       // tokenIdStr -> bidder address
};

  try {
    if (!address) return { ...fallback };

    const p = stateFileFor(address);
    if (!fs.existsSync(p)) return { ...fallback };

    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);

    // normalize shape
    if (typeof parsed.lastProcessedBlock !== "number") parsed.lastProcessedBlock = 0;
if (!parsed.processed || typeof parsed.processed !== "object") parsed.processed = {};

if (!parsed.pendingAuctions) parsed.pendingAuctions = {};
if (parsed.currentAuctionTokenId === undefined) parsed.currentAuctionTokenId = null;
if (!parsed.lastBidWeiByToken) parsed.lastBidWeiByToken = {};
if (!parsed.lastBidderByToken) parsed.lastBidderByToken = {};

// migrate legacy pendingAuction -> pendingAuctions if present
if (parsed.pendingAuction && parsed.pendingAuction.winner) {
  parsed.pendingAuctions["__legacy"] = parsed.pendingAuction;
}
parsed.pendingAuction = null;


    return parsed;
  } catch (e) {
    console.error(`❌ loadState failed for ${address}:`, e.message);
    return { ...fallback };
  }
}

function saveState(address, state) {
  // prune processed map to avoid disk growth
  const keys = Object.keys(state.processed || {});
  if (keys.length > 6000) {
    // keep last ~3000 by insertion order approximation
    const keep = keys.slice(-3000);
    const next = {};
    for (const k of keep) next[k] = true;
    state.processed = next;
  }
  fs.writeFileSync(stateFileFor(address), JSON.stringify(state, null, 2));
}

function seenKey(log) {
  return `${log.transactionHash}-${log.index}`;
}

// =========================
// Ledger monthly post state (separate from per-contract state)
// =========================

const LEDGER_POST_STATE_PATH = path.join(STATE_DIR, "ledger_post_state.json");

function loadLedgerPostState() {
  try {
    if (!fs.existsSync(LEDGER_POST_STATE_PATH)) return { posted: {} };
    const parsed = JSON.parse(fs.readFileSync(LEDGER_POST_STATE_PATH, "utf8"));
    if (!parsed.posted || typeof parsed.posted !== "object") parsed.posted = {};
    return parsed;
  } catch {
    return { posted: {} };
  }
}

function saveLedgerPostState(st) {
  fs.writeFileSync(LEDGER_POST_STATE_PATH, JSON.stringify(st, null, 2));
}

// =========================
// Mint ledger (append-only CSV, monthly files)
// =========================

// Ledger directory should live on the persistent volume (DATA_DIR)
const LEDGER_DIR = path.join(DATA_DIR, "ledger");
if (!fs.existsSync(LEDGER_DIR)) fs.mkdirSync(LEDGER_DIR, { recursive: true });

function monthKeyFromMs(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function ledgerPathForMonth(monthKey) {
  return path.join(LEDGER_DIR, `mints-${monthKey}.csv`);
}

function prevMonthKeyFromMs(ms) {
  const d = new Date(ms);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 1; // 1..12
  m -= 1;
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function ensureLedgerHeader(filePath) {
  if (fs.existsSync(filePath)) return;
  const header = [
    "DateUTC",
    "ProjectKey",
    "Collection",
    "Standard",
    "Quantity",
    "MinterWallet",
    "ETHPrice",
    "TokenID",
    "Contract",
    "TxHash",
    "BlockNumber",
    "LogIndex",
  ].join(",") + "\n";
  fs.writeFileSync(filePath, header);
}

function appendMintToLedger(row, timestampMs) {
  const monthKey = monthKeyFromMs(timestampMs);
  const filePath = ledgerPathForMonth(monthKey);
  ensureLedgerHeader(filePath);

  const line = [
    row.DateUTC,
    row.ProjectKey,
    row.Collection,
    row.Standard,
    row.Quantity,
    row.MinterWallet,
    row.ETHPrice,
    row.TokenID,
    row.Contract,
    row.TxHash,
    row.BlockNumber,
    row.LogIndex,
  ].map(csvEscape).join(",") + "\n";

  fs.appendFileSync(filePath, line);
}

// =========================
// Discord client + rate limit
// =========================

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const rateLimiter = {
  lastSent: 0,
  async send(channel, payload) {
    const now = Date.now();
    const dt = now - this.lastSent;
    if (dt < 1200) await new Promise((r) => setTimeout(r, 1200 - dt));
    await channel.send(payload);
    this.lastSent = Date.now();
  },
};

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "ledgercsv") return;

    // optional arg: month like "2026-01"
    const month = interaction.options.getString("month");

    const monthKey = month && /^\d{4}-\d{2}$/.test(month)
      ? month
      : monthKeyFromMs(Date.now()); // current month by default

    const filePath = ledgerPathForMonth(monthKey);

    if (!fs.existsSync(filePath)) {
      await interaction.reply({
        content: `No ledger file found for ${monthKey}.`,
        ephemeral: true,
      });
      return;
    }

   // Discord requires a file attachment object
const attachment = { attachment: filePath, name: `mints-${monthKey}.csv` };

// Acknowledge fast so Discord doesn't timeout
await interaction.deferReply({ ephemeral: true });

await interaction.editReply({
  content: `Here you go: mints-${monthKey}.csv`,
  files: [attachment],
});

  } catch (e) {
    console.error("interactionCreate error:", e?.message || e);
    console.error(e);
    // if interaction already replied, followUp, else reply
    try {
      if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
  content: "Error generating ledger CSV.",
  ephemeral: true,
});

      } else {
        await interaction.reply({
  content: "Error generating ledger CSV.",
  ephemeral: true,
});

      }
    } catch {}
  }
});

async function postLedgerCsvForMonth(monthKey, channelId) {
  const filePath = ledgerPathForMonth(monthKey);
  if (!fs.existsSync(filePath)) {
    console.log(`📄 No ledger file found for ${monthKey} at ${filePath}`);
    return false;
  }

  const channel = await client.channels.fetch(channelId);
  const { AttachmentBuilder } = require("discord.js");
  const attachment = new AttachmentBuilder(filePath, { name: `mints-${monthKey}.csv` });

  await rateLimiter.send(channel, {
    content: `Monthly mint ledger CSV for **${monthKey}**`,
    files: [attachment],
  });

  console.log(`✅ Posted ledger CSV for ${monthKey} -> channel ${channelId}`);
  return true;
}

// =========================
// ABIs
// =========================

// ERC721 mint
const ERC721_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function tokenURI(uint256 tokenId) view returns (string)",
];

// ERC1155 mint
const ERC1155_ABI = [
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "function uri(uint256 id) view returns (string)",
];

// Auction-specific (Issues + Metamorphosis)
const AUCTION_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event PieceRevealed()",
  "event NewBidPlaced((address payable bidder, uint256 amount) bid)",
  "function totalSupply() view returns (uint256)",
];

// =========================
// Helpers (metadata, ENS, price)
// =========================

async function retryAsync(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
}

function fix1155Uri(uri, tokenId) {
  const hexId = tokenId.toString(16).padStart(64, "0");
  return uri.replace("{id}", hexId).replace("{ID}", hexId);
}

function normalizeUri(uri) {
  if (!uri) return uri;

  if (uri.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  }

  if (uri.startsWith("data:application/json;base64,")) {
    const base64 = uri.slice("data:application/json;base64,".length);
    const json = Buffer.from(base64, "base64").toString("utf-8");
    const data = JSON.parse(json);
    if (data.image) return normalizeUri(data.image);
    return null;
  }

  return uri;
}

async function loadMetadata(standard, contract, tokenId) {
  try {
    let uri;
    if (standard === "erc721") {
      uri = await contract.tokenURI(tokenId);
    } else {
      uri = await contract.uri(tokenId);
      uri = fix1155Uri(uri, tokenId);
    }
    const url = normalizeUri(uri);
    if (!url) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return null;

    return await res.json();
  } catch {
    return null;
  }
}

async function formatDisplayAddress(address) {
  if (!address) return "unknown";
  let display = `${address.slice(0, 6)}...${address.slice(-4)}`;
  try {
    const ens = await provider.lookupAddress(ethers.getAddress(address));
    if (ens) display = ens;
  } catch {}
  return display;
}

// ETH price cache (Discord display only)
let cachedEthPrice = null; // number
let cacheTime = 0;         // ms since epoch for in-memory cache freshness

async function fetchEthPriceUsdFromCoinGecko() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    { signal: controller.signal }
  );

  clearTimeout(timeoutId);

  if (!res.ok) throw new Error(`coingecko http ${res.status}`);
  const data = await res.json();
  const usd = Number(data?.ethereum?.usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("coingecko bad usd");
  return usd;
}

async function getEthPriceUsd() {
  // 1) In-memory cache (fresh for 10 minutes)
  if (cachedEthPrice && (Date.now() - cacheTime) < 10 * 60 * 1000) {
    return cachedEthPrice;
  }

  // 2) Disk cache fallback (survives restarts)
  const disk = loadEthPriceCacheFromDisk();
  if (disk?.usd) {
    cachedEthPrice = disk.usd;
    cacheTime = disk.ts || Date.now(); // treat disk timestamp as cache time
  }

  // 3) Try refreshing from CoinGecko (but never fail the mint post)
  try {
    const usd = await fetchEthPriceUsdFromCoinGecko();
    cachedEthPrice = usd;
    cacheTime = Date.now();
    saveEthPriceCacheToDisk(usd);
    return usd;
  } catch (e) {
    // If API fails, return whatever we have (memory or disk). Could be null on first-ever run.
    return cachedEthPrice;
  }
}

// =========================
// Embed builders
// =========================

function openseaUrl(contractAddress, tokenId) {
  return `https://opensea.io/assets/${CHAIN}/${contractAddress}/${tokenId}`;
}

function auctionViewLink(collectionName) {
  return collectionName === "Issues"
    ? "https://8nap.art/collection/issues"
    : "https://8nap.art/collection/metamorphosis";
}

function s3Preview(collectionName, tokenIdStr) {
  if (collectionName === "Issues") {
    return `https://8nap.s3.eu-central-1.amazonaws.com/previews/74/small/${tokenIdStr}`;
  }
  if (collectionName === "Metamorphosis") {
    return `https://8nap.s3.eu-central-1.amazonaws.com/previews/107/small/${tokenIdStr}`;
  }
  return null;
}
async function previewExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}


async function postAuctionEnded(collection, tokenIdStr, winner, amountWei, txHash, blockNumber) {

  let imageUrl = null;
if (tokenIdStr !== "unknown") {
  const previewUrl = s3Preview(collection.name, tokenIdStr);
  if (previewUrl && await previewExists(previewUrl)) {
    imageUrl = previewUrl;
  }
}

  const winnerDisplay = await formatDisplayAddress(winner);
  const amountEth = ethers.formatEther(amountWei);

  let timestampMs = Date.now();
  try {
    const block = await provider.getBlock(blockNumber);
    if (block?.timestamp) timestampMs = block.timestamp * 1000;
  } catch {}

  const embed = new EmbedBuilder()
    .setTitle("Auction Ended")
    .setDescription(
      [
        `Collection: **${collection.name}**`,
        `Artist: **${collection.artist || "Unknown"}**`,
        `Piece: **#${tokenIdStr}**`,
        `Winner: **${winnerDisplay}**`,
        `Amount: **${amountEth} ETH**`,
        ``,
        `[View on 8NAP](${auctionViewLink(collection.name)})`,
        `Tx: https://etherscan.io/tx/${txHash}`,
      ].join("\n")
    )
    .setTimestamp(new Date(timestampMs))
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  const channel = await client.channels.fetch(config.auctionChannelId);
  await rateLimiter.send(channel, { embeds: [embed] });
}

// =========================
// Event processing (mints + auctions)
// =========================

async function postMint(collection, standard, contract, tokenId, to, txHash, blockNumber, logIndex, quantity, overridePriceWei = null) {
  const tokenIdStr = tokenId.toString();

  // Image + title
  let imageUrl = null;
  let title = `${collection.name} #${tokenIdStr}`;

  if (collection.name === "Issues" || collection.name === "Metamorphosis") {
    imageUrl = s3Preview(collection.name, tokenIdStr);
  } else {
    const metadata = await retryAsync(() => loadMetadata(standard, contract, tokenId));
    title = metadata?.name || title;
    if (metadata?.image) imageUrl = normalizeUri(metadata.image);
  }

// tx value (or override)
let priceEth = "0";
try {
  if (overridePriceWei != null) {
    priceEth = ethers.formatEther(overridePriceWei);
  } else {
    const tx = await provider.getTransaction(txHash);
    if (tx?.value != null) priceEth = ethers.formatEther(tx.value);
  }
} catch {}

  let priceLine = `Price: **${priceEth} ETH**`;
  const ethUsd = await getEthPriceUsd();
  if (ethUsd) {
    const usd = (parseFloat(priceEth) * ethUsd).toFixed(2);
    priceLine = `Price: **${priceEth} ETH** ($${usd})`;
  }

  // minter display
  const minterDisplay = await formatDisplayAddress(to);

  // timestamp
  let timestampMs = Date.now();
  try {
    const block = await provider.getBlock(blockNumber);
    if (block?.timestamp) timestampMs = block.timestamp * 1000;
  } catch {}

    // ===== Ledger append (disk, no extra RPC) =====
  const dateUtc = new Date(timestampMs).toISOString();

  // Stable identity:
  // - ERC721: contract
  // - ERC1155: contract:tokenId
  const contractLower = collection.contractAddress.toLowerCase();
  const projectKey = (standard === "erc1155")
    ? `${contractLower}:${tokenIdStr}`
    : contractLower;

  // Note: For ERC1155 batch mints, tx.value is total tx value, not per-token.
  // We still record it as ETHPrice for auditability.
  appendMintToLedger(
    {
      DateUTC: dateUtc,
      ProjectKey: projectKey,
      Collection: collection.name,
      Standard: standard,
      Quantity: standard === "erc1155" ? quantity.toString() : "1",
      MinterWallet: to,
      ETHPrice: priceEth,
      TokenID: tokenIdStr,
      Contract: contractLower,
      TxHash: txHash,
      BlockNumber: blockNumber.toString(),
      LogIndex: (logIndex ?? "").toString(),
    },
    timestampMs
  );

  console.log(
  `📒 Ledger append OK: ${collection.name} tokenId=${tokenIdStr} projectKey=${projectKey}`
);


  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      [
        `Collection: **${collection.name}**`,
        `Artist: **${collection.artist || "Unknown"}**`,
        `Minting Wallet: **${minterDisplay}**`,
        priceLine,
        ...(standard === "erc1155" ? [`Quantity: **${quantity}**`] : []),
        ``,
        `[View on OpenSea](${openseaUrl(collection.contractAddress, tokenIdStr)})`,
      ].join("\n")
    )
    .setTimestamp(new Date(timestampMs))
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  const channel = await client.channels.fetch(config.discordChannelId);
  await rateLimiter.send(channel, { embeds: [embed] });
}

async function postPieceRevealed(collection, tokenIdStr, txHash, blockNumber) {

  const imageUrl = tokenIdStr !== "unknown" ? s3Preview(collection.name, tokenIdStr) : null;

  let timestampMs = Date.now();
  try {
    const block = await provider.getBlock(blockNumber);
    if (block?.timestamp) timestampMs = block.timestamp * 1000;
  } catch {}

  const embed = new EmbedBuilder()
    .setTitle(`New Piece Revealed`)
    .setDescription(
      [
        `Collection: **${collection.name}**`,
        `Artist: **${collection.artist || "Unknown"}**`,
        `Piece: **#${tokenIdStr}**`,
        ``,
        `Auction is now live.`,
        ``,
        `[View on 8NAP](${auctionViewLink(collection.name)})`,
        `Tx: https://etherscan.io/tx/${txHash}`,
      ].join("\n")
    )
    .setTimestamp(new Date(timestampMs))
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  const channel = await client.channels.fetch(config.auctionChannelId);
  await rateLimiter.send(channel, { embeds: [embed] });
}

async function postBid(collection, tokenIdStr, bidder, amountWei, isFirstBid, txHash, blockNumber) {

let imageUrl = null;
if (tokenIdStr !== "unknown") {
  const previewUrl = s3Preview(collection.name, tokenIdStr);
  if (previewUrl) {
    try {
      if (await previewExists(previewUrl)) imageUrl = previewUrl;
    } catch {}
  }
}

  const bidderDisplay = await formatDisplayAddress(bidder);
  const amountEth = ethers.formatEther(amountWei);

  let timestampMs = Date.now();
  try {
    const block = await provider.getBlock(blockNumber);
    if (block?.timestamp) timestampMs = block.timestamp * 1000;
  } catch {}

  const title = isFirstBid ? `Auction Started (First Bid)` : `New Bid Placed`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      [
        `Collection: **${collection.name}**`,
        `Piece: **#${tokenIdStr}**`,
        `Bidder: **${bidderDisplay}**`,
        `Amount: **${amountEth} ETH**`,
        ``,
        `[View on 8NAP](${auctionViewLink(collection.name)})`,
        `Tx: https://etherscan.io/tx/${txHash}`,
      ].join("\n")
    )
    .setTimestamp(new Date(timestampMs))
    .setFooter({ text: collection.name });

  if (imageUrl) embed.setImage(imageUrl);

  const channel = await client.channels.fetch(config.auctionChannelId);
  await rateLimiter.send(channel, { embeds: [embed] });
}

// =========================
// Polling engine
// =========================

async function initializeStateToHeadIfEmpty(collection) {
  const st = loadState(collection.contractAddress);
  if (!st.lastProcessedBlock || st.lastProcessedBlock === 0) {
    const head = await provider.getBlockNumber();
    st.lastProcessedBlock = head - CONFIRMATIONS;
    if (st.lastProcessedBlock < 0) st.lastProcessedBlock = 0;
    saveState(collection.contractAddress, st);
  }
}

function tokenIdFromTotalSupply(totalSupplyValue, tokenIdBase = 0) {
  // tokenIdBase:
  // 0 = tokenId is totalSupply - 1 (0-based collections)
  // 1 = tokenId is totalSupply     (1-based collections)
  try {
    const n = BigInt(totalSupplyValue.toString());
    if (tokenIdBase === 1) return n.toString();
    return (n > 0n ? n - 1n : 0n).toString();
  } catch {
    return "unknown";
  }
}

async function pollOnce() {
  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS;
  if (safeHead <= 0) return;

  for (const collection of config.collections) {
    if (!collection.contractAddress || !collection.standard) continue;

    const addr = collection.contractAddress;
    const standard = collection.standard.toLowerCase();
    console.log(`[pollOnce] collection=${collection.name} addr=${addr}`);
    const st = loadState(addr);
    const fromBlock = st.lastProcessedBlock + 1;
    if (fromBlock > safeHead) continue;

    const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, safeHead);

    // Build contract + interface + topics based on collection type
    let contract;
    let iface;
    let topics;

    const isAuction = (collection.name === "Issues" || collection.name === "Metamorphosis");

    if (standard === "erc721" && isAuction) {
      contract = new ethers.Contract(addr, AUCTION_ABI, provider);
      iface = contract.interface;

      topics = [[
        iface.getEvent("PieceRevealed").topicHash,
        iface.getEvent("NewBidPlaced").topicHash,
        iface.getEvent("Transfer").topicHash,
      ]];
    } else if (standard === "erc721") {
      contract = new ethers.Contract(addr, ERC721_ABI, provider);
      iface = contract.interface;

      topics = [[ iface.getEvent("Transfer").topicHash ]];
    } else if (standard === "erc1155") {
      contract = new ethers.Contract(addr, ERC1155_ABI, provider);
      iface = contract.interface;

      topics = [[
        iface.getEvent("TransferSingle").topicHash,
        iface.getEvent("TransferBatch").topicHash,
      ]];
    } else {
      // unsupported
      st.lastProcessedBlock = toBlock;
      saveState(addr, st);
      continue;
    }

    let logs = [];
    try {
      logs = await provider.getLogs({
        address: addr,
        fromBlock,
        toBlock,
        topics,
      });
    } catch (e) {
      console.error(`❌ getLogs failed for ${collection.name} ${fromBlock}-${toBlock}:`, e.message);
      // Do not advance cursor on failure
      continue;
    }
    // --------- Per-tx mint unit counting (for correct per-token pricing) ---------
// For non-auction collections, tx.value is the TOTAL paid for the whole transaction.
// If multiple tokens/units mint in one tx, we must divide by the number minted.
const mintUnitsByTx = {}; // txHash -> BigInt(total units minted in this tx for this contract)
const txValueCache = {};  // txHash -> tx.value BigInt

if (!isAuction) {
  for (const lg of logs) {
    let p;
    try {
      p = iface.parseLog(lg);
    } catch {
      continue;
    }

    // ERC721 mint-only: Transfer(from=ZERO) => 1 unit per log
    if (standard === "erc721" && p.name === "Transfer") {
      const from = p.args.from;
      if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
        const h = lg.transactionHash;
        mintUnitsByTx[h] = (mintUnitsByTx[h] || 0n) + 1n;
      }
    }

    // ERC1155 mint-only: quantities come from value(s)
    if (standard === "erc1155") {
      const h = lg.transactionHash;

      if (p.name === "TransferSingle") {
        const from = p.args.from;
        const value = p.args.value;
        if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
          mintUnitsByTx[h] = (mintUnitsByTx[h] || 0n) + BigInt(value.toString());
        }
      }

      if (p.name === "TransferBatch") {
        const from = p.args.from;
        const values = p.args.values;
        if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
          let sum = 0n;
          for (const v of values) sum += BigInt(v.toString());
          mintUnitsByTx[h] = (mintUnitsByTx[h] || 0n) + sum;
        }
      }
    }
  }
}

    // Process logs in chain order
    for (const log of logs) {
      const k = seenKey(log);
      if (st.processed?.[k]) continue;

      // mark processed BEFORE doing network calls to avoid duplicates on crash loops
      if (!st.processed) st.processed = {};
      st.processed[k] = true;

      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }

      try {
        // ===== Auction (Issues/Metamorphosis) =====
        if (standard === "erc721" && isAuction) {
          if (parsed.name === "PieceRevealed") {
            const freshState = loadState(addr);

          let tokenIdNow = null;
          try {
            tokenIdNow = await contract.totalSupply({ blockTag: log.blockNumber });
          } catch {}

          const tokenIdStr = tokenIdNow != null ? tokenIdFromTotalSupply(tokenIdNow, collection.tokenIdBase ?? 0) : "unknown";

          // track the current auction piece deterministically
          freshState.currentAuctionTokenId = tokenIdStr !== "unknown" ? tokenIdStr : freshState.currentAuctionTokenId;
          saveState(addr, freshState);

          await postPieceRevealed(collection, tokenIdStr, log.transactionHash, log.blockNumber);
      } else if (parsed.name === "NewBidPlaced") {
  const bidStruct = parsed.args.bid;
  const bidder = bidStruct.bidder;
  const amount = bidStruct.amount; // bigint

  const freshState = loadState(addr);

  // Best source: last revealed piece for the auction
  let tokenIdStr = freshState.currentAuctionTokenId;

  // Fallback: infer from totalSupply at this block
  if (!tokenIdStr || tokenIdStr === "unknown") {
    try {
      const t = await contract.totalSupply({ blockTag: log.blockNumber });
      tokenIdStr = tokenIdFromTotalSupply(t);
      freshState.currentAuctionTokenId = tokenIdStr;
    } catch {
      tokenIdStr = "unknown";
    }
  }

  const prevBidWeiStr =
    tokenIdStr !== "unknown" ? (freshState.lastBidWeiByToken[tokenIdStr] ?? null) : null;

  const FIRST_BID_WEI = ethers.parseEther("0.1");
  const isFirstBid =
    tokenIdStr !== "unknown" && amount === FIRST_BID_WEI && !prevBidWeiStr;

  if (tokenIdStr !== "unknown") {
    freshState.lastBidWeiByToken[tokenIdStr] = amount.toString();
    saveState(addr, freshState);
  }

  await postBid(
    collection,
    tokenIdStr,
    bidder,
    amount,
    isFirstBid,
    log.transactionHash,
    log.blockNumber
  );

  continue;
} else if (parsed.name === "Transfer") {
  const from = parsed.args.from;
  const to = parsed.args.to;
  const tokenId = parsed.args.tokenId;
  const tokenIdStr = tokenId.toString();

  const freshState = loadState(addr);

  // (A) Settlement marker: mint/airdrop from ZERO -> winner.
  // The tokenId/art in this tx can be wrong, so we key off the last revealed auction token instead.
  if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    const resolvedTokenIdStr =
      (freshState.currentAuctionTokenId && freshState.currentAuctionTokenId !== "unknown")
        ? freshState.currentAuctionTokenId
        : tokenIdStr;

    // amount: prefer last bid we observed for that token, fallback to tx.value (often 0)
    let amountWeiStr = freshState.lastBidWeiByToken[resolvedTokenIdStr] || null;
    if (!amountWeiStr) {
      try {
        const tx = await provider.getTransaction(log.transactionHash);
        if (tx?.value != null) amountWeiStr = tx.value.toString();
      } catch {}
    }
    if (!amountWeiStr) amountWeiStr = "0";

    // store pending by the REAL auction token id
    freshState.pendingAuctions[resolvedTokenIdStr] = {
      winner: to,
      settlementTx: log.transactionHash,
      amountWei: amountWeiStr,
    };

    // keep aligned
    freshState.currentAuctionTokenId = resolvedTokenIdStr;
    saveState(addr, freshState);

    // Post Auction Ended using the REAL token id
    await postAuctionEnded(
      collection,
      resolvedTokenIdStr,
      to,
      BigInt(amountWeiStr),
      log.transactionHash,
      log.blockNumber
    );

    continue;
  }

  // (B) Claim/self-transfer: after settlement, winner triggers a transfer that makes the token "real".
  const pending = freshState.pendingAuctions[tokenIdStr];
  if (pending) {
    const overridePriceWei = BigInt(pending.amountWei || "0");

    await postMint(
      collection,
      "erc721",
      contract,
      tokenId,
      to,
      log.transactionHash,
      log.blockNumber,
      log.index,
      1,
      overridePriceWei
    );

    delete freshState.pendingAuctions[tokenIdStr];
    saveState(addr, freshState);
  }
}

        }

        // ===== ERC721 mint-only =====
if (standard === "erc721" && !isAuction) {
  if (parsed.name !== "Transfer") continue;
  const from = parsed.args.from;
  const to = parsed.args.to;
  const tokenId = parsed.args.tokenId;
  if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) continue;

 // ERC721: show per-token price (if multiple ERC721 mints in same tx, split tx.value across tokens)
let overridePriceWei = null;
try {
  const h = log.transactionHash;
  const units = mintUnitsByTx[h] || 1n;

  let txv = txValueCache[h];
  if (txv == null) {
    const tx = await provider.getTransaction(h);
    if (tx?.value != null) txv = BigInt(tx.value.toString());
    txValueCache[h] = txv;
  }

  if (txv != null && units > 0n) {
    overridePriceWei = txv / units; // per token
  }
} catch {}

await postMint(
  collection,
  "erc721",
  contract,
  tokenId,
  to,
  log.transactionHash,
  log.blockNumber,
  log.index,
  1,
  overridePriceWei
);

await postMint(
  collection,
  "erc1155",
  contract,
  id,
  to,
  log.transactionHash,
  log.blockNumber,
  log.index,
  value,
  overridePriceWei
);

}


        // ===== ERC1155 mint-only =====
if (standard === "erc1155") {
  if (parsed.name === "TransferSingle") {
    const from = parsed.args.from;
    const to = parsed.args.to;
    const id = parsed.args.id;
    const value = parsed.args.value;

    if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) continue;

    // ERC1155: show TOTAL spent for this row (per-unit * quantity in this event)
    let overridePriceWei = null;
    try {
      const h = log.transactionHash;
      const units = mintUnitsByTx[h] || 1n; // total units minted in this tx (this contract)

      let txv = txValueCache[h];
      if (txv == null) {
        const tx = await provider.getTransaction(h);
        if (tx?.value != null) txv = BigInt(tx.value.toString());
        txValueCache[h] = txv;
      }

      if (txv != null && units > 0n) {
        const perUnitWei = txv / units;
        const qty = BigInt(value.toString());
        overridePriceWei = perUnitWei * qty;
      }
    } catch {}

    await postMint(
      collection,
      "erc1155",
      contract,
      id,
      to,
      log.transactionHash,
      log.blockNumber,
      log.index,
      value,
      overridePriceWei
    );
  } else if (parsed.name === "TransferBatch") {
    const from = parsed.args.from;
    const to = parsed.args.to;
    const ids = parsed.args.ids;
    const values = parsed.args.values;

    if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) continue;

    for (let i = 0; i < ids.length; i++) {
      // ERC1155: show TOTAL spent for this row (per-unit * quantity for this id)
      let overridePriceWei = null;
      try {
        const h = log.transactionHash;
        const units = mintUnitsByTx[h] || 1n;

        let txv = txValueCache[h];
        if (txv == null) {
          const tx = await provider.getTransaction(h);
          if (tx?.value != null) txv = BigInt(tx.value.toString());
          txValueCache[h] = txv;
        }

        if (txv != null && units > 0n) {
          const perUnitWei = txv / units;
          const qty = BigInt(values[i].toString());
          overridePriceWei = perUnitWei * qty;
        }
      } catch {}

      await postMint(
        collection,
        "erc1155",
        contract,
        ids[i],
        to,
        log.transactionHash,
        log.blockNumber,
        log.index,
        values[i],
        overridePriceWei
      );
    }
  }
}

      } catch (e) {
  console.error(`❌ Error handling ${collection.name} ${parsed.name}:`, e.message);
  console.error(e); // <-- this prints stack + more details
}
    }

    // advance cursor only after batch processed
    st.lastProcessedBlock = toBlock;
    if (isAuction) {
      const latest = loadState(addr);
      st.currentAuctionTokenId = st.currentAuctionTokenId ?? latest.currentAuctionTokenId ?? null;
      st.pendingAuctions = st.pendingAuctions ?? latest.pendingAuctions ?? {};
      st.lastBidWeiByToken = st.lastBidWeiByToken ?? latest.lastBidWeiByToken ?? {};
      st.lastBidderByToken = st.lastBidderByToken ?? latest.lastBidderByToken ?? {};
    }
    console.log(`[pollOnce] pre-save addr=${addr} keys=${Object.keys(st).join(",")}`);
    saveState(addr, st);
  }
}

async function registerCommands() {
  // Guild-scoped is instant. Global can take a long time to appear.
  const guildId = process.env.GUILD_ID;
  if (!guildId) {
    console.log("⚠️ GUILD_ID not set. Skipping slash command registration.");
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("ledgercsv")
      .setDescription("Download a monthly mint ledger CSV")
      .addStringOption((opt) =>
        opt
          .setName("month")
          .setDescription("Month key in YYYY-MM (example: 2026-01). Defaults to current month.")
          .setRequired(false)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: commands }
  );

  console.log("✅ Slash commands registered for guild:", guildId);
}

// =========================
// Startup + loop
// =========================

let pollTimer = null;

async function startPolling() {
  // initialize cursors to safe head on first boot, to avoid posting historical spam
  for (const collection of config.collections) {
    await initializeStateToHeadIfEmpty(collection);
  }

  console.log(`✅ Polling started. interval=${POLL_MS}ms confirmations=${CONFIRMATIONS} range=${MAX_BLOCK_RANGE}`);

  // run immediately, then interval
  await pollOnce().catch((e) => {
  console.error("pollOnce error:", e.message);
  console.error(e);
});

pollTimer = setInterval(() => {
  pollOnce().catch((e) => {
    console.error("pollOnce error:", e.message);
    console.error(e);
  });
}, POLL_MS);
}

// Heartbeat
setInterval(async () => {
  try {
    const head = await provider.getBlockNumber();
    console.log(`💓 Heartbeat head=${head}`);
  } catch (e) {
    console.log(`💓 Heartbeat error: ${e.message}`);
  }
}, 300000);

// Warm ETH/USD cache in the background (free, low frequency)
setInterval(async () => {
  try {
    await getEthPriceUsd(); // uses caching + disk; only hits CoinGecko occasionally
  } catch {}
}, 15 * 60 * 1000);

// Graceful shutdown
async function shutdown(signal) {
  console.log(`🛑 Shutting down (${signal})...`);
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const LEDGER_CSV_CHANNEL_ID = process.env.LEDGER_CSV_CHANNEL_ID || "1463682240671387952";

async function runMonthlyLedgerPosterTick() {
  // Use UTC to avoid DST/timezone stupidity.
  const now = new Date();
  const day = now.getUTCDate();
  if (day !== 1) return;

  const prevMonthKey = prevMonthKeyFromMs(Date.now());
  const st = loadLedgerPostState();

  if (st.posted[prevMonthKey]) return; // already posted

  const ok = await postLedgerCsvForMonth(prevMonthKey, LEDGER_CSV_CHANNEL_ID);
  if (ok) {
    st.posted[prevMonthKey] = new Date().toISOString();
    saveLedgerPostState(st);
  }
}


client.once("clientReady", async () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  try {
    // 3C.2: register slash commands on boot
    await registerCommands();

    await startPolling();

    // Start monthly poster (runs shortly after boot, then every 5 minutes)
    setTimeout(() => {
      runMonthlyLedgerPosterTick().catch((e) => {
        console.error("ledger poster tick error:", e.message);
        console.error(e);
      });
    }, 5000);

    setInterval(() => {
      runMonthlyLedgerPosterTick().catch((e) => {
        console.error("ledger poster tick error:", e.message);
        console.error(e);
      });
    }, 5 * 60 * 1000);
  } catch (e) {
    console.error("❌ Failed to start bot:", e.message);
    console.error(e);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
