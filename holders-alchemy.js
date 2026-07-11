"use strict";

const ALCHEMY_NFT_BASE_URL = "https://eth-mainnet.g.alchemy.com/nft/v3";
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_PAGES = 1000;

class HoldersAlchemyError extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.name = "HoldersAlchemyError";
    this.category = category;
    this.details = details;
  }
}

function parseQuantity(value, context) {
  if (typeof value === "bigint") {
    if (value >= 0n) return value;
    throw new HoldersAlchemyError("malformed_response", `Invalid quantity for ${context}.`);
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    throw new HoldersAlchemyError("malformed_response", `Invalid quantity for ${context}.`);
  }
  if (typeof value !== "string") {
    throw new HoldersAlchemyError("malformed_response", `Missing or invalid quantity for ${context}.`);
  }
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*|0[xX][0-9a-fA-F]+)$/.test(text)) {
    throw new HoldersAlchemyError("malformed_response", `Invalid quantity for ${context}.`);
  }
  try {
    const quantity = BigInt(text);
    if (quantity < 0n) throw new Error("negative");
    return quantity;
  } catch {
    throw new HoldersAlchemyError("malformed_response", `Invalid quantity for ${context}.`);
  }
}

function normalizeWallet(value, context) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new HoldersAlchemyError("malformed_response", `Missing or invalid wallet address for ${context}.`);
  }
  return value.trim().toLowerCase();
}

function addBalance(balances, wallet, quantity, metrics) {
  if (quantity === 0n) {
    metrics.zeroBalancesRemoved += 1;
    return;
  }
  if (balances.has(wallet)) metrics.duplicateEntriesMerged += 1;
  balances.set(wallet, (balances.get(wallet) || 0n) + quantity);
  metrics.normalizedQuantity += quantity;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestAlchemyPage({ apiKey, endpoint, params, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, sleep = delay, random = Math.random }) {
  if (typeof fetchImpl !== "function") {
    throw new HoldersAlchemyError("configuration", "HTTP fetch support is unavailable.");
  }

  const url = new URL(`${ALCHEMY_NFT_BASE_URL}/${encodeURIComponent(apiKey)}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let retries = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (response.status === 401 || response.status === 403) {
        throw new HoldersAlchemyError("authentication", "Alchemy rejected the NFT API credentials.", { status: response.status, retries });
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          retries += 1;
          await sleep(250 * (2 ** attempt) + Math.floor(random() * 150));
          continue;
        }
        throw new HoldersAlchemyError(response.status === 429 ? "rate_limit" : "server_error", "Alchemy remained temporarily unavailable after retries.", { status: response.status, retries });
      }
      if (!response.ok) {
        throw new HoldersAlchemyError("request_rejected", "Alchemy rejected the ownership request.", { status: response.status, retries });
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new HoldersAlchemyError("malformed_response", "Alchemy returned malformed JSON.", { status: response.status, retries });
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HoldersAlchemyError("malformed_response", "Alchemy returned an invalid response object.", { status: response.status, retries });
      }
      return { body, retries };
    } catch (error) {
      if (error instanceof HoldersAlchemyError) throw error;
      const timedOut = error?.name === "AbortError";
      if (attempt < maxRetries) {
        retries += 1;
        await sleep(250 * (2 ** attempt) + Math.floor(random() * 150));
        continue;
      }
      throw new HoldersAlchemyError(timedOut ? "timeout" : "network", timedOut ? "Alchemy ownership request timed out." : "Alchemy ownership request failed.", { retries });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HoldersAlchemyError("network", "Alchemy ownership request failed.", { retries });
}

async function fetchHolderSnapshot({ apiKey, contractAddress, standard, tokenId = null, fetchImpl, timeoutMs, maxRetries, maxPages = DEFAULT_MAX_PAGES, sleep, random }) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new HoldersAlchemyError("configuration", "ALCHEMY_NFT_API_KEY is not configured.");
  }
  if (standard !== "erc721" && standard !== "erc1155") {
    throw new HoldersAlchemyError("validation", "Unsupported NFT standard.");
  }
  if (standard === "erc721" && tokenId !== null) {
    throw new HoldersAlchemyError("validation", "ERC721 holder exports operate at the whole-collection level; remove token_id.");
  }

  const tokenSpecific = standard === "erc1155" && tokenId !== null;
  const requestedTokenId = tokenSpecific ? parseQuantity(tokenId, "token_id") : null;
  const endpoint = "getOwnersForContract";
  const balances = new Map();
  const seenPageKeys = new Set();
  const metrics = { endpoint, pageCount: 0, rawOwnershipEntryCount: 0, duplicateEntriesMerged: 0, zeroBalancesRemoved: 0, retryCount: 0, normalizedQuantity: 0n };
  let pageKey;
  let paginationComplete = false;

  while (metrics.pageCount < maxPages) {
    const params = { contractAddress, withTokenBalances: "true", pageKey };
    const result = await requestAlchemyPage({ apiKey: apiKey.trim(), endpoint, params, fetchImpl, timeoutMs, maxRetries, sleep, random });
    metrics.retryCount += result.retries;
    metrics.pageCount += 1;
    const owners = result.body.owners;
    if (!Array.isArray(owners)) throw new HoldersAlchemyError("malformed_response", "Alchemy response is missing the owners list.", metrics);

    for (let i = 0; i < owners.length; i++) {
      const owner = owners[i];
      if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw new HoldersAlchemyError("malformed_response", `Invalid ownership entry on page ${metrics.pageCount}.`, metrics);
      const wallet = normalizeWallet(owner.ownerAddress, `page ${metrics.pageCount} entry ${i + 1}`);
      if (!Array.isArray(owner.tokenBalances)) throw new HoldersAlchemyError("malformed_response", `Missing token balances on page ${metrics.pageCount} entry ${i + 1}.`, metrics);
      for (let j = 0; j < owner.tokenBalances.length; j++) {
        const tokenBalance = owner.tokenBalances[j];
        if (!tokenBalance || typeof tokenBalance !== "object") throw new HoldersAlchemyError("malformed_response", `Invalid token balance on page ${metrics.pageCount}.`, metrics);
        metrics.rawOwnershipEntryCount += 1;
        if (tokenSpecific) {
          if (tokenBalance.tokenId === undefined || tokenBalance.tokenId === null) throw new HoldersAlchemyError("malformed_response", `Missing token ID on page ${metrics.pageCount}.`, metrics);
          if (parseQuantity(tokenBalance.tokenId, `page ${metrics.pageCount} token ID ${j + 1}`) !== requestedTokenId) continue;
        }
        addBalance(balances, wallet, parseQuantity(tokenBalance.balance ?? tokenBalance.tokenBalance, `page ${metrics.pageCount} token balance ${j + 1}`), metrics);
      }
    }

    const nextPageKey = result.body.pageKey;
    if (nextPageKey === undefined || nextPageKey === null || nextPageKey === "") {
      paginationComplete = true;
      break;
    }
    if (typeof nextPageKey !== "string") throw new HoldersAlchemyError("malformed_response", "Alchemy returned an invalid pagination key.", metrics);
    if (seenPageKeys.has(nextPageKey)) throw new HoldersAlchemyError("pagination", "Alchemy repeated a pagination key.", metrics);
    seenPageKeys.add(nextPageKey);
    pageKey = nextPageKey;
  }

  if (!paginationComplete) throw new HoldersAlchemyError("pagination", `Alchemy ownership results exceeded the ${maxPages}-page safety limit.`, metrics);
  const rows = [...balances.entries()].filter(([, quantity]) => quantity > 0n).map(([wallet, quantity]) => ({ wallet, quantity }));
  rows.sort((a, b) => a.quantity === b.quantity ? a.wallet.localeCompare(b.wallet) : (a.quantity > b.quantity ? -1 : 1));
  if (rows.length === 0 || metrics.rawOwnershipEntryCount === 0) throw new HoldersAlchemyError("empty_result", "Alchemy returned no valid positive ownership data.", metrics);
  const outputTotal = rows.reduce((sum, row) => sum + row.quantity, 0n);
  if (outputTotal !== metrics.normalizedQuantity || rows.some((row) => row.quantity <= 0n)) {
    throw new HoldersAlchemyError("validation", "Ownership totals failed validation.", metrics);
  }
  return { rows, totalQuantity: outputTotal, metrics: { ...metrics, uniqueWalletCount: rows.length, totalQuantity: outputTotal, paginationComplete } };
}

function buildHoldersCsv(rows) {
  const escape = (value) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `wallet,quantity\n${rows.map((row) => `${escape(row.wallet)},${escape(row.quantity.toString())}`).join("\n")}\n`;
}

function holdersFilename(contractAddress, tokenId, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "-UTC");
  const contract = String(contractAddress).toLowerCase();
  return tokenId === null ? `holders-${contract}-${stamp}.csv` : `holders-${contract}-token-${tokenId.toString()}-${stamp}.csv`;
}

module.exports = { HoldersAlchemyError, fetchHolderSnapshot, buildHoldersCsv, holdersFilename, parseQuantity };
