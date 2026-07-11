"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchHolderSnapshot, buildHoldersCsv, holdersFilename, parseQuantity } = require("../holders-alchemy");

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONTRACT = "0x1234567890123456789012345678901234567890";

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, async json() { return body; } };
}

function queuedFetch(items, urls = []) {
  return async (url) => {
    urls.push(String(url));
    const item = items.shift();
    if (item instanceof Error) throw item;
    return item;
  };
}

const base = { apiKey: "test-key", contractAddress: CONTRACT, sleep: async () => {}, random: () => 0 };

test("aggregates ERC721 whole-contract token balances", async () => {
  const result = await fetchHolderSnapshot({ ...base, standard: "erc721", fetchImpl: queuedFetch([response(200, { owners: [{ ownerAddress: A, tokenBalances: [{ tokenId: "1", balance: "1" }, { tokenId: "2", balance: "1" }] }, { ownerAddress: B, tokenBalances: [{ tokenId: "3", balance: "1" }] }] })]) });
  assert.deepEqual(result.rows.map((r) => [r.wallet, r.quantity]), [[A, 2n], [B, 1n]]);
});

test("aggregates ERC1155 balances across token IDs", async () => {
  const result = await fetchHolderSnapshot({ ...base, standard: "erc1155", fetchImpl: queuedFetch([response(200, { owners: [{ ownerAddress: A, tokenBalances: [{ tokenId: "1", balance: "3" }, { tokenId: "4", balance: "2" }, { tokenId: "9", balance: "1" }] }] })]) });
  assert.equal(result.totalQuantity, 6n);
});

test("filters unrelated token IDs for an ERC1155 token", async () => {
  const urls = [];
  const result = await fetchHolderSnapshot({ ...base, standard: "erc1155", tokenId: 212n, fetchImpl: queuedFetch([response(200, { owners: [{ ownerAddress: A, tokenBalances: [{ tokenId: "212", balance: "12" }, { tokenId: "9", balance: "4" }] }] })], urls) });
  assert.equal(result.rows[0].quantity, 12n);
  assert.equal(result.totalQuantity, 12n);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /getOwnersForContract/);
  assert.doesNotMatch(urls[0], /getOwnersForNFT/);
});

test("normalizes and merges duplicate wallets", async () => {
  const result = await fetchHolderSnapshot({ ...base, standard: "erc1155", fetchImpl: queuedFetch([response(200, { owners: [{ ownerAddress: A.toUpperCase().replace("0X", "0x"), tokenBalances: [{ balance: "2" }] }, { ownerAddress: A, tokenBalances: [{ balance: "3" }] }] })]) });
  assert.deepEqual(result.rows.map((r) => [r.wallet, r.quantity]), [[A, 5n]]);
  assert.equal(result.metrics.duplicateEntriesMerged, 1);
});

test("completes multi-page pagination", async () => {
  const urls = [];
  const result = await fetchHolderSnapshot({ ...base, standard: "erc721", fetchImpl: queuedFetch([response(200, { owners: [{ ownerAddress: A, tokenBalances: [{ balance: "1" }] }], pageKey: "next" }), response(200, { owners: [{ ownerAddress: B, tokenBalances: [{ balance: "2" }] }] })], urls) });
  assert.equal(result.metrics.pageCount, 2);
  assert.match(urls[1], /pageKey=next/);
});

test("token-specific ERC1155 uses one paginated getOwnersForContract flow", async () => {
  const urls = [];
  const result = await fetchHolderSnapshot({ ...base, standard: "erc1155", tokenId: 7n, fetchImpl: queuedFetch([
    response(200, { owners: [{ ownerAddress: A, tokenBalances: [{ tokenId: "7", balance: "2" }, { tokenId: "8", balance: "99" }] }], pageKey: "contract-next" }),
    response(200, { owners: [{ ownerAddress: B, tokenBalances: [{ tokenId: "7", balance: "1" }] }] }),
  ], urls) });
  assert.equal(result.metrics.pageCount, 2);
  assert.equal(result.metrics.endpoint, "getOwnersForContract");
  assert.deepEqual(result.rows.map((row) => [row.wallet, row.quantity]), [[A, 2n], [B, 1n]]);
  assert.ok(urls.every((url) => url.includes("getOwnersForContract")));
  assert.ok(urls.every((url) => !url.includes("getOwnersForNFT")));
  assert.match(urls[1], /pageKey=contract-next/);
});

test("accepts Number.MAX_SAFE_INTEGER quantities", () => {
  assert.equal(parseQuantity(Number.MAX_SAFE_INTEGER, "test"), BigInt(Number.MAX_SAFE_INTEGER));
});

test("rejects unsafe numeric quantities", () => {
  assert.throws(() => parseQuantity(Number.MAX_SAFE_INTEGER + 1, "test"), (e) => e.category === "malformed_response");
});

test("rejects fractional numeric quantities", () => {
  assert.throws(() => parseQuantity(1.5, "test"), (e) => e.category === "malformed_response");
});

test("rejects repeated pagination keys", async () => {
  await assert.rejects(fetchHolderSnapshot({ ...base, standard: "erc721", fetchImpl: queuedFetch([response(200, { owners: [], pageKey: "same" }), response(200, { owners: [], pageKey: "same" })]) }), (e) => e.category === "pagination");
});

test("rejects malformed quantities", async () => {
  await assert.rejects(fetchHolderSnapshot({ ...base, standard: "erc1155", fetchImpl: queuedFetch([response(200, { owners: [{ ownerAddress: A, tokenBalances: [{ balance: "1.5" }] }] })]) }), (e) => e.category === "malformed_response");
});

test("rejects empty Alchemy responses", async () => {
  await assert.rejects(fetchHolderSnapshot({ ...base, standard: "erc721", fetchImpl: queuedFetch([response(200, { owners: [] })]) }), (e) => e.category === "empty_result");
});

test("times out bounded requests", async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(fetchHolderSnapshot({ ...base, standard: "erc721", fetchImpl, timeoutMs: 2, maxRetries: 0 }), (e) => e.category === "timeout");
});

test("retries 429 responses", async () => {
  const result = await fetchHolderSnapshot({ ...base, standard: "erc1155", fetchImpl: queuedFetch([response(429, {}), response(200, { owners: [{ ownerAddress: A, tokenBalances: [{ balance: "1" }] }] })]) });
  assert.equal(result.metrics.retryCount, 1);
});

test("does not retry authentication failures", async () => {
  let calls = 0;
  await assert.rejects(fetchHolderSnapshot({ ...base, standard: "erc721", fetchImpl: async () => { calls += 1; return response(401, {}); } }), (e) => e.category === "authentication");
  assert.equal(calls, 1);
});

test("CSV ordering and timestamped filenames are deterministic", async () => {
  const csv = buildHoldersCsv([{ wallet: A, quantity: 3n }, { wallet: B, quantity: 1n }]);
  assert.equal(csv, `wallet,quantity\n${A},3\n${B},1\n`);
  const date = new Date("2026-07-10T23:54:22Z");
  assert.equal(holdersFilename(CONTRACT, null, date), `holders-${CONTRACT}-20260710-235422-UTC.csv`);
  assert.equal(holdersFilename(CONTRACT, 212n, date), `holders-${CONTRACT}-token-212-20260710-235422-UTC.csv`);
});
