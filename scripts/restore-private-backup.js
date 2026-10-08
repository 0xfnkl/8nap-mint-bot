"use strict";
// Offline only: recover into a new directory, then inspect before any live restore.
const fs = require("node:fs"), path = require("node:path");
const { decodeArchive } = require("../private-backup");
const { readMintRecords } = require("../mint-ledger");
try {
  const [input, destination] = process.argv.slice(2);
  if (!input || !destination) throw new Error("Usage: node scripts/restore-private-backup.js archive.json.gz NEW_PRIVATE_DIRECTORY");
  const requested = path.resolve(destination), target = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  const configured = path.resolve(process.env.DATA_DIR || path.join(__dirname, "../data"));
  const active = fs.existsSync(configured) ? fs.realpathSync(configured) : configured;
  if (fs.existsSync(target) || target === "/data" || target.startsWith("/data/") || target === active || target.startsWith(active + path.sep)) throw new Error("Restore destination must be new and outside the active data directory");
  const manifest = decodeArchive(fs.readFileSync(input));
  fs.mkdirSync(target, { mode: 0o700 });
  for (const file of manifest.files) {
    const name = path.join(target, file.path);
    fs.mkdirSync(path.dirname(name), { recursive: true, mode: 0o700 });
    fs.writeFileSync(name, Buffer.from(file.data, "base64"), { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ restoredFiles: manifest.files.length, capturedAt: manifest.capturedAt, ledgerEvents: readMintRecords(path.join(target, "ledger")).length, productionChanged: false }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
