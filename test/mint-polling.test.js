"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { ethers } = require("ethers");

const A = "0x" + "a".repeat(40), W = "0x" + "b".repeat(40), TX = "0x" + "c".repeat(64);
const collection = { name: "Test editions", artist: "Test", standard: "erc1155", contractAddress: A };
const batchInterface = new ethers.Interface(["event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)"]);

function bot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8nap-polling-test-"));
  const indexPath = path.join(__dirname, "..", "index.js"), source = fs.readFileSync(indexPath, "utf8");
  const cut = source.indexOf('console.log("[startup] about to call client.login(...)");');
  assert.ok(cut > 0);
  const indexRequire = createRequire(indexPath);
  const context = vm.createContext({
    require: name => name === "dotenv" ? { config() {} } : indexRequire(name),
    __dirname: path.dirname(indexPath), console: { log() {}, error() {} },
    process: { env: { DATA_DIR: dir, DISCORD_BOT_TOKEN: "test", RPC_HTTP_URL: "http://127.0.0.1:1", MAX_BLOCK_RANGE: "5" }, on() {}, exit(code) { throw new Error(`Unexpected process exit ${code}`); } },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date, URL, URLSearchParams, Buffer, AbortController,
    fetch: async () => { throw new Error("Tests must not access the network"); },
  });
  vm.runInContext(source.slice(0, cut) + `
    loadMetadata = async () => null;
    getEthPriceUsd = async () => null;
    formatDisplayAddress = async address => address;
    client.channels.fetch = async () => ({});
    rateLimiter.send = async () => {};
    globalThis.bot = {
      pollOnce, postMint, loadState, saveState, ledger: mintLedger, provider, client,
      setCollections(collections, batches = 1) {
        automation = { mintCollections: () => collections, catchupBatches: () => batches };
      },
      setSender(sender) { rateLimiter.send = sender; },
    };
  `, context, { filename: indexPath });
  const result = context.bot;
  result.provider.getBlockNumber = async () => 102;
  result.provider.getBlock = async () => ({ timestamp: Date.parse("2026-09-30T23:00:00Z") / 1000 });
  result.provider.getTransaction = async () => ({ value: ethers.parseEther("0.05") });
  result.setCollections([collection]);
  t.after(() => { result.provider.destroy(); result.client.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  return result;
}

function batchLog(ids = [1, 2], quantities = [3, 2]) {
  const encoded = batchInterface.encodeEventLog(batchInterface.getEvent("TransferBatch"), [W, ethers.ZeroAddress, W, ids, quantities]);
  return { ...encoded, transactionHash: TX, blockNumber: 100, index: 0 };
}

test("real poller decodes ERC1155 batches and retries a Discord failure without duplicate ledger rows", async t => {
  const runtime = bot(t); let sends = 0;
  runtime.saveState(A, { lastProcessedBlock: 99, processed: {} });
  runtime.provider.getLogs = async () => [batchLog()];
  runtime.setSender(async () => { sends++; if (sends === 2) throw new Error("Discord temporarily unavailable"); });
  await runtime.pollOnce();
  assert.equal(runtime.loadState(A).lastProcessedBlock, 99);
  assert.equal(runtime.ledger.read().length, 2);
  await runtime.pollOnce();
  assert.equal(runtime.loadState(A).lastProcessedBlock, 100);
  assert.equal(runtime.ledger.read().length, 2);
  assert.deepEqual(runtime.ledger.read().map(r => [r.TokenID, r.Quantity, r.ETHPrice]), [["1", "3", "0.03"], ["2", "2", "0.02"]]);
});

test("unavailable mint transaction or timestamp leaves the cursor and ledger unchanged", async t => {
  const runtime = bot(t);
  runtime.saveState(A, { lastProcessedBlock: 99, processed: {} });
  runtime.provider.getLogs = async () => [batchLog()];
  runtime.provider.getTransaction = async () => null;
  await runtime.pollOnce();
  assert.equal(runtime.loadState(A).lastProcessedBlock, 99);
  assert.equal(runtime.ledger.read().length, 0);
  runtime.provider.getTransaction = async () => ({ value: 0n });
  runtime.provider.getBlock = async () => null;
  await runtime.pollOnce();
  assert.equal(runtime.loadState(A).lastProcessedBlock, 99);
  assert.equal(runtime.ledger.read().length, 0);
});

test("zero-quantity ERC1155 entries do not create sales or block the poller", async t => {
  const runtime = bot(t);
  runtime.saveState(A, { lastProcessedBlock: 99, processed: {} });
  runtime.provider.getLogs = async () => [batchLog([1, 2], [0, 5])];
  await runtime.pollOnce();
  assert.equal(runtime.loadState(A).lastProcessedBlock, 100);
  assert.deepEqual(runtime.ledger.read().map(r => [r.TokenID, r.Quantity, r.ETHPrice]), [["2", "5", "0.05"]]);
});

test("discovery catch-up is bounded and a failed RPC window is attempted once per poll", async t => {
  const runtime = bot(t), windows = [];
  runtime.setCollections([collection], 3);
  runtime.saveState(A, { lastProcessedBlock: 80, processed: {} });
  runtime.provider.getLogs = async range => { windows.push([range.fromBlock, range.toBlock]); return []; };
  await runtime.pollOnce();
  assert.deepEqual(windows, [[81, 85], [86, 90], [91, 95]]);
  assert.equal(runtime.loadState(A).lastProcessedBlock, 95);
  runtime.provider.getLogs = async range => { windows.push([range.fromBlock, range.toBlock]); throw new Error("RPC unavailable"); };
  await runtime.pollOnce();
  assert.equal(windows.length, 4);
  assert.equal(runtime.loadState(A).lastProcessedBlock, 95);
});

test("repeated ERC1155 batch IDs aggregate equal and unequal quantities before recording", async t => {
  for (const quantities of [[2, 2], [2, 3]]) {
    const runtime = bot(t);
    runtime.saveState(A, { lastProcessedBlock: 99, processed: {} });
    runtime.provider.getLogs = async () => [batchLog([1, 1], quantities)];
    await runtime.pollOnce();
    assert.equal(runtime.loadState(A).lastProcessedBlock, 100);
    assert.deepEqual(runtime.ledger.read().map(r => [r.TokenID, r.Quantity, r.ETHPrice]), [["1", String(quantities[0] + quantities[1]), "0.05"]]);
  }
});

test("aggregated batch payments and quantities survive a partial Discord failure and retry", async t => {
  const runtime = bot(t); let sends = 0;
  runtime.saveState(A, { lastProcessedBlock: 99, processed: {} });
  runtime.provider.getLogs = async () => [batchLog([1, 2, 1], [2, 5, 3])];
  runtime.setSender(async () => { if (++sends === 2) throw new Error("Discord temporarily unavailable"); });
  await runtime.pollOnce();
  assert.equal(runtime.loadState(A).lastProcessedBlock, 99);
  await runtime.pollOnce();
  assert.equal(runtime.loadState(A).lastProcessedBlock, 100);
  assert.deepEqual(runtime.ledger.read().map(r => [r.TokenID, r.Quantity, r.ETHPrice]), [["1", "5", "0.025"], ["2", "5", "0.025"]]);
});

test("zero quantities among repeated batch IDs are ignored without inventing zero sales", async t => {
  for (const quantities of [[0, 5, 0], [0, 0, 0]]) {
    const runtime = bot(t);
    runtime.saveState(A, { lastProcessedBlock: 99, processed: {} });
    runtime.provider.getLogs = async () => [batchLog([1, 1, 2], quantities)];
    if (!quantities.some(Boolean)) runtime.provider.getTransaction = async () => { throw new Error("An empty mint must not allocate a payment"); };
    await runtime.pollOnce();
    assert.equal(runtime.loadState(A).lastProcessedBlock, 100);
    assert.deepEqual(runtime.ledger.read().map(r => [r.TokenID, r.Quantity, r.ETHPrice]), quantities.some(Boolean) ? [["1", "5", "0.05"]] : []);
  }
});
