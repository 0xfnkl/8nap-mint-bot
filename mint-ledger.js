"use strict";

const fs = require("fs");
const path = require("path");
const { parseEther } = require("ethers");

const HEADERS = ["DateUTC", "ProjectKey", "Collection", "Standard", "Quantity", "MinterWallet", "ETHPrice", "TokenID", "Contract", "TxHash", "BlockNumber", "LogIndex"];

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === ",") { row.push(field); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = ""; closed = false;
    } else {
      if (closed || c === '"') throw new Error("Malformed CSV quoting");
      field += c;
    }
  }
  if (quoted || field || row.length || closed) throw new Error("Incomplete ledger CSV: missing final newline or closed quote");
  return rows;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function uint(value, name) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text) || (typeof value === "number" && !Number.isSafeInteger(value))) throw new Error(`Invalid ${name}`);
  return BigInt(text).toString();
}

function eventId(row) {
  const contract = String(row.Contract || "").toLowerCase();
  const tx = String(row.TxHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(contract) || !/^0x[0-9a-f]{64}$/.test(tx)) throw new Error("Invalid mint contract or transaction hash");
  return `${contract}|${tx}|${uint(row.LogIndex, "LogIndex")}|${uint(row.TokenID, "TokenID")}`;
}

function aggregateErc1155Batch(ids, quantities) {
  if (!Array.isArray(ids) || !Array.isArray(quantities) || ids.length !== quantities.length) throw new Error("Invalid ERC1155 batch arrays");
  const totals = new Map();
  for (let i = 0; i < ids.length; i++) {
    const tokenId = uint(ids[i], "TokenID"), quantity = BigInt(uint(quantities[i], "Quantity"));
    totals.set(tokenId, (totals.get(tokenId) || 0n) + quantity);
  }
  return [...totals].filter(([, quantity]) => quantity > 0n).map(([tokenId, quantity]) => ({ tokenId, quantity }));
}

function validateRow(row) {
  eventId(row);
  if (!/^0x[0-9a-f]{40}$/i.test(String(row.MinterWallet))) throw new Error("Invalid mint recipient");
  if (!row.Collection || !["erc721", "erc1155"].includes(row.Standard)) throw new Error("Invalid mint collection or standard");
  if (BigInt(uint(row.Quantity, "Quantity")) < 1n || (row.Standard === "erc721" && BigInt(row.Quantity) !== 1n)) throw new Error("Invalid mint quantity");
  uint(row.BlockNumber, "BlockNumber");
  if (!/^\d+(\.\d{1,18})?$/.test(String(row.ETHPrice))) throw new Error("Invalid mint ETH price");
  const ms = Date.parse(row.DateUTC);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== row.DateUTC) throw new Error("Invalid UTC mint timestamp");
  const projectKey = row.Standard === "erc1155" ? `${row.Contract.toLowerCase()}:${uint(row.TokenID, "TokenID")}` : row.Contract.toLowerCase();
  if (String(row.ProjectKey).toLowerCase() !== projectKey) throw new Error("Mint ProjectKey does not match contract/token");
  return row;
}

function fingerprint(row) {
  return JSON.stringify([row.DateUTC, row.ProjectKey.toLowerCase(), row.Standard, uint(row.Quantity, "Quantity"), row.MinterWallet.toLowerCase(), parseEther(String(row.ETHPrice)).toString(), uint(row.BlockNumber, "BlockNumber")]);
}

function readMintRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  const records = new Map();
  for (const name of fs.readdirSync(dir).filter(n => /^mints-\d{4}-\d{2}\.csv$/.test(n)).sort()) {
    const rows = parseCsv(fs.readFileSync(path.join(dir, name), "utf8"));
    if (JSON.stringify(rows.shift()) !== JSON.stringify(HEADERS)) throw new Error(`Unexpected ledger columns in ${name}`);
    for (const values of rows) {
      if (values.length !== HEADERS.length) throw new Error(`Invalid ledger row width in ${name}`);
      const row = validateRow(Object.fromEntries(HEADERS.map((h, i) => [h, values[i]])));
      const id = eventId(row), previous = records.get(id);
      if (previous && fingerprint(previous) !== fingerprint(row)) throw new Error(`Conflicting ledger records for ${id}`);
      records.set(id, row);
    }
  }
  return [...records.values()];
}

function createMintLedger(dir) {
  let records;
  return {
    append(row, timestampMs) {
      validateRow(row);
      if (Date.parse(row.DateUTC) !== timestampMs) throw new Error("Ledger timestamp mismatch");
      if (!records) records = new Map(readMintRecords(dir).map(r => [eventId(r), fingerprint(r)]));
      const id = eventId(row), signature = fingerprint(row);
      if (records.has(id)) {
        if (records.get(id) !== signature) throw new Error(`Conflicting mint retry for ${id}`);
        return false;
      }
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `mints-${row.DateUTC.slice(0, 7)}.csv`);
      const fd = fs.openSync(file, "a");
      try {
        const header = fs.fstatSync(fd).size === 0 ? HEADERS.join(",") + "\n" : "";
        fs.writeFileSync(fd, header + HEADERS.map(h => csvEscape(row[h])).join(",") + "\n");
        fs.fsyncSync(fd);
      } catch (error) {
        // A disk error can follow a complete write. Re-read before the next retry;
        // a partial trailing row is then detected instead of appending another row.
        records = null;
        throw error;
      } finally { fs.closeSync(fd); }
      records.set(id, signature);
      return true;
    },
    read: () => readMintRecords(dir),
  };
}

module.exports = { HEADERS, parseCsv, csvEscape, uint, eventId, aggregateErc1155Batch, validateRow, readMintRecords, createMintLedger };
