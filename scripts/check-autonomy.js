"use strict";

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { readMintRecords } = require("../mint-ledger");
const { fetchCatalog, parseCatalog } = require("../collection-discovery");
const { SheetsClient, sheetStatePaths, syncMintSheet } = require("../sheets-sync");

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
  const action = process.argv[2];
  if (action === "catalog") {
    const catalog = process.argv[3] ? parseCatalog(fs.readFileSync(process.argv[3], "utf8")) : await fetchCatalog();
    const mint = new Set(config.collections.map(c => c.contractAddress.toLowerCase())), sales = new Set(config.sales.collections.map(c => c.contractAddress.toLowerCase()));
    console.log(JSON.stringify({ mode: "read-only", collections: catalog.length, missingSales: catalog.filter(p => !sales.has(p.address)).map(p => p.name), missingMint: catalog.filter(p => !mint.has(p.address)).map(p => p.name) }, null, 2));
  } else if (action === "sheet") {
    const dataDir = process.env.DATA_DIR;
    if (!dataDir) throw new Error("Set DATA_DIR to the persistent bot data directory before checking the sheet");
    let credentials;
    try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}"); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
    const client = new SheetsClient({ spreadsheetId: process.env.SHEET_VALIDATION_ID || config.sheetSync.spreadsheetId, credentials });
    const paths = sheetStatePaths(path.join(dataDir, "state"), client.spreadsheetId);
    const result = await syncMintSheet({ client, records: readMintRecords(path.join(dataDir, "ledger")), stateFile: paths.checkFile, maxRows: config.sheetSync.maxRows, dryRun: true });
    console.log(JSON.stringify(result, null, 2));
  } else if (action === "ledger") {
    if (!process.env.DATA_DIR) throw new Error("Set DATA_DIR before checking the ledger");
    console.log(JSON.stringify({ uniqueEvents: readMintRecords(path.join(process.env.DATA_DIR, "ledger")).length }, null, 2));
  } else throw new Error("Usage: npm run automation:check -- catalog [saved-html] | ledger | sheet. All commands are read-only for Google Sheets and monitoring configuration.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
