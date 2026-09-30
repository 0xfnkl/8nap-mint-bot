"use strict";

const { JWT } = require("google-auth-library");
const path = require("path");
const { eventId, validateRow, uint } = require("./mint-ledger");
const { readJson, writeJson } = require("./daily-jobs");

const RAW_HEADERS = ["Date UTC", "Mint project key", "Collection", "Standard", "Pieces", "Recipient wallet", "ETH per row", "Token ID", "Contract", "Transaction hash", "Block number", "Log index", "Source", "Mint event ID", "Receipt check", "Source history", "Source note"];
const LOG_HEADERS = ["Source", "Records read", "New events", "Overlapping events", "Price differences", "Source URL", "Loaded on", "Notes"];
const CHECK_NAMES = ["Receipt conflicts", "Unmapped events", "Unassigned phase pieces", "Project warnings", "Adjustment checks", "Wallet checks", "Duplicate phase rules"];
const quote = title => `'${title.replace(/'/g, "''")}'`;

function validateSpreadsheetId(spreadsheetId) {
  if (typeof spreadsheetId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(spreadsheetId)) throw new Error("Missing or invalid Google spreadsheet ID");
}

function sheetStatePaths(stateDir, spreadsheetId) {
  validateSpreadsheetId(spreadsheetId);
  return {
    stateFile: path.join(stateDir, `sheet_sync_state-${spreadsheetId}.json`),
    jobFile: path.join(stateDir, `sheet_sync_job-${spreadsheetId}.json`),
    checkFile: path.join(stateDir, `sheet_check_state-${spreadsheetId}.json`),
  };
}

function sheetNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || (name !== "ETHPrice" && !Number.isSafeInteger(number))) throw new Error(`${name} exceeds supported spreadsheet precision`);
  return number;
}

function rawValues(row) {
  validateRow(row);
  return [row.DateUTC, row.ProjectKey.toLowerCase(), row.Collection, row.Standard, sheetNumber(row.Quantity, "Quantity"), row.MinterWallet.toLowerCase(), sheetNumber(row.ETHPrice, "ETHPrice"), uint(row.TokenID, "TokenID"), row.Contract.toLowerCase(), row.TxHash.toLowerCase(), sheetNumber(row.BlockNumber, "BlockNumber"), sheetNumber(row.LogIndex, "LogIndex"), "bot-daily", null, "Recorded", "Railway mint ledger", "Imported automatically; monthly CSV retained as archive."];
}

function idFromValues(values) {
  return eventId({ Contract: values[8], TxHash: values[9], LogIndex: values[11], TokenID: values[7] });
}

function hasInput(values) {
  // Column N is an existing ARRAYFORMULA result, not an input owned by this importer.
  return values.some((value, i) => i !== 13 && value !== "" && value !== undefined && value !== null);
}

function planImport(records, existing, maxRows = 12000) {
  const seen = new Set(); let lastRow = 1;
  for (let i = 0; i < existing.length; i++) {
    const values = existing[i];
    if (!hasInput(values)) continue;
    lastRow = i + 2;
    if (!values[0]) throw new Error(`Partially populated Raw Imports row ${lastRow}; import stopped`);
    seen.add(idFromValues(values));
  }
  const rows = [];
  for (const row of records) {
    validateRow(row);
    const id = eventId(row);
    if (seen.has(id)) continue;
    seen.add(id); rows.push(rawValues(row));
  }
  if (lastRow + rows.length > maxRows) throw new Error(`Raw Imports would exceed its ${maxRows}-row formula capacity; extend the workbook before importing`);
  return { startRow: lastRow + 1, rows, recordsRead: records.length };
}

function valuesData(plan) {
  if (!plan.rows.length) return [];
  const end = plan.startRow + plan.rows.length - 1;
  return [
    { range: `${quote("Raw Imports")}!A${plan.startRow}:M${end}`, values: plan.rows.map(row => row.slice(0, 13)) },
    { range: `${quote("Raw Imports")}!O${plan.startRow}:Q${end}`, values: plan.rows.map(row => row.slice(14, 17)) },
  ];
}

function verifyRows(expected, actual) {
  if (actual.length !== expected.length) throw new Error("Sheet verification failed: row count mismatch");
  for (let i = 0; i < expected.length; i++) {
    const id = idFromValues(expected[i]);
    if (actual[i][13] !== id) throw new Error(`Sheet event-ID formula has not populated correctly for ${id}`);
    for (let j = 0; j < 17; j++) {
      if (j === 13) continue;
      // Token IDs can be returned as a numeric cell from historical imports; compare canonically.
      const left = j === 7 ? uint(actual[i][j], "TokenID") : actual[i][j];
      if (left !== expected[i][j]) throw new Error(`Sheet verification failed for ${id}, column ${j + 1}`);
    }
  }
}

class SheetsClient {
  constructor({ spreadsheetId, credentials, fetchImpl = fetch, getToken, timeoutMs = 20000 }) {
    validateSpreadsheetId(spreadsheetId);
    this.spreadsheetId = spreadsheetId;
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
    this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    if (getToken) this.getToken = getToken;
    else {
      if (!credentials || credentials.type !== "service_account" || !credentials.client_email || !credentials.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain a service-account credential");
      const auth = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"], transporterOptions: { timeout: timeoutMs } });
      this.getToken = async () => {
        try { const result = await auth.getAccessToken(); if (!result.token) throw new Error(); return result.token; }
        catch { throw new Error("Google authentication failed; check the Railway service-account credential"); }
      };
    }
  }

  async request(suffix, body) {
    const token = await this.getToken();
    let response;
    try {
      response = await this.fetchImpl(this.base + suffix, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new Error("Google Sheets request failed or timed out; results will be reconciled before retry"); }
    if (!response.ok) throw new Error(`Google Sheets returned HTTP ${response.status}; check sheet access, quota, and service health`);
    try { return await response.json(); } catch { throw new Error("Google Sheets returned an invalid response"); }
  }

  async layout(maxRows) {
    const query = new URLSearchParams({ includeGridData: "true", fields: "sheets(properties,data(startRow,startColumn,rowData(values(userEnteredValue))))" });
    for (const range of ["'Raw Imports'!A1:Q2", "'Mint Ledger'!A2", "'Import Log'!A1:H1"]) query.append("ranges", range);
    const result = await this.request(`?${query}`);
    const raw = result.sheets?.find(s => s.properties.title === "Raw Imports");
    const log = result.sheets?.find(s => s.properties.title === "Import Log");
    const ledger = result.sheets?.find(s => s.properties.title === "Mint Ledger");
    const cells = (s, row) => {
      const grid = s?.data?.find(d => (d.startRow || 0) <= row && row < (d.startRow || 0) + (d.rowData?.length || 0));
      return grid?.rowData[row - (grid.startRow || 0)]?.values || [];
    };
    if (JSON.stringify(cells(raw, 0).map(c => c.userEnteredValue?.stringValue)) !== JSON.stringify(RAW_HEADERS)) throw new Error("Raw Imports headers do not match the verified V2 schema");
    if (JSON.stringify(cells(log, 0).map(c => c.userEnteredValue?.stringValue)) !== JSON.stringify(LOG_HEADERS)) throw new Error("Import Log headers do not match the verified V2 schema");
    const idFormula = cells(raw, 1)[13]?.userEnteredValue?.formulaValue || "";
    const ledgerFormula = cells(ledger, 1)[0]?.userEnteredValue?.formulaValue || "";
    if (!idFormula.includes("ARRAYFORMULA") || !idFormula.includes(`A2:A${maxRows}`) || !idFormula.includes(`I2:I${maxRows}`) || !idFormula.includes(`J2:J${maxRows}`) || !idFormula.includes(`L2:L${maxRows}`) || !idFormula.includes(`H2:H${maxRows}`) || !ledgerFormula.includes(`'Raw Imports'!A2:Q${maxRows}`)) throw new Error("Workbook formula capacity or event-ID formula changed; import stopped");
    if (raw.properties.gridProperties.rowCount < maxRows) throw new Error("Raw Imports grid is smaller than its configured formula capacity");
    return { logRows: log.properties.gridProperties.rowCount };
  }

  async values(range, render = "UNFORMATTED_VALUE") {
    const result = await this.request(`/values/${encodeURIComponent(range)}?valueRenderOption=${render}`);
    return result.values || [];
  }

  async inputValues(range) {
    // FORMULA returns the entered expression even when its calculated result is "".
    // https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueRenderOption
    return this.values(range, "FORMULA");
  }

  async write(data) {
    // No blind POST retries. A timeout may follow a successful write; the next job first reads the sheet.
    return this.request("/values:batchUpdate", { valueInputOption: "RAW", data });
  }

  async health() {
    const checks = await this.values("'Reporting Checks'!A5:B12");
    if (checks.length !== 8 || checks.slice(0, 7).some((row, i) => row[0] !== CHECK_NAMES[i] || !Number.isSafeInteger(row[1]) || row[1] < 0) || checks[7][0] !== "Import checks" || !["Passed", "Needs review"].includes(checks[7][1])) throw new Error("Reporting Checks format changed or contains formula errors; review the workbook");
    return checks.slice(0, 7).filter(row => row[1] > 0).map(row => `${row[0]}: ${row[1]}`);
  }
}

async function syncBatch({ client, records, stateFile, maxRows = 12000, dryRun = true, now = new Date() }) {
  const spreadsheetId = client.spreadsheetId;
  validateSpreadsheetId(spreadsheetId);
  let state = readJson(stateFile, {});
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Invalid sheet sync state");
  if (state.spreadsheetId !== undefined && state.spreadsheetId !== spreadsheetId) throw new Error("Sheet sync state belongs to a different spreadsheet; journal preserved");
  if (state.pending) {
    if (!state.spreadsheetId || !state.pending.spreadsheetId) throw new Error("Cannot recover an unscoped pending sheet write; identify its original workbook before migration");
    if (state.pending.spreadsheetId !== spreadsheetId) throw new Error("Pending sheet write belongs to a different spreadsheet; journal preserved");
    if (!Number.isSafeInteger(state.pending.startRow) || state.pending.startRow < 2 || !Array.isArray(state.pending.rows) || !state.pending.rows.length || state.pending.rows.length > 500 || state.pending.startRow + state.pending.rows.length - 1 > maxRows) throw new Error("Invalid pending sheet write; journal preserved");
  }
  state = { ...state, spreadsheetId };
  const layout = await client.layout(maxRows);
  if (state.pending) {
    const pending = state.pending;
    const actual = await client.values(`'Raw Imports'!A${pending.startRow}:Q${pending.startRow + pending.rows.length - 1}`);
    if (actual.some(hasInput)) {
      verifyRows(pending.rows, actual);
      if (pending.logRow && JSON.stringify(await client.values(`'Import Log'!A${pending.logRow}:H${pending.logRow}`)) !== JSON.stringify([pending.logRecord])) throw new Error("Pending Import Log verification failed");
      writeJson(stateFile, { ...state, pending: null, lastVerified: now.toISOString() });
    } else {
      // An unsuccessful request left the reserved rows empty. Re-plan against fresh sheet contents.
      writeJson(stateFile, { ...state, pending: null });
    }
    state = readJson(stateFile, {});
  }
  const existing = await client.values(`'Raw Imports'!A2:Q${maxRows}`);
  const plan = planImport(records, existing, maxRows);
  if (dryRun || !plan.rows.length) return { mode: dryRun ? "dry-run" : "apply", recordsRead: records.length, newEvents: plan.rows.length, startRow: plan.startRow };
  const missing = plan.rows.length;
  plan.rows = plan.rows.slice(0, 500);
  const end = plan.startRow + plan.rows.length - 1;
  const destination = await client.inputValues(`'Raw Imports'!A${plan.startRow}:Q${end}`);
  if (destination.some(hasInput)) throw new Error("Raw Imports changed during planning; retry will read the sheet again");
  const logValues = await client.inputValues(`'Import Log'!A2:H${layout.logRows}`);
  const logRow = 2 + logValues.length;
  if (logRow > layout.logRows) throw new Error("Import Log is full; extend it before importing");
  const logRecord = ["bot-daily", records.length, plan.rows.length, records.length - missing, 0, "Railway persistent mint ledger", now.toISOString().slice(0, 10), `Automatic import; ${missing - plan.rows.length} new events remain in this run. Existing records and monthly CSV archives preserved.`];
  const data = [...valuesData(plan), { range: `'Import Log'!A${logRow}:H${logRow}`, values: [logRecord] }];
  writeJson(stateFile, { ...state, pending: { ...plan, spreadsheetId, logRow, logRecord } });
  await client.write(data);
  verifyRows(plan.rows, await client.values(`'Raw Imports'!A${plan.startRow}:Q${end}`));
  const actualLog = await client.values(`'Import Log'!A${logRow}:H${logRow}`);
  if (JSON.stringify(actualLog) !== JSON.stringify([logRecord])) throw new Error("Import Log verification failed");
  writeJson(stateFile, { ...state, pending: null, lastVerified: now.toISOString(), lastImportedEvents: plan.rows.length });
  return { mode: "apply", recordsRead: records.length, newEvents: plan.rows.length, startRow: plan.startRow, more: missing > plan.rows.length };
}

async function syncMintSheet(options) {
  let total = 0, firstRow;
  // Six batches stay below the standard 60 reads/minute service-account quota.
  for (let batch = 0; batch < 6; batch++) {
    const result = await syncBatch(options);
    firstRow ??= result.startRow;
    total += result.newEvents;
    if (!result.more) return { ...result, newEvents: total, startRow: firstRow, needsReview: await options.client.health() };
  }
  throw new Error("Sheet import exceeded its per-run batch budget; completed batches are preserved and the next run will reconcile them");
}

module.exports = { RAW_HEADERS, LOG_HEADERS, rawValues, planImport, valuesData, verifyRows, SheetsClient, sheetStatePaths, syncMintSheet };
