"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { parseCatalog, createCollectionRegistry, deploymentBlock, supplySignature, confirmSoldOut } = require("../collection-discovery");
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
  const restart = () => createCollectionRegistry({ file, options, mintCollections: extra.mint || [], salesCollections: extra.sales || [], loadMintState: () => state, provider: { async getBlockNumber() { if (head instanceof Error) throw head; return head; } }, confirmations: 2,
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

const closedReview = p => ({ contractAddress: p.project_address, supplySignature: supplySignature(parseCatalog(html([p]))[0]), auctionSupply: p.supply_left_for_auction ?? 0 });
const salesOnly = standard => ({ name: "Reviewed legacy collection", contractAddress: A, standard: standard || "erc721" });

const resumableReview = (p, resumeAfterBlock = 80) => ({ ...closedReview(p), resumeAfterBlock });

for (const soldBeforeScan of [false, true]) {
  test(`reviewed ERC1155 resumes from its fixed checkpoint when new editions are ${soldBeforeScan ? "already sold out" : "still minting"}`, async t => {
    const original = editionProject([[0, 10, 10]]), confirmations = [];
    const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [resumableReview(original)], maxMintCatchupBlocks: 1 },
      soldOut: async (_provider, p, block, exact) => { confirmations.push({ block, exact, expected: p.editions.map(e => [e.tokenId, e.max]) }); return true; },
      findDeployment: async () => assert.fail("Reviewed reopening must not backfill deployment history") });
    await f.registry.scan(); f.setHead(20002); await f.registry.scan();
    const changed = { ...editionProject([[0, 10, 10], [1, soldBeforeScan ? 5 : 2, 5]]), is_minting: soldBeforeScan ? 0 : 1 };
    f.setProjects([changed]);
    const result = await f.registry.scan();
    assert.deepEqual(result.reactivateMint, ["Example"]); assert.deepEqual(result.needsReview, []);
    assert.deepEqual(confirmations.at(-1), { block: 80, exact: true, expected: [["0", 10], ["1", 0]] });
    assert.equal(f.initialized.length, 1); assert.equal(f.initialized[0][1].startBlock, 81);
    assert.equal(f.registry.mintCollections()[0].startBlock, 81);
    assert.equal(f.restart().mintCollections()[0].startBlock, 81);
    assert.deepEqual(f.registry.salesCollections(), [salesOnly("erc1155")]);
    assert.equal(f.state.lastProcessedBlock, 100);
    await f.registry.scan(); assert.equal(f.initialized.length, 1);
  });
}

test("reviewed ERC1155 supports increased edition caps and a reopened minting flag", async t => {
  const original = editionProject([[0, 10, 10]]);
  for (const changed of [editionProject([[0, 15, 15]]), { ...original, is_minting: 1 }]) {
    const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [resumableReview(original)] } });
    await f.registry.scan(); f.setProjects([changed]);
    assert.deepEqual((await f.registry.scan()).reactivateMint, ["Example"]);
    assert.equal(f.registry.mintCollections()[0].startBlock, 81);
  }
});

for (const disabled of [{ mode: "observe" }, { autoAdd: false }]) {
  test(`reviewed reopening remains pending across ${JSON.stringify(disabled)} and restart`, async t => {
    const original = editionProject([[0, 10, 10]]);
    const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { ...disabled, reviewedClosedCollections: [resumableReview(original)] } });
    await f.registry.scan(); f.setProjects([editionProject([[0, 10, 10], [1, 5, 5]])]);
    for (const registry of [f.registry, f.restart()]) {
      assert.deepEqual((await registry.scan()).reactivateMint, ["Example"]);
      assert.deepEqual(f.initialized, []); assert.deepEqual(registry.mintCollections(), []);
    }
    Object.assign(f.options, { mode: "apply", autoAdd: true });
    const registry = f.restart(); await registry.scan();
    assert.equal(registry.mintCollections()[0].startBlock, 81); assert.equal(f.initialized.length, 1);
  });
}

test("reviewed reopening rejects removed editions and reduced supply", async t => {
  const original = editionProject([[0, 10, 10], [1, 5, 5]]);
  for (const changed of [editionProject([[0, 10, 10], [2, 5, 5]]), editionProject([[0, 9, 9], [1, 5, 5], [2, 5, 5]])]) {
    const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [resumableReview(original)] } });
    await f.registry.scan(); f.setProjects([changed]);
    const result = await f.registry.scan();
    assert.match(result.needsReview[0], /needs review/); assert.deepEqual(result.reactivateMint, []);
    assert.deepEqual(f.initialized, []); assert.equal(f.registry.salesCollections().length, 1);
  }
});

test("reviewed reopening persists attention but never applies tracking when historical RPC fails", async t => {
  const original = editionProject([[0, 10, 10]]); let fail = false, mismatch = false;
  const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [resumableReview(original)] },
    soldOut: async (_provider, _p, block) => { if (block === 80 && fail) throw new Error("Historical RPC unavailable"); return block !== 80 || !mismatch; } });
  await f.registry.scan(); const before = readJson(f.file, {});
  f.setProjects([editionProject([[0, 10, 10], [1, 5, 5]])]); fail = true;
  await assert.rejects(f.registry.scan(), /Historical RPC unavailable/);
  const remembered = readJson(f.file, {});
  assert.equal(remembered.entries[A].reviewedReopenSeen, true);
  const { reviewedReopenSeen, reviewedAuctionSeen, ...entry } = remembered.entries[A];
  assert.deepEqual(entry, before.entries[A]); assert.equal(remembered.lastScan, before.lastScan);
  assert.deepEqual(f.initialized, []); assert.deepEqual(f.registry.mintCollections(), []);
  f.setProjects([original]); const restored = await f.restart().scan();
  assert.deepEqual(restored.reviewedClosed, []); assert.equal(restored.needsReview.length, 1);
  f.setProjects([editionProject([[0, 10, 10], [1, 5, 5]])]);
  fail = false; mismatch = true;
  assert.match((await f.registry.scan()).needsReview[0], /checkpoint does not match/); assert.deepEqual(f.initialized, []);
  mismatch = false; await f.restart().scan(); assert.equal(f.initialized.length, 1);
});

test("an observed auction on a reviewed ERC1155 keeps reopening manual even if the flag later clears", async t => {
  const original = editionProject([[0, 10, 10]]), changed = editionProject([[0, 10, 10], [1, 5, 5]]);
  const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [resumableReview(original)] } });
  await f.registry.scan(); f.setProjects([{ ...changed, supply_left_for_auction: 1 }]);
  assert.equal((await f.registry.scan()).needsReview.length, 1);
  f.setProjects([changed]); assert.equal((await f.restart().scan()).needsReview.length, 1);
  assert.deepEqual(f.initialized, []); assert.equal(f.registry.salesCollections().length, 1);
});

test("removing new editions before applying a reviewed reopening cannot acknowledge closure again", async t => {
  const original = editionProject([[0, 10, 10]]);
  const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { mode: "observe", reviewedClosedCollections: [resumableReview(original)] } });
  await f.registry.scan(); f.setProjects([editionProject([[0, 10, 10], [1, 5, 5]])]); await f.registry.scan();
  f.setProjects([original]); const result = await f.restart().scan();
  assert.deepEqual(result.reviewedClosed, []); assert.equal(result.needsReview.length, 1); assert.deepEqual(f.initialized, []);
});

test("reviewed reopening counts toward the combined addition limit before initializing", async t => {
  const original = editionProject([[0, 10, 10]]);
  const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { maxAdditionsPerScan: 1, reviewedClosedCollections: [resumableReview(original)] } });
  await f.registry.scan(); const before = readJson(f.file, {});
  f.setProjects([editionProject([[0, 10, 10], [1, 5, 5]]), project({ project_address: B, project_identifier: "new" })]);
  await assert.rejects(f.registry.scan(), /safety limit/);
  const after = readJson(f.file, {});
  assert.equal(after.entries[A].reviewedReopenSeen, true); assert.equal(after.lastScan, before.lastScan);
  assert.equal(after.entries[A].mintAdded, undefined); assert.equal(after.entries[B], undefined);
  assert.deepEqual(f.initialized, []);
});

test("reviewed auction observation survives another collection's RPC failure and restart", async t => {
  const original = editionProject([[0, 10, 10]]), other = project({ project_address: B, project_identifier: "other", is_minting: 0, total_supply: 10 });
  const sales = [salesOnly("erc1155"), { name: "Other", contractAddress: B, standard: "erc721" }]; let fail = false;
  const f = fixture(t, [original, other], { sales, options: { reviewedClosedCollections: [resumableReview(original), closedReview(other)] },
    soldOut: async (_provider, p) => { if (fail && p.address === B) throw new Error("Other collection RPC failure"); return true; } });
  await f.registry.scan(); const before = readJson(f.file, {});
  const changed = editionProject([[0, 10, 10], [1, 5, 5]]);
  f.setProjects([{ ...changed, supply_left_for_auction: 1 }, other]); fail = true;
  await assert.rejects(f.registry.scan(), /Other collection RPC failure/);
  const after = readJson(f.file, {});
  assert.equal(after.entries[A].reviewedAuctionSeen, true); assert.equal(after.lastScan, before.lastScan);
  assert.equal(after.entries[A].mintAdded, undefined); assert.deepEqual(f.initialized, []);
  fail = false; f.setProjects([changed, other]);
  const registry = f.restart(), result = await registry.scan();
  assert.equal(result.needsReview.length, 1); assert.deepEqual(result.reactivateMint, []);
  assert.deepEqual(registry.mintCollections(), []); assert.deepEqual(registry.salesCollections(), sales);
});

test("reviewed reopening is remembered before a chain-head failure even on the first scan", async t => {
  const original = editionProject([[0, 10, 10]]);
  const f = fixture(t, [editionProject([[0, 10, 10], [1, 5, 5]])], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [resumableReview(original)] } });
  f.setHead(new Error("Head unavailable"));
  await assert.rejects(f.registry.scan(), /Ethereum head read failed/);
  assert.equal(readJson(f.file, {}).entries[A].reviewedReopenSeen, true);
  assert.equal(readJson(f.file, {}).lastScan, undefined);
  f.setHead(102); f.setProjects([original]); const result = await f.restart().scan();
  assert.deepEqual(result.reviewedClosed, []); assert.equal(result.needsReview.length, 1);
  assert.deepEqual(f.initialized, []);
});

test("resumption checkpoints require valid closed ERC1155 supply and cannot be future blocks", async t => {
  const original = editionProject([[0, 10, 10]]);
  for (const review of [resumableReview(original, -1), resumableReview(original, 1.5), resumableReview(original, Number.MAX_SAFE_INTEGER),
    { ...resumableReview(original), auctionSupply: 1 }, { ...resumableReview(original), supplySignature: JSON.stringify(["erc1155", 0, null, [["0", 1, 2]]]) }]) {
    const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [review] } });
    assert.match(f.registry.configurationError, /resumption checkpoint/); assert.equal(f.registry.salesCollections().length, 1);
  }
  const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [resumableReview(original, 200)] } });
  f.setProjects([editionProject([[0, 10, 10], [1, 5, 5]])]);
  assert.equal((await f.registry.scan()).needsReview.length, 1); assert.deepEqual(f.initialized, []);
});

test("duplicate edition IDs cannot masquerade as a reopened collection", () => {
  assert.throws(() => parseCatalog(html([editionProject([[0, 1, 1], [0, 2, 2]])])), /duplicate edition IDs/);
});

for (const mode of ["observe", "apply"]) {
  test(`reviewed closed histories and auctions stay sales-only in ${mode} and after restart`, async t => {
    for (const auction of [0, 90]) {
      const p = project({ is_minting: 0, total_supply: 10, supply_left_for_auction: auction });
      const f = fixture(t, [p], { sales: [salesOnly()], options: { mode, maxMintCatchupBlocks: 1, reviewedClosedCollections: [closedReview(p)] }, findDeployment: async () => { throw new Error("must not replay historical mints"); } });
      const initial = structuredClone(f.state);
      for (const registry of [f.registry, f.restart()]) {
        const result = await registry.scan();
        assert.deepEqual(result.reviewedClosed, ["Example"]);
        assert.deepEqual(result.needsReview, []);
        assert.deepEqual(result.addMint, []); assert.deepEqual(result.addSales, []);
        assert.deepEqual(registry.salesCollections(), [salesOnly()]);
        assert.deepEqual(registry.mintCollections(), []);
      }
      assert.deepEqual(f.initialized, []); assert.deepEqual(f.state, initial);
    }
  });
}

test("reviewed collections require fresh review when minting, supply caps or edition IDs change", async t => {
  const original = editionProject([[0, 1, 1]]);
  for (const changed of [editionProject([[0, 2, 2]]), editionProject([[0, 1, 1], [1, 1, 1]]), { ...original, is_minting: 1 }]) {
    const f = fixture(t, [original], { sales: [salesOnly("erc1155")], options: { reviewedClosedCollections: [closedReview(original)] } });
    await f.registry.scan(); f.setProjects([changed]);
    for (const registry of [f.registry, f.restart()]) {
      const result = await registry.scan();
      assert.deepEqual(result.reviewedClosed, []);
      assert.match(result.needsReview[0], /reviewed closed collection changed/);
      assert.equal(result.addMint.length, 0); assert.equal(registry.salesCollections().length, 1);
    }
    assert.deepEqual(f.initialized, []);
  }
});

test("reviewed closed website supply still requires current chain confirmation", async t => {
  const p = project({ is_minting: 0, total_supply: 10 });
  const f = fixture(t, [p], { sales: [salesOnly()], options: { reviewedClosedCollections: [closedReview(p)] }, soldOut: async (_provider, _project, block, exact) => { assert.equal(block, 100); assert.equal(exact, true); return false; } });
  const result = await f.registry.scan();
  assert.match(result.needsReview[0], /no longer confirmed on chain/);
  assert.deepEqual(result.reviewedClosed, []); assert.deepEqual(f.initialized, []);
  assert.equal(f.registry.salesCollections().length, 1);
});

test("closed review confirmation rejects both lower and higher onchain supply", async () => {
  for (const p of [project({ is_minting: 0, total_supply: 10 }), editionProject([[0, 10, 10]])]) {
    const parsed = parseCatalog(html([p]))[0];
    for (const supply of [9, 10, 11]) {
      const provider = { call: async () => "0x" + supply.toString(16).padStart(64, "0") };
      assert.equal(await confirmSoldOut(provider, parsed, 100, true), supply === 10);
      assert.equal(await confirmSoldOut(provider, parsed, 100), supply >= 10);
    }
  }
});

test("historical zero supply accepts only the exact uncreated-token revert, never RPC errors", async () => {
  const absentEdition = "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Token does not exist"]).slice(2);
  const project = { address: A, standard: "erc1155", editions: [{ tokenId: "5", max: 0 }] };
  const missing = { code: "CALL_EXCEPTION", data: absentEdition };
  const provider = { call: async () => { throw missing; } };
  assert.equal(await confirmSoldOut(provider, project, 80, true), true);
  await assert.rejects(confirmSoldOut(provider, project, 80), /edition supply read failed/);
  await assert.rejects(confirmSoldOut(provider, { ...project, editions: [{ tokenId: "5", max: 1 }] }, 80, true), /edition supply read failed/);
  for (const error of [{ code: "NETWORK_ERROR", data: absentEdition }, { code: "CALL_EXCEPTION", data: "0x", reason: "Token does not exist" }, new Error("RPC unavailable")]) {
    await assert.rejects(confirmSoldOut({ call: async () => { throw error; } }, project, 80, true), /edition supply read failed/);
  }
});

test("failed reviewed supply reads preserve the registry and all current tracking", async t => {
  const p = project({ is_minting: 0, total_supply: 10 }); let fail = false;
  const f = fixture(t, [p], { sales: [salesOnly()], options: { reviewedClosedCollections: [closedReview(p)] }, soldOut: async () => { if (fail) throw new Error("supply unavailable"); return true; } });
  await f.registry.scan(); const before = fs.readFileSync(f.file, "utf8"); fail = true;
  await assert.rejects(f.registry.scan(), /supply unavailable/);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.deepEqual(f.registry.salesCollections(), [salesOnly()]); assert.deepEqual(f.initialized, []);
});

test("reviewing legacy sellouts never exempts a new collection that already sold out", async t => {
  const old = project({ is_minting: 0, total_supply: 10 });
  const recent = project({ project_address: B, project_identifier: "new", name: "New sellout", is_minting: 0, total_supply: 10 });
  const f = fixture(t, [old, recent], { sales: [salesOnly()], options: { reviewedClosedCollections: [closedReview(old)], maxAdditionsPerScan: 1 }, findDeployment: async (_p, address) => { assert.equal(address, B); return 95; } });
  const result = await f.registry.scan();
  assert.deepEqual(result.reviewedClosed, ["Example"]); assert.deepEqual(result.addMint, ["New sellout"]);
  assert.deepEqual(result.addSales, ["New sellout"]);
  assert.equal(f.registry.mintCollections()[0].startBlock, 95); assert.equal(f.registry.salesCollections().length, 2);
});

test("closed reviews block scans for missing sales coverage, active config, duplicates and malformed identities", async t => {
  const p = project({ is_minting: 0, total_supply: 10 }), review = closedReview(p);
  for (const extra of [
    { options: { reviewedClosedCollections: [review] } },
    { sales: [salesOnly()], mint: [salesOnly()], options: { reviewedClosedCollections: [review] } },
    { sales: [salesOnly()], options: { reviewedClosedCollections: [review, review] } },
    { sales: [salesOnly()], options: { reviewedClosedCollections: [{ ...review, supplySignature: "*" }] } },
    { sales: [salesOnly()], options: { reviewedClosedCollections: [{ ...review, contractAddress: "invalid" }] } },
    { sales: [salesOnly()], options: { reviewedClosedCollections: [null] } },
    { sales: [salesOnly()], options: { reviewedClosedCollections: {} } },
    { sales: [salesOnly()], options: { reviewedClosedCollections: null } },
    { sales: [salesOnly()], options: { reviewedClosedCollections: [{ ...review, auctionSupply: -1 }] } },
  ]) {
    const f = fixture(t, [p], extra);
    assert.match(f.registry.configurationError, /Invalid reviewed closed/);
    await assert.rejects(f.registry.scan(), /Invalid reviewed closed/);
    assert.deepEqual(f.registry.salesCollections(), extra.sales || []);
    assert.deepEqual(f.initialized, []);
  }
});

test("reviewed auction supply changes require renewed review even while minting stays closed", async t => {
  for (const [before, after] of [[0, 1], [90, 91], [90, 0]]) {
    const p = project({ is_minting: 0, total_supply: 10, supply_left_for_auction: before });
    const f = fixture(t, [p], { sales: [salesOnly()], options: { reviewedClosedCollections: [closedReview(p)] } });
    await f.registry.scan(); f.setProjects([{ ...p, supply_left_for_auction: after }]);
    const result = await f.registry.scan();
    assert.deepEqual(result.reviewedClosed, []); assert.match(result.needsReview[0], /reviewed closed collection changed/);
    assert.deepEqual(f.initialized, []); assert.deepEqual(f.registry.salesCollections(), [salesOnly()]);
  }
});

test("malformed catalog auction supply cannot bypass auction review", () => {
  for (const supply_left_for_auction of [-1, "unknown", 0.5]) {
    assert.throws(() => parseCatalog(html([project({ supply_left_for_auction })])), /invalid auction supply/);
  }
});

test("a closed review cannot mask an already applied mint collection's auction warning", async t => {
  const f = fixture(t, [project()], { sales: [salesOnly()] }); await f.registry.scan();
  const closed = project({ is_minting: 0, total_supply: 10, supply_left_for_auction: 90 });
  f.setProjects([closed]); f.options.reviewedClosedCollections = [closedReview(closed)];
  const registry = f.restart(), result = await registry.scan();
  assert.match(result.needsReview[0], /auction configuration/); assert.deepEqual(result.reviewedClosed, []);
  assert.equal(registry.salesCollections().length, 1);
});

for (const change of [{ mode: "observe" }, { enabled: false }, { autoAdd: false, autoRetire: false }]) {
  test(`applied sales coverage survives discovery settings ${JSON.stringify(change)}`, async t => {
    const f = fixture(t); await f.registry.scan();
    const sales = f.registry.salesCollections(); Object.assign(f.options, change);
    assert.deepEqual(f.registry.salesCollections(), sales);
    assert.deepEqual(f.restart().salesCollections(), sales);
    assert.equal(f.initialized.filter(([kind]) => kind === "sales").length, 1);
  });
}
