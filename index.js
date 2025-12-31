require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
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
// State persistence (disk)
// =========================

const STATE_DIR = path.join(__dirname, "state");
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR);

function stateFileFor(address) {
  return path.join(STATE_DIR, `${address.toLowerCase()}.json`);
}

function loadState(address) {
  const p = stateFileFor(address);
  if (!fs.existsSync(p)) {
    return { lastProcessedBlock: 0, processed: {}, pendingAuction: null };

  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
if (!parsed.pendingAuction) parsed.pendingAuction = null;
return parsed;

  } catch {
    // If state is corrupted, fail safe by starting at 0 (we’ll set it on boot)
    return { lastProcessedBlock: 0, processed: {} };
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

// ETH price cache (optional)
let cachedEthPrice = null;
let cacheTime = 0;

async function getEthPriceUsd() {
  if (Date.now() - cacheTime < 60000 && cachedEthPrice) return cachedEthPrice;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);
    const data = await res.json();
    cachedEthPrice = data?.ethereum?.usd ?? null;
    cacheTime = Date.now();
    return cachedEthPrice;
  } catch {
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

async function postAuctionEnded(collection, contract, winner, amountWei, txHash, blockNumber) {
  let tokenId = null;
  try {
    tokenId = await contract.totalSupply();
  } catch {}

  const tokenIdStr = tokenId != null ? tokenId.toString() : "unknown";
  const imageUrl = tokenId != null ? s3Preview(collection.name, tokenIdStr) : null;

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

async function postMint(collection, standard, contract, tokenId, to, txHash, blockNumber, quantity) {
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

  // tx value
  let priceEth = "0";
  try {
    const tx = await provider.getTransaction(txHash);
    if (tx?.value != null) priceEth = ethers.formatEther(tx.value);
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

async function postPieceRevealed(collection, contract, txHash, blockNumber) {
  // Correct token id source: totalSupply after reveal
  let tokenId = null;
  try {
    tokenId = await contract.totalSupply();
  } catch {
    tokenId = null;
  }

  const tokenIdStr = tokenId != null ? tokenId.toString() : "unknown";
  const imageUrl = tokenId != null ? s3Preview(collection.name, tokenIdStr) : null;

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

async function postBid(collection, contract, bidder, amountWei, isFirstBid, txHash, blockNumber) {
  let tokenId = null;
  try {
    tokenId = await contract.totalSupply();
  } catch {
    tokenId = null;
  }

  const tokenIdStr = tokenId != null ? tokenId.toString() : "unknown";
  const imageUrl = tokenId != null ? s3Preview(collection.name, tokenIdStr) : null;

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

// Track first bid per tokenId per collection (in-memory is fine; correctness comes from logs + dedupe)
const firstBidSeen = new Map(); // key: `${collectionAddress}-${tokenIdStr}` -> true

function markFirstBid(collectionAddress, tokenIdStr) {
  firstBidSeen.set(`${collectionAddress.toLowerCase()}-${tokenIdStr}`, true);
}
function hasFirstBid(collectionAddress, tokenIdStr) {
  return firstBidSeen.has(`${collectionAddress.toLowerCase()}-${tokenIdStr}`);
}

async function initializeStateToHeadIfEmpty(collection) {
  const st = loadState(collection.contractAddress);
  if (!st.lastProcessedBlock || st.lastProcessedBlock === 0) {
    const head = await provider.getBlockNumber();
    st.lastProcessedBlock = head - CONFIRMATIONS;
    if (st.lastProcessedBlock < 0) st.lastProcessedBlock = 0;
    saveState(collection.contractAddress, st);
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
            await postPieceRevealed(collection, contract, log.transactionHash, log.blockNumber);
          } else if (parsed.name === "NewBidPlaced") {
            const bidStruct = parsed.args.bid;
            const bidder = bidStruct.bidder;
            const amount = bidStruct.amount;

            // determine tokenId via totalSupply (current live piece)
            let tokenIdNow = null;
            try {
              tokenIdNow = await contract.totalSupply();
            } catch {}

            const tokenIdStr = tokenIdNow != null ? tokenIdNow.toString() : "unknown";
            const first = tokenIdStr !== "unknown" ? !hasFirstBid(addr, tokenIdStr) : false;

            await postBid(collection, contract, bidder, amount, first, log.transactionHash, log.blockNumber);

            if (tokenIdStr !== "unknown" && first) markFirstBid(addr, tokenIdStr);
          } else if (parsed.name === "Transfer") {
  const from = parsed.args.from;
  const to = parsed.args.to;
  const tokenId = parsed.args.tokenId;

  // Load fresh state
  const freshState = loadState(addr);

  // === Auction settlement (placeholder transfer) ===
  if (from.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    // Identify winner + price
    let amountWei = 0n;
    try {
      const tx = await provider.getTransaction(log.transactionHash);
      if (tx?.value != null) amountWei = tx.value;
    } catch {}

    // Save pending auction to disk
    freshState.pendingAuction = {
      winner: to,
      settlementTx: log.transactionHash,
      amountWei: amountWei.toString(),
    };
    saveState(addr, freshState);

    // Post Auction Ended (NOT a mint)
    await postAuctionEnded(
      collection,
      contract,
      to,
      amountWei,
      log.transactionHash,
      log.blockNumber
    );

    continue;
  }

  // === Claim transfer (real mint) ===
  if (
    freshState.pendingAuction &&
    to.toLowerCase() === freshState.pendingAuction.winner.toLowerCase()
  ) {
    const mintContract = new ethers.Contract(addr, ERC721_ABI, provider);

    await postMint(
      collection,
      "erc721",
      mintContract,
      tokenId,
      to,
      log.transactionHash,
      log.blockNumber,
      1
    );

    // Clear pending auction
    freshState.pendingAuction = null;
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

          await postMint(collection, "erc721", contract, tokenId, to, log.transactionHash, log.blockNumber, 1);
        }

        // ===== ERC1155 mint-only =====
        if (standard === "erc1155") {
          if (parsed.name === "TransferSingle") {
            const from = parsed.args.from;
            const to = parsed.args.to;
            const id = parsed.args.id;
            const value = parsed.args.value;
            if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) continue;

            await postMint(collection, "erc1155", contract, id, to, log.transactionHash, log.blockNumber, value);
          } else if (parsed.name === "TransferBatch") {
            const from = parsed.args.from;
            const to = parsed.args.to;
            const ids = parsed.args.ids;
            const values = parsed.args.values;
            if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) continue;

            for (let i = 0; i < ids.length; i++) {
              await postMint(collection, "erc1155", contract, ids[i], to, log.transactionHash, log.blockNumber, values[i]);
            }
          }
        }
      } catch (e) {
        // If Discord/HTTP fails mid-event, we still keep processed=true to avoid spam loops.
        // The cursor ensures we don’t miss later events; this trade-off prevents repeated spam on transient failures.
        console.error(`❌ Error handling ${collection.name} ${parsed.name}:`, e.message);
      }
    }

    // advance cursor only after batch processed
    st.lastProcessedBlock = toBlock;
    saveState(addr, st);
  }
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
  await pollOnce().catch((e) => console.error("pollOnce error:", e.message));

  pollTimer = setInterval(() => {
    pollOnce().catch((e) => console.error("pollOnce error:", e.message));
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

// Graceful shutdown
async function shutdown(signal) {
  console.log(`🛑 Shutting down (${signal})...`);
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

client.once("clientReady", async () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  try {
    await startPolling();
  } catch (e) {
    console.error("❌ Failed to start polling:", e.message);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);