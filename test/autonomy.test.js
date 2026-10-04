"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");
const { createMintLedger, eventId, parseCsv, readMintRecords } = require("../mint-ledger");
const { createDailyJob, localSchedule, writeJson, readJson } = require("../daily-jobs");
const { rawValues, planImport, valuesData, verifyRows, syncMintSheet, SheetsClient, sheetStatePaths, RAW_HEADERS, LOG_HEADERS } = require("../sheets-sync");
const { createBotAutonomy, settings } = require("../bot-autonomy");

const A = "0x" + "a".repeat(40), W = "0x" + "b".repeat(40), TX = "0x" + "c".repeat(64);
const row = (changes = {}) => ({ DateUTC: "2026-09-30T23:00:00.000Z", ProjectKey: A, Collection: 'Collection, "one"', Standard: "erc721", Quantity: "1", MinterWallet: W, ETHPrice: "0.025", TokenID: "1", Contract: A, TxHash: TX, BlockNumber: "25000000", LogIndex: "0", ...changes });
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "8nap-autonomy-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const effective = values => { const result = [...values]; result[13] = eventId({ Contract: values[8], TxHash: values[9], LogIndex: values[11], TokenID: values[7] }); return result; };

test("ledger retry after Discord failure writes one row, including after process restart", t => {
  const dir = temp(t), mint = row();
  assert.equal(createMintLedger(dir).append(mint, Date.parse(mint.DateUTC)), true);
  assert.equal(createMintLedger(dir).append(mint, Date.parse(mint.DateUTC)), false);
  assert.deepEqual(readMintRecords(dir), [mint]);
});

test("ERC1155 batch token IDs remain separate while each retry deduplicates", t => {
  const dir = temp(t), ledger = createMintLedger(dir);
  const one = row({ Standard: "erc1155", ProjectKey: `${A}:1`, Quantity: "3" });
  const two = row({ Standard: "erc1155", ProjectKey: `${A}:2`, TokenID: "2", Quantity: "2" });
  for (const mint of [one, two, one, two]) ledger.append(mint, Date.parse(mint.DateUTC));
  assert.equal(ledger.read().length, 2);
});

test("conflicting retries and malformed trailing CSV fail without adding records", t => {
  const dir = temp(t), ledger = createMintLedger(dir), mint = row();
  ledger.append(mint, Date.parse(mint.DateUTC));
  assert.throws(() => ledger.append(row({ ETHPrice: "0" }), Date.parse(mint.DateUTC)), /Conflicting/);
  fs.appendFileSync(path.join(dir, "mints-2026-09.csv"), '"unfinished');
  assert.throws(() => createMintLedger(dir).append(row({ TokenID: "2" }), Date.parse(mint.DateUTC)), /Incomplete/);
});

test("UTC month boundary preserves CSV format and late previous-month events", t => {
  const ledger = createMintLedger(temp(t));
  for (const mint of [row(), row({ DateUTC: "2026-10-01T00:00:00.000Z", TokenID: "2" }), row({ DateUTC: "2026-09-30T22:00:00.000Z", TokenID: "3" })]) ledger.append(mint, Date.parse(mint.DateUTC));
  assert.equal(ledger.read().length, 3);
  assert.deepEqual(parseCsv('a,b\r\n"c\r\nd","e""f"\r\n'), [["a", "b"], ["c\r\nd", 'e"f']]);
});

test("import preserves existing corrections and differentiates batch IDs", () => {
  const existing = effective(rawValues(row())); existing[6] = 0.03;
  const plan = planImport([row(), row({ TokenID: "2" })], [existing]);
  assert.equal(plan.rows.length, 1); assert.equal(plan.startRow, 3);
  const data = valuesData(plan);
  assert.deepEqual(data.map(d => d.range), ["'Raw Imports'!A3:M3", "'Raw Imports'!O3:Q3"]);
  assert.equal(existing[6], 0.03);
});

test("import rejects partial rows and capacity overflow rather than hiding new mints", () => {
  assert.throws(() => planImport([row()], [["", "manual text"]]), /Partially/);
  assert.throws(() => planImport([row()], [], 1), /capacity/);
});

test("large token IDs stay as text and unsafe quantities are rejected", () => {
  const token = "999999999999999999999999999999";
  assert.equal(rawValues(row({ TokenID: token }))[7], token);
  assert.throws(() => rawValues(row({ Standard: "erc1155", ProjectKey: `${A}:1`, Quantity: "9007199254740993" })), /precision/);
});

test("verification detects broken formula, changed quantities and changed ETH", () => {
  const values = rawValues(row()), actual = effective(values);
  verifyRows([values], [actual]);
  for (const [column, value] of [[13, ""], [4, 2], [6, 0.04]]) { const changed = [...actual]; changed[column] = value; assert.throws(() => verifyRows([values], [changed]), /formula|verification/); }
});

function fakeClient(spreadsheetId = "test-sheet") {
  const client = { spreadsheetId, rows: [], logs: [], writes: 0, heartbeats: [], async layout() { return { logRows: 500 }; },
    async publishHeartbeat(recordsChecked) { const at = new Date().toISOString(); this.heartbeats.push({ recordsChecked, at }); return at; },
    async health() { return []; },
    async inputValues(range) { return this.values(range, "FORMULA"); },
    async values(range, render = "UNFORMATTED_VALUE") {
      const match = range.match(/!(?:A)(\d+):(?:Q|H)(\d+)/);
      const source = range.includes("Import Log") ? (render === "FORMULA" ? this.enteredLogs || this.logs : this.logs) : (render === "FORMULA" ? this.enteredRows || this.rows : this.rows);
      return source.slice(Number(match[1]) - 2, Number(match[2]) - 1).map(v => [...v]);
    },
    async write(data) {
      this.writes++;
      for (const block of data) {
        const start = Number(block.range.match(/![A-Z]+(\d+)/)[1]) - 2;
        if (block.range.includes("Import Log")) { this.logs[start] = [...block.values[0]]; continue; }
        const column = block.range.includes("!A") ? 0 : 14;
        for (let i = 0; i < block.values.length; i++) {
          const current = this.rows[start + i] || Array(17).fill("");
          current.splice(column, block.values[i].length, ...block.values[i]);
          if (current[8]) current[13] = eventId({ Contract: current[8], TxHash: current[9], LogIndex: current[11], TokenID: current[7] });
          this.rows[start + i] = current;
        }
      }
      if (this.loseResponse) { this.loseResponse = false; throw new Error("response lost after successful write"); }
    },
  }; return client;
}

test("lost write response recovers from sheet readback without another POST", async t => {
  const client = fakeClient(), stateFile = path.join(temp(t), "sync.json"); client.loseResponse = true;
  await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /response lost/);
  const result = await syncMintSheet({ client, records: [row()], stateFile, dryRun: false });
  assert.equal(client.writes, 1); assert.equal(result.newEvents, 0); assert.equal(client.rows.length, 1); assert.equal(client.logs.length, 1);
  assert.equal(readJson(stateFile, {}).pending, null);
  assert.equal(client.heartbeats.length, 1);
});

test("dry run never writes; an empty apply day advances only the heartbeat", async t => {
  const client = fakeClient(), stateFile = path.join(temp(t), "sync.json");
  const planned = await syncMintSheet({ client, records: [row()], stateFile });
  assert.equal(planned.newEvents, 1); assert.equal(client.writes, 0);
  assert.equal(client.heartbeats.length, 0);
  const empty = await syncMintSheet({ client, records: [], stateFile, dryRun: false }); assert.equal(client.writes, 0);
  assert.equal(client.heartbeats.length, 1); assert.equal(client.heartbeats[0].recordsChecked, 0);
  assert.equal(empty.lastDataSync, client.heartbeats[0].at);
});

test("successful writes verify numbers and avoid duplicates on a repeated run", async t => {
  const client = fakeClient(), stateFile = path.join(temp(t), "sync.json");
  const result = await syncMintSheet({ client, records: [row()], stateFile, dryRun: false });
  assert.equal(result.newEvents, 1); assert.equal(client.rows[0][6], 0.025);
  await syncMintSheet({ client, records: [row()], stateFile, dryRun: false }); assert.equal(client.writes, 1);
});

test("imports larger than 500 events complete in bounded verified batches", async t => {
  const client = fakeClient(), records = Array.from({ length: 1001 }, (_, i) => row({ TokenID: String(i + 1) }));
  const stateFile = path.join(temp(t), "sync.json");
  const now = new Date("2026-09-30T23:00:00Z");
  const result = await syncMintSheet({ client, records, stateFile, dryRun: false, now });
  assert.equal(result.newEvents, 1001); assert.equal(client.writes, 3);
  assert.equal(client.rows.length, 1001); assert.equal(client.logs.length, 3);
  assert.equal(client.logs[0][6], "2026-09-30");
  assert.equal(client.heartbeats.length, 1); assert.equal(client.heartbeats[0].recordsChecked, 1001);
  await syncMintSheet({ client, records, stateFile, dryRun: false }); assert.equal(client.writes, 3);
});

test("failed imports and unresolved checks do not publish a success heartbeat", async t => {
  const client = fakeClient(), stateFile = path.join(temp(t), "sync.json");
  client.loseResponse = true;
  await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /response lost/);
  assert.equal(client.heartbeats.length, 0);
  client.health = async () => ["Unassigned phase pieces: 1"];
  const result = await syncMintSheet({ client, records: [row()], stateFile, dryRun: false });
  assert.deepEqual(result.needsReview, ["Unassigned phase pieces: 1"]);
  assert.equal(result.lastDataSync, null); assert.equal(client.heartbeats.length, 0);
  client.health = async () => { throw new Error("checks unavailable"); };
  await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /checks unavailable/);
  assert.equal(client.heartbeats.length, 0);
});

test("heartbeat failure retries safely after completed imports without appending duplicates", async t => {
  const client = fakeClient(), stateFile = path.join(temp(t), "sync.json"), publish = client.publishHeartbeat;
  client.publishHeartbeat = async () => { throw new Error("heartbeat response lost"); };
  await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /heartbeat response lost/);
  assert.equal(client.rows.length, 1); assert.equal(readJson(stateFile, {}).pending, null);
  client.publishHeartbeat = publish;
  const result = await syncMintSheet({ client, records: [row()], stateFile, dryRun: false });
  assert.equal(result.newEvents, 0); assert.equal(client.logs.length, 1); assert.equal(client.writes, 1);
  assert.equal(client.heartbeats.length, 1);
});

test("a partial import exceeding the batch budget never advances freshness", async t => {
  const client = fakeClient(), records = Array.from({ length: 3001 }, (_, i) => row({ TokenID: String(i + 1) }));
  await assert.rejects(syncMintSheet({ client, records, stateFile: path.join(temp(t), "sync.json"), dryRun: false }), /batch budget/);
  assert.equal(client.rows.length, 3000); assert.equal(client.heartbeats.length, 0);
});

test("an unsuccessful sheet write re-plans empty reserved rows before retry", async t => {
  const client = fakeClient(), stateFile = path.join(temp(t), "sync.json"), write = client.write;
  client.write = async () => { throw new Error("request did not reach Google"); };
  await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /did not reach/);
  assert.ok(readJson(stateFile, {}).pending);
  client.write = write;
  await syncMintSheet({ client, records: [row()], stateFile, dryRun: false });
  assert.equal(client.rows.length, 1); assert.equal(client.writes, 1);
});

test("a completed ledger write followed by fsync failure reconciles before retry", t => {
  const ledger = createMintLedger(temp(t)), original = fs.fsyncSync, mint = row();
  try {
    fs.fsyncSync = () => { throw new Error("fsync failed"); };
    assert.throws(() => ledger.append(mint, Date.parse(mint.DateUTC)), /fsync/);
  } finally { fs.fsyncSync = original; }
  assert.equal(ledger.append(mint, Date.parse(mint.DateUTC)), false);
  assert.equal(ledger.read().length, 1);
});

test("sheet reporting checks expose metadata problems and fail on formula errors", async () => {
  const client = new SheetsClient({ spreadsheetId: "test", getToken: async () => "token" });
  const checks = ["Receipt conflicts", "Unmapped events", "Unassigned phase pieces", "Project warnings", "Adjustment checks", "Wallet checks", "Duplicate phase rules"].map(name => [name, 0]);
  checks.push(["Import checks", "Passed"]);
  client.values = async () => checks;
  assert.deepEqual(await client.health(), []);
  checks[1][1] = 2; checks[7][1] = "Needs review";
  assert.deepEqual(await client.health(), ["Unmapped events: 2"]);
  checks[2][1] = "#REF!"; await assert.rejects(client.health(), /formula errors/);
});

test("sheet HTTP failures do not leak credentials or blindly retry writes", async () => {
  let calls = 0;
  const client = new SheetsClient({ spreadsheetId: "test-id", getToken: async () => "SECRET", fetchImpl: async () => { calls++; return { ok: false, status: 403 }; } });
  await assert.rejects(client.write([]), e => !e.message.includes("SECRET") && /403/.test(e.message));
  assert.equal(calls, 1);
});

test("layout verifies V2 headers, preserved formula and dependent capacity", async () => {
  const make = (title, headers, rowTwo, rowCount = 12000) => ({ properties: { title, gridProperties: { rowCount } }, data: [{ rowData: [{ values: headers.map(stringValue => ({ userEnteredValue: { stringValue } })) }, { values: rowTwo }] }] });
  const rawRow = Array(14).fill({}); rawRow[13] = { userEnteredValue: { formulaValue: '=ARRAYFORMULA(IF(A2:A12000="","",LOWER(I2:I12000)&"|"&LOWER(J2:J12000)&"|"&L2:L12000&"|"&H2:H12000))' } };
  const ledger = { properties: { title: "Mint Ledger" }, data: [{ startRow: 1, rowData: [{ values: [{ userEnteredValue: { formulaValue: "=SORTN('Raw Imports'!A2:Q12000)" } }] }] }] };
  const sheets = [make("Raw Imports", RAW_HEADERS, rawRow), make("Import Log", LOG_HEADERS, [], 500), ledger];
  const client = new SheetsClient({ spreadsheetId: "test-id", getToken: async () => "token", fetchImpl: async () => ({ ok: true, async json() { return { sheets }; } }) });
  assert.equal((await client.layout(12000)).logRows, 500);
  sheets[0].data[0].rowData[0].values[0].userEnteredValue.stringValue = "Changed";
  await assert.rejects(client.layout(12000), /headers/);
});

test("9 PM Vancouver respects B.C.'s permanent UTC−7; historical winter still uses UTC−8", () => {
  assert.equal(localSchedule(new Date("2026-10-01T03:59:00Z"), "America/Vancouver", 21).due, false);
  assert.equal(localSchedule(new Date("2026-10-01T04:00:00Z"), "America/Vancouver", 21).due, true);
  assert.equal(localSchedule(new Date("2026-12-01T03:59:00Z"), "America/Vancouver", 21).due, false);
  assert.equal(localSchedule(new Date("2026-12-01T04:00:00Z"), "America/Vancouver", 21).due, true);
  assert.equal(localSchedule(new Date("2026-01-01T04:59:00Z"), "America/Vancouver", 21).due, false);
  assert.equal(localSchedule(new Date("2026-01-01T05:00:00Z"), "America/Vancouver", 21).due, true);
});

test("11 PM discovery and 11:30 PM imports respect minute and local-day boundaries", () => {
  assert.deepEqual(localSchedule(new Date("2026-10-01T05:59:59Z"), "America/Vancouver", 23, 0), { day: "2026-09-30", due: false });
  assert.deepEqual(localSchedule(new Date("2026-10-01T06:00:00Z"), "America/Vancouver", 23, 0), { day: "2026-09-30", due: true });
  assert.equal(localSchedule(new Date("2026-10-01T06:29:59Z"), "America/Vancouver", 23, 30).due, false);
  assert.deepEqual(localSchedule(new Date("2026-10-01T06:30:00Z"), "America/Vancouver", 23, 30), { day: "2026-09-30", due: true });
  assert.deepEqual(localSchedule(new Date("2026-10-01T07:00:00Z"), "America/Vancouver", 23, 30), { day: "2026-10-01", due: false });
  assert.equal(localSchedule(new Date("2026-12-01T06:29:59Z"), "America/Vancouver", 23, 30).due, false);
  assert.equal(localSchedule(new Date("2026-12-01T06:30:00Z"), "America/Vancouver", 23, 30).due, true);
  assert.equal(localSchedule(new Date("2026-01-01T07:29:59Z"), "America/Vancouver", 23, 30).due, false);
  assert.equal(localSchedule(new Date("2026-01-01T07:30:00Z"), "America/Vancouver", 23, 30).due, true);
});

test("minute scheduling rejects invalid values and preserves whole-hour configurations", () => {
  const defaults = { enabled: true, mode: "observe", hour: 23, minute: 0, timeZone: "America/Vancouver" };
  for (const minute of [-1, 60, 0.5, "30", null]) {
    assert.throws(() => settings({ minute }, defaults, ["observe"]), /minute/);
  }
  assert.equal(settings({}, defaults, ["observe"]).minute, 0);
  assert.equal(settings({ minute: 30 }, defaults, ["observe"]).minute, 30);
  assert.equal(localSchedule(new Date("2026-10-01T06:00:00Z"), "America/Vancouver", 23).due, true);
});

test("11:30 PM job waits for the minute, deduplicates after midnight and recovers interrupted work", async t => {
  const file = path.join(temp(t), "job.json"); let clock = new Date("2026-10-01T06:29:59Z"), runs = 0;
  const options = { name: "half-hour", file, timeZone: "America/Vancouver", hour: 23, minute: 30,
    now: () => clock, run: async () => ({ runs: ++runs }), log() {} };
  await createDailyJob(options).tick(); assert.equal(runs, 0); assert.equal(fs.existsSync(file), false);
  clock = new Date("2026-10-01T06:30:00Z");
  await createDailyJob(options).tick(); await createDailyJob(options).tick(); assert.equal(runs, 1);
  assert.equal(readJson(file, {}).lastCompletedDay, "2026-09-30");
  clock = new Date("2026-10-01T07:00:00Z"); await createDailyJob(options).tick(); assert.equal(runs, 1);
  clock = new Date("2026-10-02T06:29:59Z"); await createDailyJob(options).tick(); assert.equal(runs, 1);
  clock = new Date("2026-10-02T06:30:00Z"); await createDailyJob(options).tick(); assert.equal(runs, 2);
  writeJson(file, { lastCompletedDay: "2026-10-01", unfinishedSlot: "2026-10-02", lastAttempt: "2026-10-03T06:30:00.000Z", nextAttempt: Date.parse("2026-10-03T15:15:00Z") });
  clock = new Date("2026-10-03T15:00:00Z"); await createDailyJob(options).tick(); assert.equal(runs, 2);
  clock = new Date("2026-10-03T15:15:00Z"); await createDailyJob(options).tick(); await createDailyJob(options).tick();
  assert.equal(runs, 3); assert.equal(readJson(file, {}).lastCompletedDay, "2026-10-02");
  assert.equal(readJson(file, {}).unfinishedSlot, null);
});

test("scheduler runs once per day, survives restart and catches up once before evening", async t => {
  const file = path.join(temp(t), "job.json"); let clock = new Date("2026-10-01T04:00:00Z"), runs = 0;
  const options = { name: "test", file, timeZone: "America/Vancouver", hour: 21, now: () => clock, run: async () => ({ runs: ++runs }), log: () => {} };
  await createDailyJob(options).tick(); await createDailyJob(options).tick(); assert.equal(runs, 1);
  clock = new Date("2026-10-03T15:00:00Z");
  const job = createDailyJob(options); await job.tick(); await job.tick(); assert.equal(runs, 2);
  clock = new Date("2026-10-04T04:00:00Z"); await job.tick(); assert.equal(runs, 3);
});

test("an interrupted first daily run recovers on the next morning restart", async t => {
  const file = path.join(temp(t), "job.json");
  execFileSync(process.execPath, ["-e", `
    const { createDailyJob } = require(process.argv[1]);
    createDailyJob({ name: "interrupted", file: process.argv[2], timeZone: "America/Vancouver", hour: 21,
      now: () => new Date("2026-10-01T04:00:00Z"), run: () => process.exit(0), log() {} }).tick();
  `, require.resolve("../daily-jobs"), file]);
  const interrupted = readJson(file, {});
  assert.equal(interrupted.lastCompletedDay, undefined); assert.equal(interrupted.lastError, undefined);
  let clock = new Date("2026-10-01T15:00:00Z"), runs = 0;
  const options = { name: "interrupted", file, timeZone: "America/Vancouver", hour: 21,
    now: () => clock, run: async () => ({ runs: ++runs }), log() {} };
  await createDailyJob(options).tick();
  assert.equal(runs, 1);
  assert.equal(interrupted.unfinishedSlot, "2026-09-30");
  assert.equal(readJson(file, {}).unfinishedSlot, null);
  assert.equal(readJson(file, {}).lastCompletedDay, "2026-09-30");
  await createDailyJob(options).tick(); assert.equal(runs, 1);
  clock = new Date("2026-10-02T04:00:00Z");
  await createDailyJob(options).tick(); assert.equal(runs, 2);
});

test("a legacy first attempt without a completion also recovers before the scheduled hour", async t => {
  const file = path.join(temp(t), "job.json");
  writeJson(file, { lastAttempt: "2026-10-01T04:00:00.000Z" });
  let runs = 0;
  const job = createDailyJob({ name: "legacy", file, timeZone: "America/Vancouver", hour: 21,
    now: () => new Date("2026-10-01T15:00:00Z"), run: async () => ({ runs: ++runs }), log() {} });
  await job.tick(); await job.tick(); assert.equal(runs, 1);
  assert.equal(job.status().unfinishedSlot, null);
});

test("unfinished recovery retains retry backoff across a restart and coalesces missed days", async t => {
  const file = path.join(temp(t), "job.json");
  writeJson(file, { unfinishedSlot: "2026-09-30", lastAttempt: "2026-10-01T04:00:00.000Z" });
  let clock = new Date("2026-10-03T15:00:00Z"), runs = 0, fail = true;
  const options = { name: "recover", file, timeZone: "America/Vancouver", hour: 21,
    now: () => clock, run: async () => { runs++; if (fail) throw new Error("temporary failure"); return {}; }, log() {} };
  await createDailyJob(options).tick(); assert.equal(runs, 1);
  assert.equal(readJson(file, {}).unfinishedSlot, "2026-10-02");
  fail = false; clock = new Date("2026-10-03T15:05:00Z");
  await createDailyJob(options).tick(); assert.equal(runs, 1);
  clock = new Date("2026-10-03T15:16:00Z");
  const restarted = createDailyJob(options); await restarted.tick(); await restarted.tick();
  assert.equal(runs, 2); assert.equal(restarted.status().lastCompletedDay, "2026-10-02");
  assert.equal(restarted.status().unfinishedSlot, null);
});

test("a fresh first startup before the scheduled hour does not create an unfinished slot", async t => {
  const file = path.join(temp(t), "job.json"); let runs = 0;
  const job = createDailyJob({ name: "fresh", file, timeZone: "America/Vancouver", hour: 21,
    now: () => new Date("2026-10-01T15:00:00Z"), run: async () => ({ runs: ++runs }), log() {} });
  await job.tick(); assert.equal(runs, 0); assert.equal(fs.existsSync(file), false);
});

test("failed daily job retries without marking success and throttles alerts", async t => {
  const file = path.join(temp(t), "job.json"); let clock = new Date("2026-10-01T04:00:00Z"), attempts = 0, alerts = 0;
  const job = createDailyJob({ name: "test", file, timeZone: "America/Vancouver", hour: 21, now: () => clock, run: async () => { attempts++; throw new Error("temporary failure"); }, alert: async () => { alerts++; }, log: () => {} });
  await job.tick(); await job.tick(); assert.equal(attempts, 1); assert.equal(alerts, 1);
  clock = new Date("2026-10-01T04:16:00Z"); await job.tick(); assert.equal(attempts, 2); assert.equal(alerts, 1);
  assert.equal(readJson(file, {}).lastCompletedDay, undefined);
});

test("concurrent scheduler ticks cannot run the job twice", async t => {
  let finish, runs = 0;
  const job = createDailyJob({ name: "test", file: path.join(temp(t), "job.json"), timeZone: "America/Vancouver", hour: 21, now: () => new Date("2026-10-01T04:00:00Z"), run: () => { runs++; return new Promise(resolve => { finish = resolve; }); }, log: () => {} });
  const first = job.tick(); await job.tick(); finish({}); await first; assert.equal(runs, 1);
});

test("corrupt automation state is not reset into an unsafe fresh run", t => {
  const file = path.join(temp(t), "state.json"); fs.writeFileSync(file, "invalid");
  assert.throws(() => readJson(file, {}), /Cannot read/);
  writeJson(file, { safe: true }); assert.deepEqual(readJson(file, {}), { safe: true });
});

test("review items alert on change and remain visible without repeating daily alerts", async t => {
  let clock = new Date("2026-10-01T04:00:00Z"), alerts = 0, review = ["New collection needs auction setup"];
  const job = createDailyJob({ name: "review", file: path.join(temp(t), "job.json"), hour: 21, timeZone: "America/Vancouver", now: () => clock, run: async () => ({ needsReview: review }), alert: async () => { alerts++; }, log() {} });
  await job.tick(); assert.equal(alerts, 1);
  clock = new Date("2026-10-02T04:00:00Z"); await job.tick(); assert.equal(alerts, 1);
  review = []; clock = new Date("2026-10-03T04:00:00Z"); await job.tick();
  review = ["New collection needs auction setup"]; clock = new Date("2026-10-04T04:00:00Z"); await job.tick(); assert.equal(alerts, 2);
});

test("invalid closed reviews preserve applied sales coverage through bot startup and pause discovery", async t => {
  const manual = { name: "Reviewed legacy", standard: "erc721", contractAddress: A };
  const discovered = { name: "Previously discovered", standard: "erc721", contractAddress: W };
  const review = { contractAddress: A, supplySignature: JSON.stringify(["erc721", 10, 10, []]), auctionSupply: 0 };
  for (const settings of [{ enabled: true, mode: "apply" }, { enabled: true, mode: "observe" }, { enabled: false, mode: "apply" }]) {
    for (const issue of ["malformed", "duplicate", "missing auction snapshot", "manual mint overlap"]) {
      const stateDir = temp(t), file = path.join(stateDir, "collection_registry.json");
      writeJson(file, { version: 1, entries: { [W]: { collection: discovered, salesAdded: true, mintAdded: true, mintStartBlock: 95 } }, observed: [W], lastScanBlock: 100 });
      const before = fs.readFileSync(file, "utf8"), alerts = [];
      const mintCollections = issue === "manual mint overlap" ? [manual] : [];
      const reviewedClosedCollections = issue === "malformed" ? [{}] : issue === "duplicate" ? [review, review] : issue === "missing auction snapshot" ? [{ ...review, auctionSupply: undefined }] : [review];
      const forbidden = () => { assert.fail("Paused discovery must not fetch, initialize, or read the ledger"); };
      const args = { config: { collectionDiscovery: { ...settings, autoAdd: true, autoRetire: true, reviewedClosedCollections }, sales: { collections: [manual] } }, stateDir, mintCollections,
        ledger: { read: forbidden }, provider: { getBlockNumber: forbidden }, loadMintState: forbidden, initializeMint: forbidden, initializeSales: forbidden, alert: async message => alerts.push(message), log() {} };
      for (let restart = 0; restart < 2; restart++) {
        const automation = createBotAutonomy(args);
        assert.match(automation.status().join("\n"), /Collection discovery paused: Invalid reviewed closed/);
        assert.deepEqual(automation.salesCollections(), [manual, discovered]);
        const expectedMint = settings.enabled && settings.mode === "apply" ? [...mintCollections, { ...discovered, startBlock: 95, discoveryCatchup: true }] : mintCollections;
        assert.deepEqual(automation.mintCollections(), expectedMint);
        await automation.tick(); await automation.tick();
        assert.equal(alerts.length, restart + 1);
        assert.equal(fs.readFileSync(file, "utf8"), before);
        assert.equal(fs.existsSync(path.join(stateDir, "discovery_job.json")), false);
      }
    }
  }
});

test("invalid automation config preserves manual tracking and reports the configuration error", async t => {
  const mint = { name: "Test", contractAddress: A, standard: "erc721" };
  const automation = createBotAutonomy({ config: { collections: [mint], sales: { collections: [mint] }, sheetSync: { enabled: true, mode: "invalid" } }, stateDir: temp(t), mintCollections: [mint], ledger: { read() { throw new Error("Must not read ledger"); } }, alert: async () => {}, log() {} });
  assert.deepEqual(automation.mintCollections(), [mint]);
  assert.deepEqual(automation.salesCollections(), [mint]);
  assert.ok(automation.status().some(text => text.includes("Sheet sync disabled")));
  await automation.tick(); automation.stop();
});

test("blank-displaying formulas in every writable Raw Imports region stop the import", async t => {
  for (const column of [0, 12, 14, 16]) {
    const client = fakeClient(), entered = Array(17).fill(""); entered[column] = '=IF(TRUE,"",1)';
    client.enteredRows = [entered];
    const stateFile = path.join(temp(t), "sync.json");
    await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /Raw Imports changed|destination.*occupied/);
    assert.equal(client.writes, 0);
    assert.equal(client.enteredRows[0][column], '=IF(TRUE,"",1)');
    assert.equal(readJson(stateFile, {}).pending, undefined);
  }
});

test("the owned event-ID formula is excluded but blank Import Log formulas are preserved", async t => {
  const client = fakeClient();
  client.enteredRows = [Array(17).fill("")]; client.enteredRows[0][13] = '=ARRAYFORMULA(IF(A2:A12000="","",I2:I12000))';
  client.enteredLogs = [Array(8).fill("")]; client.enteredLogs[0][7] = '=""';
  const result = await syncMintSheet({ client, records: [row()], stateFile: path.join(temp(t), "sync.json"), dryRun: false });
  assert.equal(result.newEvents, 1);
  assert.equal(client.logs[0], undefined);
  assert.equal(client.logs[1][0], "bot-daily");
  assert.equal(client.enteredRows[0][13].startsWith("=ARRAYFORMULA"), true);
  assert.equal(client.enteredLogs[0][7], '=""');
});

test("Sheets input reads request formulas rather than calculated blank results", async () => {
  const requests = [];
  const client = new SheetsClient({ spreadsheetId: "test-sheet", getToken: async () => "token", fetchImpl: async url => {
    requests.push(new URL(url).searchParams.get("valueRenderOption"));
    return { ok: true, async json() { return { values: [[requests.at(-1) === "FORMULA" ? '=""' : ""]] }; } };
  } });
  assert.deepEqual(await client.values("'Raw Imports'!A2:A2"), [[""]]);
  assert.deepEqual(await client.inputValues("'Raw Imports'!A2:A2"), [['=""']]);
  assert.deepEqual(requests, ["UNFORMATTED_VALUE", "FORMULA"]);
});

test("a pending validation write cannot be recovered against a different workbook", async t => {
  const stateFile = path.join(temp(t), "shared-state.json"), validation = fakeClient("validation"), production = fakeClient("production");
  validation.loseResponse = true;
  await assert.rejects(syncMintSheet({ client: validation, records: [row()], stateFile, dryRun: false }), /response lost/);
  const saved = fs.readFileSync(stateFile, "utf8");
  production.rows = [effective(rawValues(row({ TokenID: "99" })))];
  production.layout = async () => { throw new Error("Wrong workbook was accessed before journal identity validation"); };
  await assert.rejects(syncMintSheet({ client: production, records: [row()], stateFile, dryRun: false }), /different spreadsheet/);
  assert.equal(production.writes, 0); assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
});

test("separate workbook journals let production import while a validation write is pending", async t => {
  const dir = temp(t), validation = fakeClient("validation"), production = fakeClient("production");
  const copyPaths = sheetStatePaths(dir, validation.spreadsheetId), prodPaths = sheetStatePaths(dir, production.spreadsheetId);
  assert.notEqual(copyPaths.stateFile, prodPaths.stateFile); assert.notEqual(copyPaths.jobFile, prodPaths.jobFile);
  assert.throws(() => sheetStatePaths(dir, "../other"), /spreadsheet ID/);
  validation.loseResponse = true;
  await assert.rejects(syncMintSheet({ client: validation, records: [row()], stateFile: copyPaths.stateFile, dryRun: false }), /response lost/);
  const saved = fs.readFileSync(copyPaths.stateFile, "utf8");
  production.rows = [effective(rawValues(row({ TokenID: "99" })))];
  const result = await syncMintSheet({ client: production, records: [row()], stateFile: prodPaths.stateFile, dryRun: false });
  assert.equal(result.newEvents, 1); assert.equal(result.startRow, 3);
  assert.equal(fs.readFileSync(copyPaths.stateFile, "utf8"), saved);
  await syncMintSheet({ client: validation, records: [row()], stateFile: copyPaths.stateFile, dryRun: false });
  assert.equal(validation.writes, 1); assert.equal(production.writes, 1);
  assert.equal(readJson(copyPaths.stateFile, {}).pending, null);
  assert.equal(readJson(prodPaths.stateFile, {}).spreadsheetId, "production");
});

test("legacy unscoped and mismatched pending journals are preserved for review", async t => {
  const stateFile = path.join(temp(t), "sync.json"), client = fakeClient("validation"); client.loseResponse = true;
  await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /response lost/);
  const state = readJson(stateFile, {});
  for (const changed of [
    { ...state, spreadsheetId: undefined, pending: { ...state.pending, spreadsheetId: undefined } },
    { ...state, spreadsheetId: "validation", pending: { ...state.pending, spreadsheetId: "other" } },
  ]) {
    writeJson(stateFile, changed); const saved = fs.readFileSync(stateFile, "utf8");
    await assert.rejects(syncMintSheet({ client, records: [row()], stateFile, dryRun: false }), /unscoped|different spreadsheet/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
  }
  assert.equal(client.writes, 1);
});

test("a completed validation schedule does not become the production schedule", t => {
  const stateDir = temp(t), paths = sheetStatePaths(stateDir, "validation");
  writeJson(paths.jobFile, { lastSuccess: "validation-marker", lastCompletedDay: "2026-09-30" });
  const config = { sales: { collections: [] }, sheetSync: { enabled: true, mode: "dry-run", spreadsheetId: "production" } };
  const automation = createBotAutonomy({ config, stateDir, mintCollections: [], env: { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: "service_account", client_email: "test@example.com", private_key: "test-key" }) }, alert: async () => {}, log() {} });
  const status = automation.status().join("\n");
  assert.ok(status.includes("last success none")); assert.ok(!status.includes("validation-marker"));
  automation.stop();
});
