"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseCatalog, createCollectionRegistry, deploymentBlock } = require("../collection-discovery");
const { readJson, writeJson } = require("../daily-jobs");

const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
const project = changes => ({ project_address: A, project_identifier: "example", project_type: 1, is_visible: 1, is_minting: 1, name: "Example", full_name: "Artist", total_supply: 3, max_supply: 10, sub_projects: [], supply_left_for_auction: 0, ...changes });
function html(projects) {
  const links = projects.map(p => `<a href="/${p.project_type === 3 ? "editions" : "collection"}/${p.project_identifier}">card</a>`).join("");
  return links + `<script>self.__next_f.push(${JSON.stringify([1, `0:${JSON.stringify({ projects })}\n`])})</script>`;
}
function fixture(t, projects = [project()], extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8nap-discovery-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { lastProcessedBlock: 100, pendingAuctions: {} }, initialized = [];
  const options = { enabled: true, mode: "apply", autoAdd: true, autoRetire: true, maxAdditionsPerScan: 5, maxMintCatchupBlocks: 1000, ...extra.options };
  let current = projects, head = 102;
  const file = path.join(dir, "registry.json");
  const restart = () => createCollectionRegistry({ file, options, mintCollections: extra.mint || [], salesCollections: extra.sales || [], loadMintState: () => state, provider: { async getBlockNumber() { return head; } }, confirmations: 2,
    initializeMint: async c => initialized.push(["mint", c]), initializeSales: async c => initialized.push(["sales", c]),
    fetchImpl: async () => ({ ok: true, async text() { return html(current); } }), validate: async () => {}, soldOut: extra.soldOut || (async () => true), findDeployment: extra.findDeployment || (async () => 95),
  });
  return { registry: restart(), restart, options, state, file, initialized, setProjects: value => { current = value; }, setHead: value => { head = value; } };
}

test("catalog parser extracts structured collections and ERC1155 edition supply", () => {
  const result = parseCatalog(html([project(), project({ project_address: B, project_identifier: "editions", project_type: 3, total_supply: 0, max_supply: null, sub_projects: [{ token_id: 0, total_supply: 2, max_supply: 3, is_visible: 1 }] })]));
  assert.equal(result.length, 2); assert.equal(result[1].standard, "erc1155"); assert.equal(result[1].soldOut, false);
});

test("changed markup, malformed addresses and incomplete supply fail closed", () => {
  assert.throws(() => parseCatalog("<html>maintenance</html>"), /No collections/);
  assert.throws(() => parseCatalog(html([project({ project_address: "invalid" })])), /invalid/);
  assert.throws(() => parseCatalog(html([project({ is_minting: 0 })])), /disagree/);
  assert.throws(() => parseCatalog(html([project({ max_supply: null })])), /supply/);
});

test("observation proposes changes without initializing cursors or altering monitoring", async t => {
  const f = fixture(t, [project()], { options: { mode: "observe" } });
  const result = await f.registry.scan();
  assert.deepEqual(result.addMint, ["Example"]); assert.deepEqual(result.addSales, ["Example"]);
  assert.equal(f.initialized.length, 0); assert.equal(f.registry.mintCollections().length, 0);
});

test("applied discovery persists additions through restart and starts mints at deployment", async t => {
  const f = fixture(t); await f.registry.scan();
  assert.equal(f.registry.mintCollections()[0].startBlock, 95); assert.equal(f.registry.salesCollections().length, 1);
  assert.equal(readJson(f.file, {}).entries[A].mintStartBlock, 95);
  const initializations = f.initialized.length; await f.registry.scan(); assert.equal(f.initialized.length, initializations);
  const restarted = createCollectionRegistry({ file: f.file, options: f.options, mintCollections: [], salesCollections: [] });
  assert.equal(restarted.mintCollections()[0].startBlock, 95); assert.equal(restarted.salesCollections().length, 1);
});

test("unknown auction configuration and excessive historical backfill need review", async t => {
  for (const [p, extra] of [[project({ supply_left_for_auction: 2 }), {}], [project(), { options: { maxMintCatchupBlocks: 2 } }]]) {
    const f = fixture(t, [p], extra); const result = await f.registry.scan();
    assert.equal(result.needsReview.length, 1); assert.equal(f.registry.mintCollections().length, 0);
    assert.equal(f.registry.salesCollections().length, 1);
  }
});

test("a discovered contract entering an unknown auction phase pauses only its mint tracking", async t => {
  const f = fixture(t); await f.registry.scan();
  f.setProjects([project({ supply_left_for_auction: 2 })]);
  const result = await f.registry.scan();
  assert.equal(result.needsReview.length, 1);
  assert.equal(f.registry.mintCollections().length, 0);
  assert.equal(f.registry.salesCollections().length, 1);
  assert.equal(f.state.lastProcessedBlock, 100);
});

test("deployment lookup is cached even when the mint history needs review", async t => {
  let reads = 0;
  const f = fixture(t, [project()], { options: { maxMintCatchupBlocks: 2 }, findDeployment: async () => { reads++; return 90; } });
  await f.registry.scan(); await f.registry.scan();
  assert.equal(reads, 1);
});

test("malformed persisted registry entries fail before they can change effective tracking", async t => {
  const f = fixture(t); await f.registry.scan();
  const state = readJson(f.file, {}); state.entries[A].collection.contractAddress = B;
  writeJson(f.file, state);
  await assert.rejects(f.registry.scan(), /Invalid collection registry entry/);
  assert.equal(f.registry.mintCollections()[0].contractAddress, A);
  assert.throws(() => createCollectionRegistry({ file: f.file, options: f.options, mintCollections: [], salesCollections: [] }), /Invalid collection registry entry/);
});

test("manual metadata and auction settings are preserved", async t => {
  const manual = { name: "Manual name", artist: "Manual artist", standard: "erc721", contractAddress: A, isAuction: true, tokenIdBase: 1 };
  const f = fixture(t, [project()], { mint: [manual] }); await f.registry.scan();
  assert.deepEqual(f.registry.mintCollections()[0], manual); assert.deepEqual(f.registry.salesCollections()[0], manual);
});

test("sellout requires two scans, onchain confirmation, final blocks and no pending auction", async t => {
  const p = project({ is_minting: 0, total_supply: 10 }), manual = { contractAddress: A, name: "Example", standard: "erc721" };
  const f = fixture(t, [p], { mint: [manual], sales: [manual] });
  await f.registry.scan(new Date("2026-09-28T20:00:00Z")); assert.equal(f.registry.mintCollections().length, 1);
  f.state.lastProcessedBlock = 99;
  await f.registry.scan(new Date("2026-09-29T20:00:00Z")); assert.equal(f.registry.mintCollections().length, 1);
  f.state.lastProcessedBlock = 100; f.state.pendingAuctions = { "1": { winner: B } };
  await f.registry.scan(new Date("2026-09-30T20:00:00Z")); assert.equal(f.registry.mintCollections().length, 1);
  f.state.pendingAuctions = {};
  await f.registry.scan(new Date("2026-10-01T20:00:00Z")); assert.equal(f.registry.mintCollections().length, 0);
  assert.equal(f.registry.salesCollections().length, 1); assert.equal(readJson(f.file, {}).entries[A].retired, true);
});

test("website supply alone never retires a collection", async t => {
  const manual = { contractAddress: A, name: "Example", standard: "erc721" };
  const f = fixture(t, [project({ is_minting: 0, total_supply: 10 })], { mint: [manual], sales: [manual], soldOut: async () => false });
  await f.registry.scan(new Date("2026-09-28T20:00:00Z")); await f.registry.scan(new Date("2026-09-29T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 1);
});

test("one minted-out edition cannot retire a contract with another available edition", async t => {
  const p = project({ project_type: 3, total_supply: 0, max_supply: null, sub_projects: [{ token_id: 0, total_supply: 1, max_supply: 1, is_visible: 1 }, { token_id: 1, total_supply: 0, max_supply: 1, is_visible: 1 }] });
  const manual = { contractAddress: A, name: "Example", standard: "erc1155" };
  const f = fixture(t, [p], { mint: [manual], sales: [manual] });
  await f.registry.scan(new Date("2026-09-28T20:00:00Z")); await f.registry.scan(new Date("2026-09-29T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 1);
});

test("new releases reactivate a retired contract while preserving its cursor", async t => {
  const manual = { contractAddress: A, name: "Example", standard: "erc721" };
  const f = fixture(t, [project({ is_minting: 0, total_supply: 10 })], { mint: [manual], sales: [manual] });
  await f.registry.scan(new Date("2026-09-28T20:00:00Z")); await f.registry.scan(new Date("2026-09-29T20:00:00Z"));
  f.setProjects([project({ max_supply: 20, total_supply: 11 })]); await f.registry.scan(new Date("2026-09-30T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 1); assert.equal(f.registry.mintCollections()[0].discoveryCatchup, true); assert.equal(f.state.lastProcessedBlock, 100);
});

test("partial catalog, failed validation and corrupt state preserve existing monitoring", async t => {
  const f = fixture(t); await f.registry.scan();
  f.setProjects([project({ project_address: B, project_identifier: "another" })]); await assert.rejects(f.registry.scan(), /incomplete/);
  assert.equal(f.registry.mintCollections()[0].contractAddress, A);
  fs.writeFileSync(f.file, "corrupt"); await assert.rejects(f.registry.scan(), /Cannot read/);
  assert.equal(f.registry.mintCollections()[0].contractAddress, A);
});

test("a suspicious number of additions is rejected before modifying tracking", async t => {
  const f = fixture(t, [project(), project({ project_address: B, project_identifier: "another" })], { options: { maxAdditionsPerScan: 1 } });
  await assert.rejects(f.registry.scan(), /safety limit/); assert.equal(f.initialized.length, 0);
});

test("deployment lookup finds the first contract block with bounded reads", async () => {
  let calls = 0;
  const provider = { async getCode(_address, block) { calls++; return block < 12345 ? "0x" : "0x1234"; } };
  assert.equal(await deploymentBlock(provider, A, 25000000), 12345); assert.ok(calls < 30);
  await assert.rejects(deploymentBlock({ async getCode() { throw new Error("https://rpc.example/SECRET_KEY"); } }, A, 25000000), error => /deployment.*read failed/.test(error.message) && !error.message.includes("SECRET_KEY"));
});

test("a collection first discovered sold out gets bounded mint backfill before retirement", async t => {
  const f = fixture(t, [project({ is_minting: 0, total_supply: 10 })]);
  f.state.lastProcessedBlock = 94;
  const result = await f.registry.scan(new Date("2026-09-28T20:00:00Z"));
  assert.deepEqual(result.addMint, ["Example"]);
  assert.equal(f.registry.mintCollections()[0].startBlock, 95);
  assert.equal(f.registry.salesCollections().length, 1);
  await f.registry.scan(new Date("2026-09-29T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 1);
  f.state.lastProcessedBlock = 100;
  await f.registry.scan(new Date("2026-09-30T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 0);
  assert.equal(f.registry.salesCollections().length, 1);
  assert.equal(f.initialized.filter(([kind]) => kind === "mint").length, 1);
});

test("old sold-out collections and unsupported auction histories produce a review warning", async t => {
  for (const [p, extra] of [[project({ is_minting: 0, total_supply: 10 }), { options: { maxMintCatchupBlocks: 2 } }], [project({ is_minting: 0, total_supply: 10, supply_left_for_auction: 2 }), {}]]) {
    const f = fixture(t, [p], extra), result = await f.registry.scan();
    assert.equal(result.needsReview.length, 1);
    assert.equal(f.registry.mintCollections().length, 0);
    assert.equal(f.registry.salesCollections().length, 1);
  }
});

test("sold-out mint-only additions respect the safety limit before initializing any cursors", async t => {
  const sales = [A, B].map(contractAddress => ({ name: "Existing sales", standard: "erc721", contractAddress }));
  const f = fixture(t, [project({ is_minting: 0, total_supply: 10 }), project({ project_address: B, project_identifier: "second", is_minting: 0, total_supply: 10 })], { sales, options: { maxAdditionsPerScan: 1 } });
  await assert.rejects(f.registry.scan(), /safety limit/);
  assert.equal(f.initialized.length, 0);
});

const editionProject = editions => project({ project_type: 3, is_minting: 0, total_supply: 0, max_supply: null, sub_projects: editions.map(([token_id, total_supply, max_supply]) => ({ token_id, total_supply, max_supply, is_visible: 1 })) });

test("new sold-out editions reset retirement observations and require the current barrier", async t => {
  const manual = { name: "Editions", standard: "erc1155", contractAddress: A };
  const f = fixture(t, [editionProject([[0, 1, 1]])], { mint: [manual], sales: [manual] });
  f.state.lastProcessedBlock = 90;
  await f.registry.scan(new Date("2026-09-26T20:00:00Z"));
  await f.registry.scan(new Date("2026-09-27T20:00:00Z"));
  assert.equal(readJson(f.file, {}).entries[A].retireAtBlock, 100);
  f.setProjects([editionProject([[0, 1, 1], [1, 1, 1]])]); f.setHead(152); f.state.lastProcessedBlock = 120;
  await f.registry.scan(new Date("2026-09-28T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 1);
  assert.equal(readJson(f.file, {}).entries[A].retireAtBlock, null);
  await f.registry.scan(new Date("2026-09-29T20:00:00Z"));
  assert.equal(readJson(f.file, {}).entries[A].retireAtBlock, 150);
  assert.equal(f.registry.mintCollections().length, 1);
  f.state.lastProcessedBlock = 150;
  await f.registry.scan(new Date("2026-09-30T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 0);
});

test("changed ERC721 supply invalidates the previous retirement barrier", async t => {
  const manual = { name: "Example", standard: "erc721", contractAddress: A };
  const f = fixture(t, [project({ is_minting: 0, total_supply: 10 })], { mint: [manual], sales: [manual] });
  f.state.lastProcessedBlock = 90;
  await f.registry.scan(new Date("2026-09-26T20:00:00Z")); await f.registry.scan(new Date("2026-09-27T20:00:00Z"));
  f.setProjects([project({ is_minting: 0, total_supply: 20, max_supply: 20 })]); f.setHead(152); f.state.lastProcessedBlock = 120;
  await f.registry.scan(new Date("2026-09-28T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 1); assert.equal(readJson(f.file, {}).entries[A].retireAtBlock, null);
});

test("an already retired contract reactivates when another edition sells out between scans", async t => {
  const manual = { name: "Editions", standard: "erc1155", contractAddress: A };
  const f = fixture(t, [editionProject([[0, 1, 1]])], { mint: [manual], sales: [manual] });
  await f.registry.scan(new Date("2026-09-26T20:00:00Z")); await f.registry.scan(new Date("2026-09-27T20:00:00Z"));
  assert.equal(f.registry.mintCollections().length, 0);
  f.setProjects([editionProject([[0, 1, 1], [1, 1, 1]])]); f.setHead(152);
  const result = await f.registry.scan(new Date("2026-09-28T20:00:00Z"));
  assert.deepEqual(result.reactivateMint, ["Example"]);
  assert.equal(f.registry.mintCollections().length, 1);
  assert.equal(f.registry.mintCollections()[0].discoveryCatchup, true);
  assert.equal(f.state.lastProcessedBlock, 100);
  assert.equal(f.registry.salesCollections().length, 1);
});

for (const mode of ["observe", "retirement-disabled"]) {
  test(`pending reactivation survives ${mode}, unchanged scans and a registry restart`, async t => {
    const f = fixture(t, [editionProject([[0, 1, 1]])]);
    await f.registry.scan(new Date("2026-09-24T20:00:00Z"));
    await f.registry.scan(new Date("2026-09-25T20:00:00Z"));
    assert.equal(f.registry.mintCollections().length, 0);
    assert.equal(readJson(f.file, {}).entries[A].retired, true);
    const initializations = f.initialized.length;
    if (mode === "observe") f.options.mode = "observe";
    else f.options.autoRetire = false;
    f.setProjects([editionProject([[0, 1, 1], [1, 1, 1]])]); f.setHead(152);
    for (const day of [26, 27]) {
      const result = await f.registry.scan(new Date(`2026-09-${day}T20:00:00Z`));
      assert.deepEqual(result.reactivateMint, ["Example"]);
      const entry = readJson(f.file, {}).entries[A];
      assert.equal(entry.retired, true); assert.equal(entry.pendingReactivation, true);
    }
    const restarted = f.restart();
    f.options.mode = "apply"; f.options.autoRetire = true;
    const result = await restarted.scan(new Date("2026-09-28T20:00:00Z"));
    assert.deepEqual(result.reactivateMint, ["Example"]);
    assert.equal(restarted.mintCollections().length, 1);
    assert.equal(restarted.mintCollections()[0].discoveryCatchup, true);
    assert.equal(restarted.salesCollections().length, 1);
    assert.equal(f.state.lastProcessedBlock, 100);
    assert.equal(f.initialized.length, initializations);
    const entry = restarted.status().entries[A];
    assert.equal(entry.retired, false); assert.equal(entry.pendingReactivation, false);
    assert.equal(entry.retireAtBlock, null);
    await restarted.scan(new Date("2026-09-29T20:00:00Z"));
    assert.equal(restarted.mintCollections().length, 1);
    assert.equal(restarted.status().entries[A].retireAtBlock, 150);
    f.state.lastProcessedBlock = 150;
    await restarted.scan(new Date("2026-09-30T20:00:00Z"));
    assert.equal(restarted.mintCollections().length, 0);
    assert.equal(restarted.salesCollections().length, 1);
  });
}

test("historical review items do not block an eligible mint addition's safety budget", async t => {
  const sales = [A, B].map(contractAddress => ({ name: "Existing sales", standard: "erc721", contractAddress }));
  const f = fixture(t, [project({ is_minting: 0, total_supply: 10 }), project({ project_address: B, project_identifier: "second", name: "Recent", is_minting: 0, total_supply: 10 })], { sales, options: { maxAdditionsPerScan: 1, maxMintCatchupBlocks: 2 }, findDeployment: async (_provider, address) => address === A ? 50 : 99 });
  const result = await f.registry.scan();
  assert.equal(result.needsReview.length, 1); assert.deepEqual(result.addMint, ["Recent"]);
  assert.equal(f.initialized.length, 1); assert.equal(f.registry.mintCollections()[0].contractAddress, B);
});

test("reordering editions preserves retirement observations without changing supply", async t => {
  const manual = { name: "Editions", standard: "erc1155", contractAddress: A };
  const f = fixture(t, [editionProject([[0, 1, 1], [1, 1, 1]])], { mint: [manual], sales: [manual] });
  f.state.lastProcessedBlock = 90;
  await f.registry.scan(new Date("2026-09-26T20:00:00Z")); await f.registry.scan(new Date("2026-09-27T20:00:00Z"));
  const before = readJson(f.file, {}).entries[A];
  f.setProjects([editionProject([[1, 1, 1], [0, 1, 1]])]);
  await f.registry.scan(new Date("2026-09-28T20:00:00Z"));
  const after = readJson(f.file, {}).entries[A];
  assert.equal(after.soldOutSince, before.soldOutSince); assert.equal(after.retireAtBlock, 100);
  assert.equal(f.registry.mintCollections().length, 1);
});
