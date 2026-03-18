require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { ethers } = require("ethers");

// =========================
// Config + Env validation
// =========================

const configPath = path.join(__dirname, "config.json");
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  console.log("[startup] config loaded successfully");
} catch (e) {
  console.error(`❌ Failed to read/parse config.json: ${e.message}`);
  process.exit(1);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function disabledSalesConfig() {
  return {
    enabled: false,
    discordChannelId: "",
    collections: [],
  };
}

function validateOptionalSalesConfig(cfg) {
  if (cfg?.sales === undefined) return;

  const errors = [];
  const sales = cfg.sales;

  if (!sales || typeof sales !== "object" || Array.isArray(sales)) {
    errors.push("sales must be a JSON object.");
  } else {
    if (typeof sales.enabled !== "boolean") {
      errors.push("sales.enabled is required and must be a boolean.");
    }

    if (!isNonEmptyString(sales.discordChannelId)) {
      errors.push("sales.discordChannelId is required and must be a non-empty string.");
    }

    if (!Array.isArray(sales.collections)) {
      errors.push("sales.collections is required and must be an array.");
    } else {
      sales.collections.forEach((collection, i) => {
        const where = `sales.collections[${i}]`;

        if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
          errors.push(`${where} must be an object.`);
          return;
        }

        if (!isNonEmptyString(collection.name)) {
          errors.push(`${where}.name is required and must be a non-empty string.`);
        }
        if (!isNonEmptyString(collection.artist)) {
          errors.push(`${where}.artist is required and must be a non-empty string.`);
        }
        if (!isNonEmptyString(collection.contractAddress)) {
          errors.push(`${where}.contractAddress is required and must be a non-empty string.`);
        }
        if (!isNonEmptyString(collection.standard)) {
          errors.push(`${where}.standard is required and must be a non-empty string.`);
        } else {
          const s = collection.standard.toLowerCase();
          if (s !== "erc721" && s !== "erc1155") {
            errors.push(`${where}.standard must be "erc721" or "erc1155".`);
          }
        }

        if (collection.startBlock !== undefined) {
          if (!Number.isInteger(collection.startBlock) || collection.startBlock < 0) {
            errors.push(`${where}.startBlock must be an integer >= 0 when provided.`);
          }
        }
      });
    }
  }

  if (errors.length > 0) {
    console.error("⚠️ Invalid sales config. Sales tracking will be disabled:");
    for (const err of errors) console.error(` - ${err}`);
    cfg.sales = disabledSalesConfig();
    return;
  }

  cfg.sales = {
    ...sales,
    discordChannelId: sales.discordChannelId.trim(),
    collections: sales.collections.map((collection) => ({
      ...collection,
      standard: collection.standard.toLowerCase(),
      ...(collection.startBlock !== undefined ? { startBlock: collection.startBlock } : {}),
    })),
  };
}

function validateConfig(cfg) {
  const errors = [];

  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    errors.push("config must be a JSON object.");
  }

  if (!isNonEmptyString(cfg?.discordChannelId)) {
    errors.push("discordChannelId is required and must be a non-empty string.");
  }
  if (!isNonEmptyString(cfg?.auctionChannelId)) {
    errors.push("auctionChannelId is required and must be a non-empty string.");
  }

  if (!Array.isArray(cfg?.collections)) {
    errors.push("collections is required and must be an array.");
  } else {
    cfg.collections.forEach((collection, i) => {
      const where = `collections[${i}]`;

      if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
        errors.push(`${where} must be an object.`);
        return;
      }

      if (!isNonEmptyString(collection.name)) {
        errors.push(`${where}.name is required and must be a non-empty string.`);
      }
      if (!isNonEmptyString(collection.contractAddress)) {
        errors.push(`${where}.contractAddress is required and must be a non-empty string.`);
      }
      if (!isNonEmptyString(collection.standard)) {
        errors.push(`${where}.standard is required and must be a non-empty string.`);
      } else {
        const s = collection.standard.toLowerCase();
        if (s !== "erc721" && s !== "erc1155") {
          errors.push(`${where}.standard must be "erc721" or "erc1155".`);
        }
      }

      if (collection.isAuction === true && String(collection.standard || "").toLowerCase() !== "erc721") {
        errors.push(`${where}.isAuction=true requires standard="erc721".`);
      }

      if (collection.previewS3Id !== undefined && !Number.isFinite(collection.previewS3Id)) {
        errors.push(`${where}.previewS3Id must be a number when provided.`);
      }

      if (collection.preview !== undefined) {
        if (!collection.preview || typeof collection.preview !== "object" || Array.isArray(collection.preview)) {
          errors.push(`${where}.preview must be an object when provided.`);
        } else {
          if (collection.preview.enabled !== undefined && typeof collection.preview.enabled !== "boolean") {
            errors.push(`${where}.preview.enabled must be a boolean when provided.`);
          }
          if (collection.preview.s3Id !== undefined && !Number.isFinite(collection.preview.s3Id)) {
            errors.push(`${where}.preview.s3Id must be a number when provided.`);
          }
        }
      }
    });
  }

  if (errors.length > 0) {
    console.error("❌ Invalid config.json:");
    for (const err of errors) console.error(` - ${err}`);
    process.exit(1);
  }

  validateOptionalSalesConfig(cfg);
}

validateConfig(config);
console.log("[startup] config validated successfully");

if (!process.env.DISCORD_BOT_TOKEN) {
  console.error("❌ Missing env var: DISCORD_BOT_TOKEN");
  process.exit(1);
}
if (!process.env.RPC_HTTP_URL) {
  console.error("❌ Missing env var: RPC_HTTP_URL (Alchemy HTTPS endpoint)");
  process.exit(1);
}
console.log("[startup] required env vars validated");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_ADDRESS_LOWER = ZERO_ADDRESS.toLowerCase();
const CHAIN = "ethereum";

function parseValidatedIntegerEnv(name, fallback, min) {
  const rawValue = process.env[name];
  const resolvedRaw = rawValue === undefined ? String(fallback) : String(rawValue).trim();
  const parsed = Number(resolvedRaw);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    console.error(
      `❌ Invalid env var ${name}: "${rawValue}" (resolved value: "${resolvedRaw}"). Must be an integer >= ${min}.`
    );
    process.exit(1);
  }

  return parsed;
}

const POLL_MS = parseValidatedIntegerEnv("POLL_MS", 15000, 1000);          // 15s
const CONFIRMATIONS = parseValidatedIntegerEnv("CONFIRMATIONS", 2, 0);     // reorg safety
const MAX_BLOCK_RANGE = parseValidatedIntegerEnv("MAX_BLOCK_RANGE", 5, 1); // <= 10 for Alchemy free constraints
const HOLDERS_MAX_BLOCK_RANGE = Math.max(MAX_BLOCK_RANGE, 5000);
console.log("[startup] numeric env vars validated");

// =========================
// Provider (polling-first)
// =========================

const provider = new ethers.JsonRpcProvider(process.env.RPC_HTTP_URL);
console.log("[startup] provider constructed");

// =========================
// Persistent data dir (Railway Volume should mount to /data)
// =========================
const isRailway = Object.keys(process.env).some((k) => k.startsWith("RAILWAY_"));
if (isRailway) {
  const railwayDataDir = process.env.DATA_DIR;
  const validRailwayDataDir =
    typeof railwayDataDir === "string" &&
    (railwayDataDir === "/data" || railwayDataDir.startsWith("/data"));

  if (!validRailwayDataDir) {
    console.error(`❌ Invalid DATA_DIR for Railway: "${railwayDataDir || ""}"`);
    console.error("❌ On Railway, DATA_DIR must be set to /data (or a subpath under /data).");
    process.exit(1);
  }
}
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const STATE_DIR = path.join(DATA_DIR, "state");
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR);
const SALES_STATE_DIR = path.join(STATE_DIR, "sales");
if (!fs.existsSync(SALES_STATE_DIR)) fs.mkdirSync(SALES_STATE_DIR, { recursive: true });

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

function salesStateFileFor(collectionKey) {
  const safeKey = String(collectionKey || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
  return path.join(SALES_STATE_DIR, `${safeKey}.json`);
}

function loadSalesState(collectionKey) {
  const fallback = {
    version: 1,
    lastProcessedBlock: 0,
    processed: {},
  };

  try {
    if (!collectionKey) return { ...fallback };

    const p = salesStateFileFor(collectionKey);
    if (!fs.existsSync(p)) return { ...fallback };

    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);

    if (typeof parsed.version !== "number") parsed.version = 1;
    if (typeof parsed.lastProcessedBlock !== "number") parsed.lastProcessedBlock = 0;
    if (!parsed.processed || typeof parsed.processed !== "object") parsed.processed = {};

    return parsed;
  } catch (e) {
    console.error(`❌ loadSalesState failed for ${collectionKey}:`, e.message);
    return { ...fallback };
  }
}

function saveSalesState(collectionKey, state) {
  const keys = Object.keys(state.processed || {});
  if (keys.length > 6000) {
    const keep = keys.slice(-3000);
    const next = {};
    for (const k of keep) next[k] = true;
    state.processed = next;
  }

  if (typeof state.version !== "number") state.version = 1;
  if (typeof state.lastProcessedBlock !== "number") state.lastProcessedBlock = 0;
  if (!state.processed || typeof state.processed !== "object") state.processed = {};

  fs.writeFileSync(salesStateFileFor(collectionKey), JSON.stringify(state, null, 2));
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
const SALES_LEDGER_DIR = path.join(DATA_DIR, "ledger-sales");
if (!fs.existsSync(SALES_LEDGER_DIR)) fs.mkdirSync(SALES_LEDGER_DIR, { recursive: true });
const TEMP_DIR = path.join(DATA_DIR, "tmp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
console.log("[startup] data/state/ledger/tmp directories ensured");

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

function salesLedgerPathForMonth(monthKey) {
  return path.join(SALES_LEDGER_DIR, `sales-${monthKey}.csv`);
}

function ensureSalesLedgerHeader(filePath) {
  if (fs.existsSync(filePath)) return;
  const header = [
    "DateUTC",
    "ProjectKey",
    "Collection",
    "Standard",
    "Quantity",
    "SellerWallet",
    "BuyerWallet",
    "SalePriceNative",
    "CurrencySymbol",
    "Marketplace",
    "TokenID",
    "Contract",
    "TxHash",
    "BlockNumber",
    "LogIndex",
  ].join(",") + "\n";
  fs.writeFileSync(filePath, header);
}

function appendSaleToLedger(row, timestampMs) {
  const monthKey = monthKeyFromMs(timestampMs);
  const filePath = salesLedgerPathForMonth(monthKey);
  ensureSalesLedgerHeader(filePath);

  const line = [
    row.DateUTC,
    row.ProjectKey,
    row.Collection,
    row.Standard,
    row.Quantity,
    row.SellerWallet,
    row.BuyerWallet,
    row.SalePriceNative,
    row.CurrencySymbol,
    row.Marketplace,
    row.TokenID,
    row.Contract,
    row.TxHash,
    row.BlockNumber,
    row.LogIndex,
  ].map(csvEscape).join(",") + "\n";

  fs.appendFileSync(filePath, line);
}

function alchemyNftApiBaseUrlFromRpcUrl(rpcUrl) {
  const rawUrl = String(rpcUrl || "").trim();
  if (!rawUrl) {
    throw new Error("RPC_HTTP_URL is required to derive the Alchemy NFT API endpoint.");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("RPC_HTTP_URL is not a valid URL.");
  }

  if (!parsed.hostname.includes("alchemy.com")) {
    throw new Error("RPC_HTTP_URL is not an Alchemy endpoint.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "v2" || !isNonEmptyString(parts[1])) {
    throw new Error("RPC_HTTP_URL is not an Alchemy v2 endpoint.");
  }

  return `${parsed.origin}/nft/v3/${parts[1]}`;
}

function safeLowercaseAddress(value) {
  return isNonEmptyString(value) ? String(value).trim().toLowerCase() : "";
}

function safeLowercaseString(value) {
  return isNonEmptyString(value) ? String(value).trim().toLowerCase() : "";
}

function safeString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeOrder(value) {
  return value === "desc" ? "desc" : "asc";
}

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1000;
  return Math.min(1000, Math.floor(parsed));
}

function normalizeFeeAmount(amount) {
  try {
    if (!isNonEmptyString(amount)) return null;
    return BigInt(String(amount).trim());
  } catch {
    return null;
  }
}

function normalizeDocumentedGrossSalePrice(rawSale) {
  // Alchemy's getNFTSales docs and tutorial describe gross sale price as the sum of
  // sellerFee + protocolFee + royaltyFee. Only use that calculation when all
  // three documented fee objects are present and agree on symbol/decimals.
  const feeEntries = [
    rawSale?.sellerFee,
    rawSale?.protocolFee,
    rawSale?.royaltyFee,
  ];

  if (feeEntries.some((fee) => !fee || typeof fee !== "object")) {
    return { salePriceNative: "", currencySymbol: "" };
  }

  const normalizedFees = feeEntries.map((fee) => ({
    amount: normalizeFeeAmount(fee.amount),
    symbol: safeString(fee.symbol).trim().toUpperCase(),
    decimals: Number(fee.decimals),
  }));

  if (normalizedFees.some((fee) => fee.amount == null)) {
    return { salePriceNative: "", currencySymbol: "" };
  }

  const symbols = [...new Set(normalizedFees.map((fee) => fee.symbol).filter((symbol) => symbol.length > 0))];
  const decimals = [...new Set(
    normalizedFees
      .map((fee) => fee.decimals)
      .filter((value) => Number.isInteger(value) && value >= 0)
  )];

  if (symbols.length !== 1 || decimals.length !== 1) {
    return { salePriceNative: "", currencySymbol: "" };
  }

  const totalAmount = normalizedFees.reduce((sum, fee) => sum + fee.amount, 0n);

  try {
    return {
      salePriceNative: ethers.formatUnits(totalAmount, decimals[0]),
      currencySymbol: symbols[0],
    };
  } catch {
    return { salePriceNative: "", currencySymbol: "" };
  }
}

function normalizeSaleRecord(rawSale, collection) {
  const standard = safeString(collection?.standard).trim().toLowerCase();
  const tokenId = safeString(rawSale?.tokenId).trim();
  const contract = safeLowercaseAddress(rawSale?.contractAddress || collection?.contractAddress);
  const quantity = safeString(rawSale?.quantity).trim();
  const buyerWallet = safeLowercaseAddress(rawSale?.buyerAddress);
  const sellerWallet = safeLowercaseAddress(rawSale?.sellerAddress);
  const marketplace = safeString(rawSale?.marketplace).trim().toLowerCase();
  const txHash = safeLowercaseString(rawSale?.transactionHash);
  const blockNumber = safeString(rawSale?.blockNumber).trim();
  const logIndex = safeString(rawSale?.logIndex).trim();
  const { salePriceNative, currencySymbol } = normalizeDocumentedGrossSalePrice(rawSale);

  return {
    projectKey: standard === "erc1155" && tokenId ? `${contract}:${tokenId}` : contract,
    collection: safeString(collection?.name).trim(),
    standard,
    quantity,
    sellerWallet,
    buyerWallet,
    salePriceNative,
    currencySymbol,
    marketplace,
    tokenId,
    contract,
    txHash,
    blockNumber,
    logIndex,
  };
}

function saleKeyFromRecord(sale) {
  return [
    safeString(sale?.blockNumber).trim(),
    safeString(sale?.txHash).trim().toLowerCase(),
    safeString(sale?.logIndex).trim(),
    safeString(sale?.contract).trim().toLowerCase(),
    safeString(sale?.tokenId).trim(),
  ].join(":");
}

const ISSUES_SALES_CANARY_CONTRACT = "0xbe27770b0263133b9d3a1d4c7c2760007b94e37f";
const ISSUES_SALES_CANARY_TX_HASH = "0xfe6efa324c92617800e3abca4ee90ad716a71e03a9553318c6c2614c1622660c";
const ISSUES_SALES_CANARY_BLOCK = 24679719;
const ISSUES_SALES_CANARY_RANGE_START = 24679710;
const KNOWN_SEAPORT_ADDRESSES = new Set([
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
  "0x00000000006c3852cbef3e08e8df289169ede581",
  "0x0000000000000068f116a894984e2db1123eb395",
]);
const KNOWN_MARKETPLACE_MATCHERS = [
  { address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", matchedBy: "seaport" },
  { address: "0x00000000006c3852cbef3e08e8df289169ede581", matchedBy: "seaport" },
  { address: "0x0000000000000068f116a894984e2db1123eb395", matchedBy: "seaport" },
];

function isIssuesSalesCollection(collection) {
  return safeLowercaseAddress(collection?.contractAddress) === ISSUES_SALES_CANARY_CONTRACT;
}

async function getNFTSalesPage(collection, options = {}) {
  const contractAddress = safeLowercaseAddress(collection?.contractAddress);
  if (!contractAddress) {
    throw new Error("collection.contractAddress is required.");
  }
  const isCanaryIssuesCollection =
    contractAddress === "0xbe27770b0263133b9d3a1d4c7c2760007b94e37f";

  const fromBlock = safeString(options.fromBlock || "0");
  const toBlock = safeString(options.toBlock || "latest");
  const order = normalizeOrder(options.order);
  const limit = String(normalizeLimit(options.limit));

  const url = new URL(`${alchemyNftApiBaseUrlFromRpcUrl(process.env.RPC_HTTP_URL)}/getNFTSales`);
  url.searchParams.set("contractAddress", contractAddress);
  url.searchParams.set("fromBlock", fromBlock);
  url.searchParams.set("toBlock", toBlock);
  url.searchParams.set("order", order);
  url.searchParams.set("limit", limit);
  if (isNonEmptyString(options.pageKey)) {
    url.searchParams.set("pageKey", String(options.pageKey).trim());
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let res;
  try {
    if (isCanaryIssuesCollection) {
      console.log(`[sales:http] url=${url.toString()}`);
    }
    res = await fetch(url, { signal: controller.signal });
    if (isCanaryIssuesCollection) {
      console.log(`[sales:http] status=${res.status} statusText=${res.statusText} ok=${res.ok}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    throw new Error(`alchemy getNFTSales http ${res.status}`);
  }

  const data = await res.json();
  const nftSales = Array.isArray(data?.nftSales) ? data.nftSales : [];

  if (isCanaryIssuesCollection) {
    console.log(
      `[sales:raw] contractAddress=${contractAddress} fromBlock=${fromBlock} toBlock=${toBlock} order=${order} limit=${limit} nftSalesLength=${nftSales.length} pageKey=${isNonEmptyString(data?.pageKey) ? String(data.pageKey).trim() : ""} validAt=${JSON.stringify({
        blockNumber: safeString(data?.validAt?.blockNumber).trim(),
        blockHash: safeString(data?.validAt?.blockHash).trim().toLowerCase(),
        blockTimestamp: safeString(data?.validAt?.blockTimestamp).trim(),
      })}`
    );

    if (nftSales.length > 0) {
      const firstRawSale = nftSales[0] || {};
      console.log(
        `[sales:raw] firstSale=${JSON.stringify({
          marketplace: safeString(firstRawSale.marketplace).trim(),
          contractAddress: safeLowercaseAddress(firstRawSale.contractAddress),
          tokenId: safeString(firstRawSale.tokenId).trim(),
          blockNumber: safeString(firstRawSale.blockNumber).trim(),
          logIndex: safeString(firstRawSale.logIndex).trim(),
          bundleIndex: safeString(firstRawSale.bundleIndex).trim(),
          transactionHash: safeLowercaseString(firstRawSale.transactionHash),
        })}`
      );
    }
  }

  return {
    sales: nftSales.map((rawSale) => normalizeSaleRecord(rawSale, collection)),
    pageKey: isNonEmptyString(data?.pageKey) ? String(data.pageKey).trim() : "",
    validAt: {
      blockNumber: safeString(data?.validAt?.blockNumber).trim(),
      blockHash: safeString(data?.validAt?.blockHash).trim().toLowerCase(),
      blockTimestamp: safeString(data?.validAt?.blockTimestamp).trim(),
    },
  };
}

async function inspectIssuesSalesCanaryTransaction(txHash = ISSUES_SALES_CANARY_TX_HASH) {
  console.log(`[sales:onchain] tx=${txHash} inspect-start contract=${ISSUES_SALES_CANARY_CONTRACT}`);

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    console.log(`[sales:onchain] tx=${txHash} receipt not found`);
    return;
  }

  const receiptLogs = Array.isArray(receipt.logs) ? receipt.logs : [];
  console.log(
    `[sales:onchain] tx=${txHash} receipt blockNumber=${safeString(receipt.blockNumber).trim()} logCount=${receiptLogs.length}`
  );

  const issueTransferEvents = [];
  const contractSeen = new Set();

  for (const log of receiptLogs) {
    const logAddress = safeLowercaseAddress(log?.address);
    if (logAddress && logAddress !== ISSUES_SALES_CANARY_CONTRACT) {
      contractSeen.add(logAddress);
    }

    if (logAddress !== ISSUES_SALES_CANARY_CONTRACT) continue;
    if (safeLowercaseString(log?.topics?.[0]) !== ERC721_TRANSFER_TOPIC.toLowerCase()) continue;

    try {
      const parsed = ERC721_TRANSFER_IFACE.parseLog(log);
      if (parsed?.name !== "Transfer") continue;

      issueTransferEvents.push({
        from: safeLowercaseAddress(parsed.args.from),
        to: safeLowercaseAddress(parsed.args.to),
        tokenId: safeString(parsed.args.tokenId).trim(),
        logIndex: safeString(log.logIndex ?? log.index).trim(),
      });
    } catch {}
  }

  console.log(`[sales:onchain] tx=${txHash} issuesTransferCount=${issueTransferEvents.length}`);
  for (const transferEvent of issueTransferEvents) {
    console.log(
      `[sales:onchain] transfer tokenId=${transferEvent.tokenId} from=${transferEvent.from} to=${transferEvent.to} logIndex=${transferEvent.logIndex}`
    );
  }

  for (const address of contractSeen) {
    console.log(`[sales:onchain] contractSeen=${address}`);
  }

  const seaportAddress = [...contractSeen].find((address) => KNOWN_SEAPORT_ADDRESSES.has(address));
  if (seaportAddress) {
    console.log(`[sales:onchain] seaportStyleHint=possible address=${seaportAddress}`);
  }
}

function normalizeIssuesOnchainCandidateToSales(candidate, collection) {
  const transfers = Array.isArray(candidate?.transfers) ? candidate.transfers : [];
  const contract = safeLowercaseAddress(collection?.contractAddress);
  const normalizedSales = transfers.map((transfer) => ({
    projectKey: contract,
    collection: safeString(collection?.name).trim(),
    standard: safeString(collection?.standard).trim().toLowerCase(),
    quantity: "1",
    sellerWallet: safeLowercaseAddress(transfer?.from),
    buyerWallet: safeLowercaseAddress(transfer?.to),
    salePriceNative: "",
    currencySymbol: "",
    marketplace: safeString(candidate?.matchedBy || candidate?.marketplaceAddressMatched).trim().toLowerCase(),
    tokenId: safeString(transfer?.tokenId).trim(),
    contract,
    txHash: safeLowercaseString(candidate?.transactionHash),
    blockNumber: safeString(candidate?.blockNumber).trim(),
    logIndex: safeString(transfer?.logIndex).trim(),
  }));

  if (normalizedSales.length > 0) {
    console.log(
      `[sales:onchain] fallback normalized tx=${safeLowercaseString(candidate?.transactionHash)} rows=${normalizedSales.length} salePriceNative=missing currencySymbol=missing reason=price-decoding-not-implemented`
    );
  }

  return normalizedSales;
}

async function findIssuesOnchainSaleCandidatesInRange(fromBlock, toBlock) {
  const boundedFromBlock = Math.max(0, Number(fromBlock) || 0);
  const boundedToBlock = Math.max(boundedFromBlock, Number(toBlock) || boundedFromBlock);

  console.log(`[sales:onchain] range fromBlock=${boundedFromBlock} toBlock=${boundedToBlock}`);

  const transferLogs = await provider.getLogs({
    address: ISSUES_SALES_CANARY_CONTRACT,
    fromBlock: boundedFromBlock,
    toBlock: boundedToBlock,
    topics: [[ERC721_TRANSFER_TOPIC]],
  });

  const groupedTransfers = new Map();

  for (const log of transferLogs) {
    try {
      const parsed = ERC721_TRANSFER_IFACE.parseLog(log);
      if (parsed?.name !== "Transfer") continue;

      const from = safeLowercaseAddress(parsed.args.from);
      if (from === ZERO_ADDRESS_LOWER) continue;

      const txHash = safeLowercaseString(log.transactionHash);
      if (!txHash) continue;

      const existing = groupedTransfers.get(txHash) || {
        transactionHash: txHash,
        blockNumber: Number(log.blockNumber || 0),
        tokenIds: [],
        fromAddresses: [],
        toAddresses: [],
        transfers: [],
        transferCount: 0,
      };

      existing.transferCount += 1;
      const tokenId = safeString(parsed.args.tokenId).trim();
      const to = safeLowercaseAddress(parsed.args.to);
      const logIndex = safeString(log.logIndex ?? log.index).trim();
      existing.tokenIds.push(tokenId);
      existing.fromAddresses.push(from);
      existing.toAddresses.push(to);
      existing.transfers.push({
        tokenId,
        from,
        to,
        logIndex,
      });
      if (!existing.blockNumber && Number(log.blockNumber || 0) > 0) {
        existing.blockNumber = Number(log.blockNumber || 0);
      }

      groupedTransfers.set(txHash, existing);
    } catch {}
  }

  const candidates = [];

  for (const groupedTransfer of groupedTransfers.values()) {
    const receipt = await provider.getTransactionReceipt(groupedTransfer.transactionHash);
    if (!receipt) continue;

    const receiptAddresses = new Set(
      (Array.isArray(receipt.logs) ? receipt.logs : [])
        .map((log) => safeLowercaseAddress(log?.address))
        .filter(Boolean)
    );

    let marketplaceAddressMatched = "";
    let matchedBy = "";

    for (const matcher of KNOWN_MARKETPLACE_MATCHERS) {
      if (receiptAddresses.has(matcher.address)) {
        marketplaceAddressMatched = matcher.address;
        matchedBy = matcher.matchedBy;
        break;
      }
    }

    if (!marketplaceAddressMatched) continue;

    const candidate = {
      transactionHash: groupedTransfer.transactionHash,
      blockNumber: safeString(groupedTransfer.blockNumber).trim(),
      tokenIds: [...new Set(groupedTransfer.tokenIds)],
      fromAddresses: [...new Set(groupedTransfer.fromAddresses)],
      toAddresses: [...new Set(groupedTransfer.toAddresses)],
      transfers: groupedTransfer.transfers.map((transfer) => ({ ...transfer })),
      marketplaceAddressMatched,
      matchedBy,
      transferCount: groupedTransfer.transferCount,
    };

    candidates.push(candidate);

    console.log(
      `[sales:onchain] candidate matched tx=${candidate.transactionHash} marketplace=${candidate.marketplaceAddressMatched} matchedBy=${candidate.matchedBy}`
    );
    console.log(
      `[sales:onchain] candidate tx=${candidate.transactionHash} block=${candidate.blockNumber} transferCount=${candidate.transferCount} tokenIds=${candidate.tokenIds.join("|")}`
    );
  }

  console.log(`[sales:onchain] candidate count=${candidates.length}`);
  return candidates;
}

async function pollSalesOnce() {
  const salesConfig = config?.sales;
  if (!salesConfig || salesConfig.enabled !== true) {
    console.log("[sales] poll skipped: sales disabled or not configured");
    return { advancedAny: false };
  }

  const collections = Array.isArray(salesConfig.collections) ? salesConfig.collections : [];
  if (collections.length === 0) {
    console.log("[sales] poll skipped: no sales collections configured");
    return { advancedAny: false };
  }

  const head = await provider.getBlockNumber();
  const safeHead = head - CONFIRMATIONS;
  if (safeHead <= 0) {
    console.log(`[sales] poll skipped: safeHead=${safeHead}`);
    return { advancedAny: false };
  }

  let advancedAny = false;

  for (const collection of collections) {
    const collectionName = safeString(collection?.name).trim() || "(unnamed sales collection)";
    const collectionKey = safeLowercaseAddress(collection?.contractAddress) || collectionName.toLowerCase();
    const currentState = loadSalesState(collectionKey);
    const configuredStartBlock = Number.isInteger(collection.startBlock) && collection.startBlock >= 0
      ? collection.startBlock
      : 0;
    const persistedLastProcessedBlock = Number(currentState.lastProcessedBlock || 0);
    const effectiveLastProcessedBlock =
      persistedLastProcessedBlock === 0 && configuredStartBlock > 0
        ? Math.max(0, configuredStartBlock - 1)
        : persistedLastProcessedBlock;
    const fromBlock = effectiveLastProcessedBlock + 1;
    const toBlock = Math.min(fromBlock + MAX_BLOCK_RANGE - 1, safeHead);

    console.log(`[sales] checking collection=${collectionName} fromBlock=${fromBlock} toBlock=${toBlock} safeHead=${safeHead}`);

    if (fromBlock > safeHead) {
      console.log(`[sales] cursor unchanged collection=${collectionName} lastProcessedBlock=${persistedLastProcessedBlock} reason=no-new-blocks`);
      continue;
    }

    const nextState = {
      version: currentState.version,
      lastProcessedBlock: persistedLastProcessedBlock,
      processed: { ...(currentState.processed || {}) },
    };

    try {
      const page = await getNFTSalesPage(collection, {
        fromBlock,
        toBlock,
        order: "asc",
        limit: 1000,
      });

      let normalizedSales = Array.isArray(page.sales) ? page.sales : [];
      if (normalizedSales.length === 0 && isIssuesSalesCollection(collection)) {
        const onchainCandidates = await findIssuesOnchainSaleCandidatesInRange(fromBlock, toBlock);
        normalizedSales = onchainCandidates.flatMap((candidate) =>
          normalizeIssuesOnchainCandidateToSales(candidate, collection)
        );
        console.log(
          `[sales:onchain] fallback collection=${collectionName} fromBlock=${fromBlock} toBlock=${toBlock} candidateCount=${onchainCandidates.length} normalizedSales=${normalizedSales.length}`
        );
      }
      let newSalesCount = 0;

      for (const sale of normalizedSales) {
        const key = saleKeyFromRecord(sale);
        if (nextState.processed[key]) continue;
        nextState.processed[key] = true;
        newSalesCount += 1;
      }

      console.log(
        `[sales] collection=${collectionName} normalizedSales=${normalizedSales.length} newSales=${newSalesCount} pageKey=${page.pageKey ? "present" : "absent"}`
      );

      if (page.pageKey) {
        console.log(
          `[sales] cursor unchanged collection=${collectionName} lastProcessedBlock=${persistedLastProcessedBlock} reason=pageKey-present`
        );
      } else {
        nextState.lastProcessedBlock = toBlock;
        advancedAny = true;
        console.log(
          `[sales] cursor advance collection=${collectionName} from=${persistedLastProcessedBlock} to=${nextState.lastProcessedBlock}`
        );
      }

      saveSalesState(collectionKey, nextState);
    } catch (e) {
      console.error(
        `[sales] poll failed collection=${collectionName} fromBlock=${fromBlock} toBlock=${toBlock} safeHead=${safeHead}:`,
        e?.message || e
      );
    }
  }

  return { advancedAny };
}

// =========================
// Discord client + rate limit
// =========================

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});
console.log("[startup] Discord client created");
client.on("error", (err) => {
  console.error("[discord] error:", err?.message || err);
});
client.on("warn", (msg) => {
  console.warn("[discord] warn:", msg);
});
client.on("shardError", (err, shardId) => {
  console.error(`[discord] shardError shard=${shardId}:`, err?.message || err);
});
client.on("shardDisconnect", (event, shardId) => {
  console.warn(
    `[discord] shardDisconnect shard=${shardId} code=${event?.code ?? "unknown"} reason=${event?.reason ?? "unknown"}`
  );
});
client.on("shardReconnecting", (shardId) => {
  console.warn(`[discord] shardReconnecting shard=${shardId}`);
});
client.on("shardResume", (shardId, replayedEvents) => {
  console.log(`[discord] shardResume shard=${shardId} replayedEvents=${replayedEvents}`);
});
client.on("invalidated", () => {
  console.error("[discord] invalidated");
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
    if (interaction.commandName === "status") {
      await interaction.deferReply({ ephemeral: true });

      let headText = "unknown";
      const STATUS_HEAD_TIMEOUT_MS = 4000;
      let statusHeadTimeoutId = null;
      try {
        const head = await Promise.race([
          provider.getBlockNumber(),
          new Promise((_, reject) => {
            statusHeadTimeoutId = setTimeout(
              () => reject(new Error(`status head lookup timed out after ${STATUS_HEAD_TIMEOUT_MS}ms`)),
              STATUS_HEAD_TIMEOUT_MS
            );
          }),
        ]);
        headText = String(head);
      } catch {
        // keep fallback "unknown"
      } finally {
        if (statusHeadTimeoutId) clearTimeout(statusHeadTimeoutId);
      }

      const rows = [
        "name | standard | isAuction | lastProcessedBlock",
        "---- | -------- | --------- | ------------------",
      ];

      for (const collection of config.collections) {
        const st = loadState(collection.contractAddress);
        const name = String(collection.name || "").slice(0, 32);
        const standard = String(collection.standard || "").toLowerCase();
        const isAuction = collection.isAuction === true ? "true" : "false";
        const lastProcessedBlock = Number(st?.lastProcessedBlock || 0);
        rows.push(`${name} | ${standard} | ${isAuction} | ${lastProcessedBlock}`);
      }

      let content = [
        `Head: ${headText}`,
        `DATA_DIR: ${DATA_DIR}`,
        `DATA_DIR exists: ${fs.existsSync(DATA_DIR) ? "yes" : "no"}`,
        "",
        "```",
        ...rows,
        "```",
      ].join("\n");

      if (content.length > 1900) {
        const maxRows = Math.max(2, rows.length - 1);
        let cut = maxRows;
        while (cut >= 2) {
          content = [
            `Head: ${headText}`,
            `DATA_DIR: ${DATA_DIR}`,
            `DATA_DIR exists: ${fs.existsSync(DATA_DIR) ? "yes" : "no"}`,
            "",
            "```",
            ...rows.slice(0, cut),
            `... (${rows.length - cut} more collections)`,
            "```",
          ].join("\n");
          if (content.length <= 1900) break;
          cut -= 1;
        }
      }

      await interaction.editReply({ content });
      return;
    }
    if (interaction.commandName === "holders") {
      await handleHoldersCommand(interaction);
      return;
    }
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
    const fallbackError =
      interaction.commandName === "holders"
        ? "Error generating holders CSV."
        : "Error generating ledger CSV.";
    // if interaction already replied, followUp, else reply
    try {
      if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
  content: fallbackError,
  ephemeral: true,
});

      } else {
        await interaction.reply({
  content: fallbackError,
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

const ERC165_ABI = [
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
];

const ERC721_TRANSFER_IFACE = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const ERC1155_TRANSFER_IFACE = new ethers.Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);

const ERC721_TRANSFER_TOPIC = ERC721_TRANSFER_IFACE.getEvent("Transfer").topicHash;
const ERC1155_TRANSFER_SINGLE_TOPIC = ERC1155_TRANSFER_IFACE.getEvent("TransferSingle").topicHash;
const ERC1155_TRANSFER_BATCH_TOPIC = ERC1155_TRANSFER_IFACE.getEvent("TransferBatch").topicHash;

// =========================
// Helpers (metadata, ENS, price)
// =========================

function parseTokenIdOption(rawTokenId) {
  if (rawTokenId == null) return null;
  const value = String(rawTokenId).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error("token_id must be a non-negative integer.");
  }
  return BigInt(value);
}

function applyBalanceDelta(balanceMap, walletAddressLower, delta) {
  if (!walletAddressLower || delta === 0n) return;
  const next = (balanceMap.get(walletAddressLower) || 0n) + delta;
  if (next > 0n) {
    balanceMap.set(walletAddressLower, next);
  } else {
    balanceMap.delete(walletAddressLower);
  }
}

function holderRowsFromBalanceMap(balanceMap) {
  const rows = [];
  for (const [wallet, quantity] of balanceMap.entries()) {
    if (quantity > 0n) rows.push({ wallet, quantity });
  }

  rows.sort((a, b) => {
    if (a.quantity === b.quantity) {
      if (a.wallet < b.wallet) return -1;
      if (a.wallet > b.wallet) return 1;
      return 0;
    }
    return a.quantity > b.quantity ? -1 : 1;
  });

  return rows;
}

function buildHoldersCsv(rows) {
  const lines = ["WalletAddress,Quantity"];
  for (const row of rows) {
    lines.push(`${csvEscape(row.wallet)},${csvEscape(row.quantity.toString())}`);
  }
  return `${lines.join("\n")}\n`;
}

function holdersFilename(contractAddressLower, tokenId = null) {
  const date = new Date().toISOString().slice(0, 10);
  if (tokenId == null) return `holders-${date}-${contractAddressLower}.csv`;
  return `holders-${date}-${contractAddressLower}-token-${tokenId.toString()}.csv`;
}

function writeTempCsv(baseName, csvText) {
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const tempPath = path.join(TEMP_DIR, `${nonce}-${baseName}`);
  fs.writeFileSync(tempPath, csvText, "utf8");
  return tempPath;
}

function safeDeleteFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

async function scanLogsBounded({ address, fromBlock, toBlock, topics, maxRange = HOLDERS_MAX_BLOCK_RANGE, onLogs }) {
  if (fromBlock > toBlock) return;
  const ceilingRange = Math.max(1, Number(maxRange) || 1);
  let currentRange = ceilingRange;

  for (let start = fromBlock; start <= toBlock;) {
    const end = Math.min(start + currentRange - 1, toBlock);
    let logs = [];
    try {
      logs = await provider.getLogs({
        address,
        fromBlock: start,
        toBlock: end,
        topics,
      });
    } catch (e) {
      if (currentRange === 1) {
        throw new Error(`getLogs failed for block ${start}: ${e.message}`);
      }
      currentRange = Math.max(1, Math.floor(currentRange / 2));
      continue;
    }

    if (logs.length > 1) {
      logs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        return a.index - b.index;
      });
    }

    const keepGoing = await onLogs(logs, start, end);
    if (keepGoing === false) break;

    if (logs.length < 2000 && currentRange < ceilingRange) {
      currentRange = Math.min(ceilingRange, currentRange * 2);
    }

    start = end + 1;
  }
}

async function safeSupportsInterface(contract, interfaceId) {
  try {
    return await contract.supportsInterface(interfaceId);
  } catch {
    return null;
  }
}

async function callSucceeds(fn) {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

async function hasLogsInRecentRange(contractAddress, topics, safeHead, lookbackBlocks) {
  if (safeHead <= 0) return false;
  const fromBlock = Math.max(0, safeHead - lookbackBlocks + 1);
  let found = false;

  await scanLogsBounded({
    address: contractAddress,
    fromBlock,
    toBlock: safeHead,
    topics,
    onLogs: async (logs) => {
      if (logs.length > 0) {
        found = true;
        return false;
      }
      return true;
    },
  });

  return found;
}

async function detectNftStandard(contractAddress, safeHead) {
  const address = ethers.getAddress(contractAddress);
  const code = await provider.getCode(address, safeHead);
  if (!code || code === "0x") {
    return {
      standard: null,
      detectionMethod: "no-contract",
      reason: "No contract code found at this address.",
    };
  }

  const erc165Contract = new ethers.Contract(address, ERC165_ABI, provider);
  const supports165 = await safeSupportsInterface(erc165Contract, "0x01ffc9a7");

  if (supports165 === true) {
    const is721 = await safeSupportsInterface(erc165Contract, "0x80ac58cd");
    const is1155 = await safeSupportsInterface(erc165Contract, "0xd9b67a26");

    if (is721 === true && is1155 !== true) {
      return { standard: "erc721", detectionMethod: "erc165" };
    }
    if (is1155 === true && is721 !== true) {
      return { standard: "erc1155", detectionMethod: "erc165" };
    }
  }

  let erc721Score = 0;
  let erc1155Score = 0;
  const probeWallet = "0x000000000000000000000000000000000000dEaD";
  const codeLower = code.toLowerCase();

  // Bytecode selector hints help avoid false-positive ERC20 classification.
  if (codeLower.includes("6352211e")) erc721Score += 2; // ownerOf(uint256)
  if (codeLower.includes("42842e0e") || codeLower.includes("b88d4fde")) erc721Score += 1; // safeTransferFrom(...)
  if (codeLower.includes("00fdd58e")) erc1155Score += 2; // balanceOf(address,uint256)
  if (codeLower.includes("2eb2c2d6")) erc1155Score += 1; // safeBatchTransferFrom(...)

  const erc721Probe = new ethers.Contract(
    address,
    ["function balanceOf(address owner) view returns (uint256)"],
    provider
  );
  if (await callSucceeds(() => erc721Probe.balanceOf(probeWallet))) erc721Score += 1;

  const erc1155BalanceProbe = new ethers.Contract(
    address,
    ["function balanceOf(address account, uint256 id) view returns (uint256)"],
    provider
  );
  if (await callSucceeds(() => erc1155BalanceProbe.balanceOf(probeWallet, 0n))) erc1155Score += 2;

  const erc721TokenUriProbe = new ethers.Contract(
    address,
    ["function tokenURI(uint256 tokenId) view returns (string)"],
    provider
  );
  if (await callSucceeds(() => erc721TokenUriProbe.tokenURI(0n))) erc721Score += 1;

  const erc1155UriProbe = new ethers.Contract(
    address,
    ["function uri(uint256 id) view returns (string)"],
    provider
  );
  if (await callSucceeds(() => erc1155UriProbe.uri(0n))) erc1155Score += 1;

  if (erc721Score >= 2 && erc721Score > erc1155Score) {
    return { standard: "erc721", detectionMethod: "heuristic-method-probe" };
  }
  if (erc1155Score >= 2 && erc1155Score > erc721Score) {
    return { standard: "erc1155", detectionMethod: "heuristic-method-probe" };
  }

  const lookbackBlocks = Math.max(HOLDERS_MAX_BLOCK_RANGE * 4, 500);
  const has721Logs = await hasLogsInRecentRange(
    address,
    [[ERC721_TRANSFER_TOPIC]],
    safeHead,
    lookbackBlocks
  );
  const has1155Logs = await hasLogsInRecentRange(
    address,
    [[ERC1155_TRANSFER_SINGLE_TOPIC, ERC1155_TRANSFER_BATCH_TOPIC]],
    safeHead,
    lookbackBlocks
  );

  if (has721Logs && !has1155Logs && erc721Score >= 2) {
    return { standard: "erc721", detectionMethod: "heuristic-log-shape" };
  }
  if (has1155Logs && !has721Logs && erc1155Score >= 2) {
    return { standard: "erc1155", detectionMethod: "heuristic-log-shape" };
  }

  return {
    standard: null,
    detectionMethod: "unknown",
    reason: "Unable to confidently detect ERC721 vs ERC1155.",
  };
}

async function findContractDeploymentBlock(contractAddress, safeHead) {
  const codeAtSafeHead = await provider.getCode(contractAddress, safeHead);
  if (!codeAtSafeHead || codeAtSafeHead === "0x") return null;

  let lo = 0;
  let hi = safeHead;
  let answer = safeHead;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let codeAtMid;
    try {
      codeAtMid = await provider.getCode(contractAddress, mid);
    } catch (e) {
      throw new Error(`Failed to read historical code at block ${mid}: ${e.message}`);
    }

    if (codeAtMid && codeAtMid !== "0x") {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return answer;
}

async function resolveHoldersScanStartBlock(contractAddress, safeHead) {
  try {
    const deploymentBlock = await findContractDeploymentBlock(contractAddress, safeHead);
    if (deploymentBlock != null) return deploymentBlock;
  } catch (e) {
    console.log(`⚠️ deployment block lookup failed for ${contractAddress}: ${e.message}`);
  }

  return 0;
}

async function buildErc721HolderBalances(contractAddress, fromBlock, toBlock) {
  const balances = new Map();
  let transferLogCount = 0;

  await scanLogsBounded({
    address: contractAddress,
    fromBlock,
    toBlock,
    topics: [[ERC721_TRANSFER_TOPIC]],
    onLogs: async (logs) => {
      for (const log of logs) {
        let parsed;
        try {
          parsed = ERC721_TRANSFER_IFACE.parseLog(log);
        } catch {
          continue;
        }

        if (parsed.name !== "Transfer") continue;
        transferLogCount += 1;

        const from = String(parsed.args.from).toLowerCase();
        const to = String(parsed.args.to).toLowerCase();

        if (from !== ZERO_ADDRESS_LOWER) applyBalanceDelta(balances, from, -1n);
        if (to !== ZERO_ADDRESS_LOWER) applyBalanceDelta(balances, to, 1n);
      }
      return true;
    },
  });

  return { balances, transferLogCount };
}

async function buildErc1155HolderBalances(contractAddress, fromBlock, toBlock, tokenId = null) {
  const balances = new Map();
  let transferLogCount = 0;
  let matchedTransferCount = 0;

  await scanLogsBounded({
    address: contractAddress,
    fromBlock,
    toBlock,
    topics: [[ERC1155_TRANSFER_SINGLE_TOPIC, ERC1155_TRANSFER_BATCH_TOPIC]],
    onLogs: async (logs) => {
      for (const log of logs) {
        let parsed;
        try {
          parsed = ERC1155_TRANSFER_IFACE.parseLog(log);
        } catch {
          continue;
        }

        transferLogCount += 1;

        if (parsed.name === "TransferSingle") {
          const id = BigInt(parsed.args.id.toString());
          if (tokenId != null && id !== tokenId) continue;

          const value = BigInt(parsed.args.value.toString());
          if (value <= 0n) continue;
          matchedTransferCount += 1;

          const from = String(parsed.args.from).toLowerCase();
          const to = String(parsed.args.to).toLowerCase();

          if (from !== ZERO_ADDRESS_LOWER) applyBalanceDelta(balances, from, -value);
          if (to !== ZERO_ADDRESS_LOWER) applyBalanceDelta(balances, to, value);
          continue;
        }

        if (parsed.name === "TransferBatch") {
          const ids = parsed.args.ids || [];
          const values = parsed.args.values || [];
          let moved = 0n;

          for (let i = 0; i < ids.length; i++) {
            const id = BigInt(ids[i].toString());
            if (tokenId != null && id !== tokenId) continue;
            moved += BigInt(values[i].toString());
          }

          if (moved <= 0n) continue;
          matchedTransferCount += 1;

          const from = String(parsed.args.from).toLowerCase();
          const to = String(parsed.args.to).toLowerCase();

          if (from !== ZERO_ADDRESS_LOWER) applyBalanceDelta(balances, from, -moved);
          if (to !== ZERO_ADDRESS_LOWER) applyBalanceDelta(balances, to, moved);
        }
      }
      return true;
    },
  });

  return { balances, transferLogCount, matchedTransferCount };
}

async function handleHoldersCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });

  let tempCsvPath = null;
  try {
    const rawContract = String(interaction.options.getString("contract", true) || "").trim();
    const tokenId = parseTokenIdOption(interaction.options.getString("token_id"));

    if (!ethers.isAddress(rawContract)) {
      await interaction.editReply({
        content: "Invalid contract address. Please provide a valid EVM address.",
      });
      return;
    }

    const contractAddress = ethers.getAddress(rawContract);

    const head = await provider.getBlockNumber();
    const safeHead = head - CONFIRMATIONS;
    if (safeHead <= 0) {
      await interaction.editReply({
        content: "Chain head is not ready yet. Please try again shortly.",
      });
      return;
    }

    const detected = await detectNftStandard(contractAddress, safeHead);
    if (!detected.standard) {
      await interaction.editReply({
        content: `Could not detect ERC721/ERC1155 for ${contractAddress}. ${detected.reason || ""}`.trim(),
      });
      return;
    }

    const fromBlock = await resolveHoldersScanStartBlock(contractAddress, safeHead);
    const contractLower = contractAddress.toLowerCase();

    let balances;
    let transferLogCount = 0;
    let matchedTransferCount = 0;
    let modeLabel = "";
    let note = null;
    let outputTokenId = null;

    if (detected.standard === "erc721") {
      const erc721Result = await buildErc721HolderBalances(contractAddress, fromBlock, safeHead);
      balances = erc721Result.balances;
      transferLogCount = erc721Result.transferLogCount;
      modeLabel = "ERC721 collection-wide";

      if (tokenId != null) {
        note = "token_id was provided but ignored because ERC721 exports are collection-wide.";
      }
    } else {
      if (tokenId != null) {
        const erc1155TokenResult = await buildErc1155HolderBalances(contractAddress, fromBlock, safeHead, tokenId);
        balances = erc1155TokenResult.balances;
        transferLogCount = erc1155TokenResult.transferLogCount;
        matchedTransferCount = erc1155TokenResult.matchedTransferCount;
        modeLabel = `ERC1155 token ${tokenId.toString()}`;
        outputTokenId = tokenId;
      } else {
        const erc1155ContractResult = await buildErc1155HolderBalances(contractAddress, fromBlock, safeHead, null);
        balances = erc1155ContractResult.balances;
        transferLogCount = erc1155ContractResult.transferLogCount;
        matchedTransferCount = erc1155ContractResult.matchedTransferCount;
        modeLabel = "ERC1155 full contract (total units)";
      }
    }

    const rows = holderRowsFromBalanceMap(balances);
    const csvText = buildHoldersCsv(rows);
    const outputName = holdersFilename(contractLower, outputTokenId);
    tempCsvPath = writeTempCsv(outputName, csvText);

    const summaryLines = [
      `Detected standard: **${detected.standard.toUpperCase()}** (${detected.detectionMethod})`,
      `Mode: **${modeLabel}**`,
      `Wallets exported: **${rows.length}**`,
      `Scanned blocks: **${fromBlock}-${safeHead}**`,
    ];

    if (detected.standard === "erc1155" && tokenId != null) {
      summaryLines.push(`Token transfer events matched: **${matchedTransferCount}**`);
    }
    if (transferLogCount === 0) {
      summaryLines.push("No transfer logs were found for this contract.");
    }
    if (detected.standard === "erc1155" && tokenId != null && rows.length === 0) {
      summaryLines.push("No current holders found for that token_id.");
    }
    if (note) summaryLines.push(note);

    const attachment = new AttachmentBuilder(tempCsvPath, { name: outputName });
    await interaction.editReply({
      content: summaryLines.join("\n"),
      files: [attachment],
    });
  } catch (e) {
    console.error("holders command error:", e?.message || e);
    console.error(e);
    await interaction.editReply({
      content: "Error generating holders CSV.",
    });
  } finally {
    safeDeleteFile(tempCsvPath);
  }
}

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

function s3Preview(collection, tokenIdStr) {
  let s3Id = null;

  if (typeof collection?.previewS3Id === "number") {
    s3Id = collection.previewS3Id;
  } else if (collection?.preview?.enabled === true && typeof collection?.preview?.s3Id === "number") {
    s3Id = collection.preview.s3Id;
  }

  if (s3Id == null) return null;
  return `https://8nap.s3.eu-central-1.amazonaws.com/previews/${s3Id}/small/${tokenIdStr}`;
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
  const previewUrl = s3Preview(collection, tokenIdStr);
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

  if (collection.isAuction === true) {
    imageUrl = s3Preview(collection, tokenIdStr);
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

  const imageUrl = tokenIdStr !== "unknown" ? s3Preview(collection, tokenIdStr) : null;

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
  const previewUrl = s3Preview(collection, tokenIdStr);
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

    const isAuction = collection.isAuction === true;

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

    // deterministic ordering before processing and commit decisions
    if (logs.length > 1) {
      logs.sort((a, b) => {
        const aBlock = Number(a.blockNumber ?? 0);
        const bBlock = Number(b.blockNumber ?? 0);
        if (aBlock !== bBlock) return aBlock - bBlock;
        const aLogIndex = Number(a.logIndex ?? a.index ?? 0);
        const bLogIndex = Number(b.logIndex ?? b.index ?? 0);
        return aLogIndex - bLogIndex;
      });
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
    let failedLog = null;
    for (const log of logs) {
      const k = seenKey(log);
      if (st.processed?.[k]) continue;

      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch (e) {
        console.log(`[event] failed, will retry tx=${log.transactionHash}`);
        console.error(`❌ Error parsing ${collection.name} log:`, e?.message || e);
        failedLog = log;
        break;
      }

      const markProcessed = () => {
        if (!st.processed) st.processed = {};
        st.processed[k] = true;
      };

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

  // Prefer on-chain inference at this block so stale disk state can't leak
  // previous-auction token ids into new bid messages.
  let tokenIdStr = freshState.currentAuctionTokenId;
  try {
    const t = await contract.totalSupply({ blockTag: log.blockNumber });
    const inferred = tokenIdFromTotalSupply(t, collection.tokenIdBase ?? 0);
    if (inferred && inferred !== "unknown") {
      tokenIdStr = inferred;
      freshState.currentAuctionTokenId = inferred;
    }
  } catch {
    // fallback to persisted value
  }

  if (!tokenIdStr || tokenIdStr === "unknown") tokenIdStr = "unknown";

  const prevBidWeiStr =
    tokenIdStr !== "unknown" ? (freshState.lastBidWeiByToken[tokenIdStr] ?? null) : null;

  const FIRST_BID_WEI = ethers.parseEther("0.1");
  const isFirstBid =
    tokenIdStr !== "unknown" && amount === FIRST_BID_WEI && !prevBidWeiStr;

  if (tokenIdStr !== "unknown") {
    freshState.lastBidWeiByToken[tokenIdStr] = amount.toString();
    freshState.lastBidderByToken[tokenIdStr] = bidder;
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

  markProcessed();
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

    markProcessed();
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
  if (parsed.name !== "Transfer") {
    markProcessed();
    continue;
  }
  const from = parsed.args.from;
  const to = parsed.args.to;
  const tokenId = parsed.args.tokenId;
  if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
    markProcessed();
    continue;
  }

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

}


        // ===== ERC1155 mint-only =====
if (standard === "erc1155") {
  if (parsed.name === "TransferSingle") {
    const from = parsed.args.from;
    const to = parsed.args.to;
    const id = parsed.args.id;
    const value = parsed.args.value;

    if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
      markProcessed();
      continue;
    }

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

    if (from.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
      markProcessed();
      continue;
    }

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

        markProcessed();
      } catch (e) {
  console.log(`[event] failed, will retry tx=${log.transactionHash}`);
  console.error(`❌ Error handling ${collection.name} ${parsed.name}:`, e.message);
  console.error(e); // <-- this prints stack + more details
  failedLog = log;
  break;
}
    }

    const failedBlockNumber = failedLog ? Number(failedLog.blockNumber) : null;
    const hasFailedBlockNumber = Number.isFinite(failedBlockNumber);
    const safeCompletedBlock =
      failedBlockNumber == null
        ? toBlock
        : hasFailedBlockNumber
          ? Math.max(fromBlock - 1, Math.min(toBlock, failedBlockNumber - 1))
          : fromBlock - 1;

    if (failedLog) {
      const failedLogIndex = failedLog.logIndex ?? failedLog.index ?? "unknown";
      console.error(
        `[poll] stopped processing ${collection.name} at block=${failedLog.blockNumber} tx=${failedLog.transactionHash} logIndex=${failedLogIndex}; range ${fromBlock}-${toBlock} will be retried from block ${safeCompletedBlock + 1}`
      );
    }

    // advance cursor only to the safely completed block range
    st.lastProcessedBlock = safeCompletedBlock;
    if (isAuction) {
      const latest = loadState(addr);
      const latestPending =
        latest.pendingAuctions && typeof latest.pendingAuctions === "object"
          ? latest.pendingAuctions
          : null;
      const latestBidWei =
        latest.lastBidWeiByToken && typeof latest.lastBidWeiByToken === "object"
          ? latest.lastBidWeiByToken
          : null;
      const latestBidder =
        latest.lastBidderByToken && typeof latest.lastBidderByToken === "object"
          ? latest.lastBidderByToken
          : null;

      // Keep dedupe/cursor fields from `st`, but always take auction lifecycle data
      // from the freshest state on disk so we don't roll token/bid state backwards.
      st.currentAuctionTokenId =
        latest.currentAuctionTokenId ?? st.currentAuctionTokenId ?? null;
      st.pendingAuctions = latestPending ?? st.pendingAuctions ?? {};
      st.lastBidWeiByToken = latestBidWei ?? st.lastBidWeiByToken ?? {};
      st.lastBidderByToken = latestBidder ?? st.lastBidderByToken ?? {};
    }
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
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show bot status and per-collection progress")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("holders")
      .setDescription("Export current holder balances as CSV (ERC721 or ERC1155)")
      .addStringOption((opt) =>
        opt
          .setName("contract")
          .setDescription("Contract address (0x...)")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("token_id")
          .setDescription("Optional ERC1155 token id (integer). Ignored for ERC721.")
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
let pollInFlight = false;

async function startPolling() {
  console.log("[startup:startPolling] entering startPolling()");
  // initialize cursors to safe head on first boot, to avoid posting historical spam
  for (const collection of config.collections) {
    console.log(`[startup:startPolling] before initializeStateToHeadIfEmpty collection=${collection.name}`);
    await initializeStateToHeadIfEmpty(collection);
    console.log(`[startup:startPolling] after initializeStateToHeadIfEmpty collection=${collection.name}`);
  }

  console.log(`✅ Polling started. interval=${POLL_MS}ms confirmations=${CONFIRMATIONS} range=${MAX_BLOCK_RANGE}`);

  // run immediately, then interval
  console.log("[startup:startPolling] before first immediate pollOnce()");
  await pollOnce().catch((e) => {
  console.error("pollOnce error:", e.message);
  console.error(e);
});
  console.log("[startup:startPolling] after first immediate pollOnce() finishes");

pollTimer = setInterval(() => {
  if (pollInFlight) {
    console.log("[poll] skipped: previous poll still running");
    return;
  }

  pollInFlight = true;
  pollOnce().catch((e) => {
    console.error("pollOnce error:", e.message);
    console.error(e);
  }).finally(() => {
    pollInFlight = false;
  });
}, POLL_MS);
  console.log("[startup:startPolling] recurring poll interval started");
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
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});

const LEDGER_CSV_CHANNEL_ID = process.env.LEDGER_CSV_CHANNEL_ID || "1463682240671387952";
const DISCORD_STARTUP_TIMEOUT_MS = 60000;
const DISCORD_LOGIN_BACKOFF_MIN_MS = 5000;
const DISCORD_LOGIN_BACKOFF_MAX_MS = 20000;
let discordStartupTimeout = null;

async function runMonthlyLedgerPosterTick() {
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
  if (discordStartupTimeout) {
    clearTimeout(discordStartupTimeout);
    discordStartupTimeout = null;
  }
  console.log("[startup] clientReady fired");
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  try {
    // 3C.2: register slash commands on boot
    console.log("[startup] about to run registerCommands()");
    await registerCommands();
    console.log("[startup] registerCommands() completed");

    console.log("[startup] about to run startPolling()");
    await startPolling();
    console.log("[startup] startPolling() completed");

    if (process.env.SALES_RESET_STATE_ON_READY === "1") {
      console.log("[sales] canary sales state reset scheduled");
      setTimeout(() => {
        console.log("[sales] canary sales state reset start");
        try {
          saveSalesState("0xbe27770b0263133b9d3a1d4c7c2760007b94e37f", {
            version: 1,
            lastProcessedBlock: 0,
            processed: {},
          });
          console.log("[sales] canary sales state reset completed");
        } catch (e) {
          console.error("[sales] canary sales state reset failed:", e?.message || e);
          console.error(e);
        }
      }, 0);
    }

    if (process.env.SALES_MANUAL_POLL_ON_READY === "1") {
      console.log("[sales] manual sales catch-up scheduled delayMs=15000");
      setTimeout(() => {
        const maxIterations = 100;
        console.log("[sales] manual sales catch-up start");
        (async () => {
          let iterations = 0;
          for (; iterations < maxIterations; iterations++) {
            const iterationNumber = iterations + 1;
            console.log(`[sales] manual sales catch-up iteration ${iterationNumber}`);
            const result = await pollSalesOnce();
            if (!result?.advancedAny) {
              console.log("[sales] manual sales catch-up stop reason=no-cursor-advance");
              iterations = iterationNumber;
              break;
            }
          }
          console.log(`[sales] manual sales catch-up completed iterations=${iterations}`);
          try {
            await findIssuesOnchainSaleCandidatesInRange(
              ISSUES_SALES_CANARY_RANGE_START,
              ISSUES_SALES_CANARY_BLOCK
            );
          } catch (e) {
            console.error("[sales:onchain] candidate scan failed:", e?.message || e);
            console.error(e);
          }
          try {
            await inspectIssuesSalesCanaryTransaction();
          } catch (e) {
            console.error("[sales:onchain] inspection failed:", e?.message || e);
            console.error(e);
          }
        })()
          .catch((e) => {
            console.error("[sales] manual sales catch-up failed:", e?.message || e);
            console.error(e);
          });
      }, 15000);
    }

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
    console.log("[startup] monthly poster timers scheduled");
  } catch (e) {
    console.error("❌ Failed to start bot:", e.message);
    console.error(e);
    process.exit(1);
  }
});
console.log("[startup] clientReady handler registered");

console.log("[startup] about to call client.login(...)");
const discordLoginDelayMs =
  Math.floor(Math.random() * (DISCORD_LOGIN_BACKOFF_MAX_MS - DISCORD_LOGIN_BACKOFF_MIN_MS + 1)) +
  DISCORD_LOGIN_BACKOFF_MIN_MS;
console.log(`[startup] delaying Discord login by ${discordLoginDelayMs}ms before retryable startup attempt`);
setTimeout(() => {
  discordStartupTimeout = setTimeout(() => {
    console.error(`[fatal] Discord startup timed out before ready after ${DISCORD_STARTUP_TIMEOUT_MS}ms`);
    process.exit(1);
  }, DISCORD_STARTUP_TIMEOUT_MS);
  console.log("[discord] login start");
  client
    .login(process.env.DISCORD_BOT_TOKEN)
    .then(() => {
      console.log("[discord] login resolved");
    })
    .catch((e) => {
      console.error("[discord] login rejected:", e?.message || e);
      console.error("[fatal] client.login failed:", e?.message || e);
      console.error(e);
      process.exit(1);
    });
}, discordLoginDelayMs);
