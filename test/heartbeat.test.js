"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SheetsClient, SYNC_HEADERS } = require("../sheets-sync");

const at = "2026-10-01T06:31:05.000Z";
function setup() {
  const state = { exists: false, rows: [], writes: [], reads: [], loseResponse: false, corrupt: false };
  const client = new SheetsClient({ spreadsheetId: "validation", getToken: async () => "synthetic", fetchImpl: async (url, options) => {
    const target = new URL(url);
    if (options.method === "POST") {
      const body = JSON.parse(options.body); state.writes.push(body);
      if (body.requests) {
        assert.equal(state.exists, false);
        const [add, update] = body.requests;
        assert.equal(add.addSheet.properties.title, "Sync Status");
        assert.equal(update.updateCells.start.sheetId, add.addSheet.properties.sheetId);
        assert.equal(update.updateCells.fields, "userEnteredValue");
        assert.equal(add.addSheet.properties.sheetId, 900101, "avoid an existing sheet ID");
        state.exists = true;
        state.rows = update.updateCells.rows.map(row => row.values.map(cell => cell.userEnteredValue.stringValue ?? cell.userEnteredValue.numberValue));
      } else {
        assert.equal(body.valueInputOption, "RAW");
        assert.deepEqual(body.data.map(block => block.range), ["'Sync Status'!A2:D2"]);
        state.rows[1] = [...body.data[0].values[0]];
      }
      if (state.loseResponse) { state.loseResponse = false; throw new Error("lost response"); }
      return { ok: true, json: async () => ({}) };
    }
    if (target.searchParams.has("fields")) return { ok: true, json: async () => ({ sheets: [
      { properties: { sheetId: 900100, title: "Reporting Checks" } },
      ...(state.exists ? [{ properties: { sheetId: 900101, title: "Sync Status" } }] : []),
    ] }) };
    state.reads.push(target.searchParams.get("valueRenderOption"));
    const values = structuredClone(state.rows);
    if (state.corrupt && target.searchParams.get("valueRenderOption") !== "FORMULA") values[1][3]++;
    return { ok: true, json: async () => ({ values }) };
  } });
  return { state, client };
}

test("heartbeat creates only its own tab and verifies a bounded typed record", async () => {
  const { client, state } = setup();
  assert.equal(await client.publishHeartbeat(1486, at), at);
  assert.deepEqual(state.rows, [SYNC_HEADERS, ["8nap-mint-bot", "validation", at, 1486]]);
  const next = "2026-10-02T06:31:00.000Z";
  await client.publishHeartbeat(1486, next);
  assert.equal(state.writes.length, 2);
  assert.equal(state.rows[1][2], next);
  assert.ok(state.reads.includes("FORMULA"));
});

test("lost atomic creation response is recovered without a second tab", async () => {
  const { client, state } = setup(); state.loseResponse = true;
  await assert.rejects(client.publishHeartbeat(0, at), /timed out/);
  await client.publishHeartbeat(0, at);
  assert.equal(state.writes.filter(body => body.requests).length, 1);
  assert.deepEqual(state.rows, [SYNC_HEADERS, ["8nap-mint-bot", "validation", at, 0]]);
});

test("heartbeat refuses another workbook, changed headers and blank-displaying formulas", async () => {
  for (const mutate of [rows => rows[1][1] = "production", rows => rows[0][0] = "Notes", rows => rows[1][2] = '=IF(TRUE,"",1)']) {
    const { client, state } = setup(); await client.publishHeartbeat(1, at);
    mutate(state.rows); const before = structuredClone(state.rows);
    await assert.rejects(client.publishHeartbeat(1, at), /ownership or schema/);
    assert.deepEqual(state.rows, before); assert.equal(state.writes.length, 1);
  }
});

test("heartbeat readback mismatch fails rather than returning success", async () => {
  const { client, state } = setup(); state.corrupt = true;
  await assert.rejects(client.publishHeartbeat(1, at), /verification failed/);
});
