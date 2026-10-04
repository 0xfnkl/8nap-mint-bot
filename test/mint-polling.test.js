"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { ethers } = require("ethers");
const { createCollectionRegistry, parseCatalog, supplySignature } = require("../collection-discovery");

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
      pollOnce, postMint, loadState, saveState, initializeStateToHeadIfEmpty, ledger: mintLedger, provider, client,
      setCollections(collections, batches = 1) {
        automation = { mintCollections: () => collections, catchupBatches: () => batches };
      },
      setSender(sender) { rateLimiter.send = sender; },
    };
  `, context, { filename: indexPath });
  const result = context.bot;
  result.stateDir = dir;
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

for (const existingCursor of [0, 20]) {
  test(`reviewed ERC1155 reopening catches intervening mints without old history from cursor ${existingCursor}`, async t => {
    const runtime = bot(t), windows = [];
    runtime.saveState(A, { lastProcessedBlock: existingCursor, processed: {} });
    const original = { project_address: A, project_identifier: "editions", project_type: 3, is_visible: 1, is_minting: 0, name: "Test editions", full_name: "Test", total_supply: 0, max_supply: null, supply_left_for_auction: 0,
      sub_projects: [{ token_id: 0, total_supply: 10, max_supply: 10, is_visible: 1 }] };
    let catalog = original;
    const page = p => `<a href="/editions/editions">card</a><script>self.__next_f.push(${JSON.stringify([1, `0:${JSON.stringify({ projects: [p] })}\n`])})</script>`;
    const options = { enabled: true, mode: "apply", autoAdd: true, autoRetire: true, maxAdditionsPerScan: 5, maxMintCatchupBlocks: 1,
      reviewedClosedCollections: [{ contractAddress: A, supplySignature: supplySignature(parseCatalog(page(original))[0]), auctionSupply: 0, resumeAfterBlock: 80 }] };
    const args = { file: path.join(runtime.stateDir, "registry.json"), options, mintCollections: [], salesCollections: [collection], provider: runtime.provider, confirmations: 2,
      loadMintState: runtime.loadState, initializeMint: runtime.initializeStateToHeadIfEmpty, initializeSales: () => assert.fail("Sales coverage must stay intact"),
      fetchImpl: async () => ({ ok: true, text: async () => page(catalog) }), validate: async () => {}, soldOut: async () => true,
      findDeployment: () => assert.fail("Must not replay deployment history") };
    let registry = createCollectionRegistry(args);
    await registry.scan(new Date("2026-10-04T06:00:00Z"));
    catalog = { ...original, sub_projects: [...original.sub_projects, { token_id: 1, total_supply: 2, max_supply: 2, is_visible: 1 }, { token_id: 2, total_supply: 3, max_supply: 3, is_visible: 1 }] };
    const result = await registry.scan(new Date("2026-10-05T06:00:00Z"));
    assert.deepEqual(result.reactivateMint, ["Test editions"]);
    const logs = [
      { ...batchLog([0], [10]), blockNumber: 70, transactionHash: "0x" + "1".repeat(64) },
      { ...batchLog([1], [2]), blockNumber: 90, transactionHash: "0x" + "2".repeat(64) },
      { ...batchLog([2], [3]), blockNumber: 100, transactionHash: "0x" + "3".repeat(64) },
    ];
    runtime.provider.getLogs = async ({ fromBlock, toBlock }) => { windows.push([fromBlock, toBlock]); return logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock); };
    runtime.setCollections(registry.mintCollections(), 3);
    await runtime.pollOnce();
    assert.deepEqual(windows, [[81, 85], [86, 90], [91, 95]]);
    assert.equal(runtime.loadState(A).lastProcessedBlock, 95);
    assert.deepEqual(runtime.ledger.read().map(r => r.TokenID), ["1"]);
    registry = createCollectionRegistry(args); runtime.setCollections(registry.mintCollections(), 3);
    let sends = 0; runtime.setSender(async () => { if (++sends === 1) throw new Error("Discord response lost"); });
    await runtime.pollOnce(); assert.equal(runtime.loadState(A).lastProcessedBlock, 99);
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(runtime.loadState(A).lastProcessedBlock, 100);
    assert.deepEqual(runtime.ledger.read().map(r => [r.TokenID, r.Quantity]), [["1", "2"], ["2", "3"]]);
    // Catch-up finishes before ordinary two-observation retirement; a later edition
    // still resumes from this saved cursor rather than reusing the legacy checkpoint.
    await registry.scan(new Date("2026-10-06T06:00:00Z"));
    await registry.scan(new Date("2026-10-07T06:00:00Z"));
    assert.deepEqual(registry.mintCollections(), []); assert.equal(registry.salesCollections().length, 1);
    catalog = { ...catalog, sub_projects: [...catalog.sub_projects, { token_id: 3, total_supply: 1, max_supply: 1, is_visible: 1 }] };
    await registry.scan(new Date("2026-10-08T06:00:00Z"));
    assert.equal(registry.mintCollections().length, 1); assert.equal(runtime.loadState(A).lastProcessedBlock, 100);
    assert.equal(runtime.ledger.read().length, 2);
  });
}

test("a reviewed resumption floor never rewinds newer mint progress", async t => {
  const runtime = bot(t), windows = [];
  runtime.saveState(A, { lastProcessedBlock: 95, processed: {} });
  runtime.setCollections([{ ...collection, startBlock: 81, discoveryCatchup: true }], 3);
  runtime.provider.getLogs = async range => { windows.push([range.fromBlock, range.toBlock]); return []; };
  await runtime.initializeStateToHeadIfEmpty({ ...collection, startBlock: 81, discoveryCatchup: true });
  await runtime.pollOnce(); assert.deepEqual(windows, [[96, 100]]);
});

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
