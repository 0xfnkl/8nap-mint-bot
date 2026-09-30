"use strict";

const { ethers } = require("ethers");
const { readJson, writeJson } = require("./daily-jobs");

function parseCatalog(html) {
  if (typeof html !== "string" || html.length > 2_000_000) throw new Error("Unexpected collections-page size");
  const chunks = [];
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const push = match[1].match(/^self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?$/);
    if (!push) continue;
    let data;
    try { data = JSON.parse(push[1]); } catch { throw new Error("Collections-page data changed format"); }
    if (data[0] === 1 && typeof data[1] === "string") chunks.push(data[1]);
  }
  const projects = new Map();
  function walk(value, depth = 0) {
    if (depth > 50) throw new Error("Collections-page data is too deeply nested");
    if (!value || typeof value !== "object") return;
    if (value.project_address && value.project_identifier && value.project_type !== undefined) {
      if (value.is_visible !== 1) return;
      const address = String(value.project_address).toLowerCase();
      if (!ethers.isAddress(address) || address === ethers.ZeroAddress || typeof value.name !== "string" || !value.name.trim() || ![1, 2, 3].includes(value.project_type) || ![0, 1].includes(value.is_minting) || !Array.isArray(value.sub_projects)) throw new Error("Collections page contains an invalid project");
      const standard = value.project_type === 3 ? "erc1155" : "erc721";
      const editions = value.sub_projects.filter(e => e.is_visible === 1).map(e => {
        if (!Number.isSafeInteger(e.token_id) || e.token_id < 0 || !Number.isSafeInteger(e.total_supply) || e.total_supply < 0 || !Number.isSafeInteger(e.max_supply) || e.max_supply < 1 || e.total_supply > e.max_supply) throw new Error("Collections page contains invalid edition supply");
        return { tokenId: String(e.token_id), total: e.total_supply, max: e.max_supply };
      });
      let total = value.total_supply, max = value.max_supply;
      if (standard === "erc721" && (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(max) || max < 1 || total > max)) throw new Error("Collections page contains invalid collection supply");
      const soldOut = standard === "erc1155" ? editions.length > 0 && editions.every(e => e.total === e.max) : total === max;
      if (value.is_minting === 0 && !soldOut) throw new Error(`Minting status and supply disagree for ${value.name}`);
      const project = { address, name: value.name.trim(), artist: String(value.full_name || "Unknown").trim(), standard, minting: value.is_minting === 1, soldOut, total, max, editions, projectId: value.project_id, slug: value.project_identifier, hasAuctions: Number(value.supply_left_for_auction || 0) > 0 };
      const prior = projects.get(address);
      if (prior && JSON.stringify(prior) !== JSON.stringify(project)) throw new Error("Collections page has conflicting contract entries");
      projects.set(address, project);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  }
  for (const line of chunks.join("").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    let value;
    try { value = JSON.parse(line.slice(colon + 1)); } catch { continue; } // Flight also includes non-JSON text records.
    walk(value);
  }
  if (!projects.size) throw new Error("No collections found; website format may have changed");
  // Verify parsed records actually have corresponding cards in the page, not just nested metadata.
  for (const p of projects.values()) {
    const route = `/${p.standard === "erc1155" ? "editions" : "collection"}/${p.slug}`;
    if (!html.includes(`href="${route}"`)) throw new Error("Collection data and visible cards disagree");
  }
  return [...projects.values()];
}

async function fetchCatalog(fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl("https://8nap.art/collections", { signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error("8NAP collections request failed or timed out"); }
  if (!response.ok) throw new Error(`8NAP collections returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers?.get("content-length") || 0);
  if (declaredLength > 2_000_000) throw new Error("Collections response is too large");
  // Bound streamed downloads too: Content-Length is not guaranteed.
  if (response.body?.getReader) {
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) { await reader.cancel(); throw new Error("Collections response is too large"); }
      chunks.push(Buffer.from(value));
    }
    return parseCatalog(Buffer.concat(chunks).toString("utf8"));
  }
  return parseCatalog(await response.text());
}

async function validateStandard(provider, project, blockTag) {
  const contract = new ethers.Contract(project.address, ["function supportsInterface(bytes4) view returns (bool)"], provider);
  const supported = await chainRead("contract standard", () => contract.supportsInterface(project.standard === "erc721" ? "0x80ac58cd" : "0xd9b67a26", { blockTag }));
  if (!supported) throw new Error(`Contract standard validation failed for ${project.name}`);
}

async function chainRead(label, operation) {
  try { return await operation(); }
  catch { throw new Error(`Ethereum ${label} read failed; check RPC access and contract support`); }
}

async function confirmSoldOut(provider, project, blockTag) {
  const contract = new ethers.Contract(project.address, ["function totalSupply() view returns (uint256)", "function totalSupply(uint256) view returns (uint256)"], provider);
  if (project.standard === "erc721") return await chainRead("supply", () => contract["totalSupply()"]({ blockTag })) >= BigInt(project.max);
  for (const e of project.editions) if (await chainRead("edition supply", () => contract["totalSupply(uint256)"](e.tokenId, { blockTag })) < BigInt(e.max)) return false;
  return project.editions.length > 0;
}

async function deploymentBlock(provider, address, head) {
  if (await chainRead("deployment", () => provider.getCode(address, head)) === "0x") throw new Error("Discovered address has no deployed contract");
  let low = 0, high = head;
  // Once per newly discovered mint contract, not once per daily scan.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (await chainRead("deployment", () => provider.getCode(address, mid)) === "0x") low = mid + 1;
    else high = mid;
  }
  return low;
}

function collectionFromProject(project) {
  return { name: project.name, artist: project.artist, standard: project.standard, contractAddress: project.address, collectionUrl: `https://8nap.art/${project.standard === "erc1155" ? "editions" : "collection"}/${project.slug}` };
}

function supplySignature(project) {
  const editions = project.editions.map(e => [e.tokenId, e.total, e.max]).sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([project.standard, project.total ?? null, project.max ?? null, editions]);
}

function createCollectionRegistry({ file, options, mintCollections, salesCollections, loadMintState, provider, confirmations, initializeMint, initializeSales, fetchImpl, validate = validateStandard, soldOut = confirmSoldOut, findDeployment = deploymentBlock }) {
  function state() {
    const value = readJson(file, { version: 1, entries: {}, observed: [], lastScanBlock: null });
    if (value.version !== 1 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries) || !Array.isArray(value.observed) || value.observed.some(address => !/^0x[0-9a-f]{40}$/.test(address))) throw new Error("Invalid collection registry state");
    for (const [address, entry] of Object.entries(value.entries)) {
      if (!/^0x[0-9a-f]{40}$/.test(address) || !entry || entry.collection?.contractAddress?.toLowerCase() !== address || !["erc721", "erc1155"].includes(String(entry.collection.standard).toLowerCase()) || !entry.collection.name) throw new Error("Invalid collection registry entry");
      for (const field of ["mintAdded", "salesAdded", "retired", "reactivated", "pendingReactivation", "mintPaused"]) if (entry[field] !== undefined && typeof entry[field] !== "boolean") throw new Error("Invalid collection registry flags");
      if (entry.mintAdded && (!Number.isSafeInteger(entry.mintStartBlock) || entry.mintStartBlock < 0)) throw new Error("Invalid discovered mint start block");
      if (entry.supplySignature !== undefined && typeof entry.supplySignature !== "string") throw new Error("Invalid collection supply signature");
    }
    return value;
  }
  let cached = state();
  function effective(kind) {
    const base = kind === "mint" ? mintCollections : salesCollections;
    if (!options.enabled || options.mode !== "apply") return [...base];
    const current = cached;
    const map = new Map(base.map(c => [c.contractAddress.toLowerCase(), c]));
    for (const [address, entry] of Object.entries(current.entries)) {
      if (entry[`${kind}Added`] && !map.has(address)) map.set(address, { ...entry.collection, ...(kind === "mint" ? { startBlock: entry.mintStartBlock, discoveryCatchup: true } : {}) });
      if (kind === "mint" && entry.reactivated && map.has(address)) map.set(address, { ...map.get(address), discoveryCatchup: true });
      if (kind === "mint" && entry.mintPaused && !base.some(c => c.contractAddress.toLowerCase() === address)) map.delete(address);
      if (kind === "mint" && options.autoRetire && entry.retired) map.delete(address);
    }
    return [...map.values()];
  }
  return {
    mintCollections: () => effective("mint"),
    salesCollections: () => effective("sales"),
    status: state,
    async scan(now = new Date()) {
      const catalog = await fetchCatalog(fetchImpl), previous = state();
      if (!previous.entries || !Array.isArray(previous.observed)) throw new Error("Invalid collection registry state");
      const addresses = new Set(catalog.map(p => p.address));
      if (previous.observed.some(address => !addresses.has(address))) throw new Error("Collection scan is incomplete or collections were delisted; existing tracking preserved");
      const head = await chainRead("head", () => provider.getBlockNumber()), safeHead = Math.max(0, head - confirmations);
      if (!safeHead) throw new Error("No confirmed chain head for discovery");
      const currentMint = new Map(effective("mint").map(c => [c.contractAddress.toLowerCase(), c]));
      const currentSales = new Set(effective("sales").map(c => c.contractAddress.toLowerCase()));
      const missingSales = catalog.filter(p => !currentSales.has(p.address));
      if (missingSales.length > options.maxAdditionsPerScan) throw new Error(`Scan proposes ${missingSales.length} additions, above the configured safety limit`);
      const configuredMint = new Map(mintCollections.map(c => [c.contractAddress.toLowerCase(), c]));
      const additions = new Set(), initializations = [];
      const next = structuredClone(previous), proposals = { addSales: [], addMint: [], retireMint: [], reactivateMint: [], needsReview: [] };
      for (const p of catalog) {
        const old = previous.entries[p.address] || {}, entry = next.entries[p.address] = { ...old };
        const known = currentMint.get(p.address);
        const collection = known || configuredMint.get(p.address) || salesCollections.find(c => c.contractAddress.toLowerCase() === p.address) || old.collection || collectionFromProject(p);
        if (collection.standard.toLowerCase() !== p.standard) throw new Error(`Website and configured token standard disagree for ${p.name}`);
        entry.collection = collection;
        const signature = supplySignature(p), supplyChanged = old.supplySignature !== signature;
        entry.supplySignature = signature;
        if (supplyChanged) { entry.soldOutSince = null; entry.retireAtBlock = null; }
        const apply = options.mode === "apply";
        const unknownAuction = p.hasAuctions && !collection.isAuction;
        if (unknownAuction) {
          proposals.needsReview.push(`${p.name}: auction configuration needs review`);
          // A discovered fixed-price contract can later enter an auction phase.
          // Pause only automated mint entries; manual config remains authoritative.
          if (apply && options.autoAdd && old.mintAdded) entry.mintPaused = true;
        } else if (collection.isAuction) { entry.mintPaused = false; }
        if (!currentSales.has(p.address)) {
          await validate(provider, p, safeHead);
          proposals.addSales.push(p.name); additions.add(p.address);
          if (apply && options.autoAdd) { initializations.push({ kind: "sales", collection }); entry.salesAdded = true; }
        }
        // Observing new supply must not consume the work to resume mint polling.
        // Keep the intent through later scans and restarts until reactivation is applied.
        if (old.retired && (p.minting || supplyChanged)) entry.pendingReactivation = true;
        if (old.retired && entry.pendingReactivation) {
          proposals.reactivateMint.push(p.name);
          if (apply && options.autoRetire) { entry.retired = false; entry.reactivated = true; entry.pendingReactivation = false; entry.retireAtBlock = null; entry.soldOutSince = null; }
        } else if (!known && !old.retired) {
          if (!unknownAuction) {
            await validate(provider, p, safeHead);
            // Discover the deployment block before enabling: never initialize new mint tracking at today's head.
            const start = old.mintStartBlock ?? await findDeployment(provider, p.address, safeHead);
            entry.mintStartBlock = start;
            if (safeHead - start > options.maxMintCatchupBlocks) proposals.needsReview.push(`${p.name}: mint history exceeds the catch-up budget`);
            else {
              proposals.addMint.push(p.name); additions.add(p.address);
              if (apply && options.autoAdd) { initializations.push({ kind: "mint", collection: { ...collection, startBlock: start, discoveryCatchup: true } }); entry.mintAdded = true; }
            }
          }
        }
        const trackingMint = known || entry.mintAdded || configuredMint.has(p.address);
        if (p.soldOut && !p.minting && trackingMint && !entry.retired) {
          // Two successful scans, at least 20 hours apart, plus supply checked at a confirmed block.
          const since = entry.soldOutSince;
          entry.soldOutSince = since || now.toISOString();
          if (since && now.getTime() - Date.parse(since) >= 20 * 60 * 60 * 1000 && await soldOut(provider, p, safeHead)) {
            proposals.retireMint.push(p.name);
            entry.retireAtBlock = entry.retireAtBlock ?? safeHead;
            const mintState = loadMintState(p.address);
            if (apply && options.autoRetire && mintState.lastProcessedBlock >= entry.retireAtBlock && !Object.keys(mintState.pendingAuctions || {}).length) entry.retired = true;
          }
        } else if (p.minting) { entry.soldOutSince = null; entry.retireAtBlock = null; }
      }
      // Check the union of actual sales and bounded mint additions before initializing anything.
      // Historical collections requiring review do not consume the automatic-addition budget.
      if (additions.size > options.maxAdditionsPerScan) throw new Error(`Scan proposes ${additions.size} additions, above the configured safety limit`);
      for (const operation of initializations) {
        if (operation.kind === "mint") await initializeMint(operation.collection);
        else await initializeSales(operation.collection);
      }
      next.version = 1; next.observed = [...addresses]; next.lastScanBlock = safeHead; next.lastScan = now.toISOString(); next.proposals = proposals;
      // Observation records never imply applied additions/removals. Existing manual metadata wins.
      writeJson(file, next);
      cached = next;
      return { mode: options.mode, collections: catalog.length, ...proposals };
    },
  };
}

module.exports = { parseCatalog, fetchCatalog, validateStandard, confirmSoldOut, deploymentBlock, collectionFromProject, createCollectionRegistry };
