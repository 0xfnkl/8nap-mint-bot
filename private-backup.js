"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { JWT } = require("google-auth-library");
const { readMintRecords } = require("./mint-ledger");

const MAX_BYTES = 24 * 1024 * 1024, MAX_ARCHIVE = 8 * 1024 * 1024, MAX_FILES = 512;
const SOURCE = "8nap-bot-backup-v1";
const allowed = name => /^(ledger\/mints-\d{4}-\d{2}\.csv|ledger-sales\/[a-zA-Z0-9_-]+\.csv|state\/(sales\/)?[a-zA-Z0-9_-]+\.json)$/.test(name);
const hash = (bytes, algorithm = "sha256") => crypto.createHash(algorithm).update(bytes).digest("hex");
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };

function captureArchive(dataDir, { now = new Date(), commit = "unknown" } = {}) {
  const files = []; let bytes = 0;
  // No await occurs while reading. The one bot process writes these files
  // synchronously, so pollers and pending import journals cannot interleave.
  for (const directory of ["ledger", "ledger-sales", "state", "state/sales"]) {
    const dir = path.join(dataDir, directory);
    if (!fs.existsSync(dir)) { requireThat(!["ledger", "state"].includes(directory), "Backup is missing ledger or state"); continue; }
    requireThat(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), "Backup source directory is not regular");
    for (const name of fs.readdirSync(dir).sort()) {
      const relative = directory + "/" + name;
      if (!allowed(relative)) continue;
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      requireThat(stat.isFile() && !stat.isSymbolicLink(), "Backup source contains a non-regular file");
      bytes += stat.size;
      requireThat(bytes <= MAX_BYTES && files.length < MAX_FILES, "Backup exceeds its size/file limit; existing copies preserved");
      const data = fs.readFileSync(file);
      if (name.endsWith(".json")) { try { JSON.parse(data.toString("utf8")); } catch { throw new Error("Backup contains unreadable state; existing copies preserved"); } }
      files.push({ path: relative, bytes: data.length, sha256: hash(data), data: data.toString("base64") });
    }
  }
  requireThat(files.some(f => f.path.startsWith("ledger/")) && files.some(f => f.path.startsWith("state/")), "Backup source is empty");
  // Check paths and the byte budget before parsing the ledger into memory.
  try { readMintRecords(path.join(dataDir, "ledger")); } catch { throw new Error("Mint ledger is invalid; existing backups preserved"); }
  const manifest = { version: 1, source: SOURCE, capturedAt: now.toISOString(), commit, files };
  const archive = zlib.gzipSync(Buffer.from(JSON.stringify(manifest)));
  requireThat(archive.length <= MAX_ARCHIVE, "Compressed backup exceeds its limit; existing copies preserved");
  return { archive, sha256: hash(archive), md5: hash(archive, "md5"), capturedAt: manifest.capturedAt, files: files.length, bytes };
}

function decodeArchive(archive) {
  requireThat(Buffer.isBuffer(archive) && archive.length <= MAX_ARCHIVE, "Invalid backup size");
  const manifest = JSON.parse(zlib.gunzipSync(archive, { maxOutputLength: 36 * 1024 * 1024 }));
  requireThat(manifest.version === 1 && manifest.source === SOURCE && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, "Invalid backup format");
  requireThat(Number.isFinite(Date.parse(manifest.capturedAt)) && new Date(manifest.capturedAt).toISOString() === manifest.capturedAt, "Invalid backup timestamp");
  const names = new Set(); let size = 0;
  for (const file of manifest.files) {
    requireThat(typeof file.path === "string" && allowed(file.path) && !names.has(file.path), "Invalid or duplicate backup path");
    names.add(file.path);
    requireThat(typeof file.data === "string" && file.data.length <= 4 * Math.ceil(MAX_BYTES / 3) && file.data.length % 4 === 0, "Invalid backup encoding");
    const content = Buffer.from(file.data, "base64"); size += content.length;
    // Buffer's decoder tolerates malformed text. A canonical round trip rejects
    // it without the regex stack growth caused by multi-megabyte valid files.
    requireThat(content.toString("base64") === file.data, "Invalid backup encoding");
    requireThat(size <= MAX_BYTES && file.bytes === content.length && file.sha256 === hash(content), "Backup checksum or size mismatch");
    if (file.path.endsWith(".json")) JSON.parse(content.toString("utf8"));
  }
  requireThat([...names].some(n => n.startsWith("ledger/")) && [...names].some(n => n.startsWith("state/")), "Incomplete backup");
  return manifest;
}

function validateSlots(value) {
  requireThat(value && typeof value.ownerEmail === "string" && /^[^@\s]+@[^@\s]+$/.test(value.ownerEmail) && /^[A-Za-z0-9_-]{10,128}$/.test(value.folderId || ""), "Invalid private backup ownership configuration");
  requireThat([value.ownerPermissionId, value.botPermissionId].every(id => /^[A-Za-z0-9_-]{8,128}$/.test(id || "")) && value.ownerPermissionId !== value.botPermissionId, "Backup permission identities are missing or invalid");
  const ids = [];
  for (const [kind, count] of [["daily", 7], ["weekly", 4], ["monthly", 3]]) {
    requireThat(Array.isArray(value[kind]) && value[kind].length === count && value[kind].every(id => /^[A-Za-z0-9_-]{10,128}$/.test(id)), "Backup requires 7 daily, 4 weekly and 3 monthly pre-created file IDs");
    ids.push(...value[kind]);
  }
  requireThat(new Set(ids).size === 14 && !ids.includes(value.folderId), "Backup file IDs must be distinct");
  return value;
}

function selectedSlots(slots, now) {
  // Match the bot's permanent Vancouver UTC-7 scheduling policy.
  const local = new Date(now.getTime() - 7 * 3600000);
  const day = Math.floor(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 86400000);
  const indexes = { daily: day % 7, weekly: Math.floor((day + 3) / 7) % 4, monthly: (local.getUTCFullYear() * 12 + local.getUTCMonth()) % 3 };
  return Object.entries(indexes).map(([kind, index]) => ({ id: slots[kind][index], slot: `${kind}-${index}` }));
}

class DriveBackupClient {
  constructor({ credentials, slots, fetchImpl = fetch, getToken }) {
    this.slots = validateSlots(slots); this.fetchImpl = fetchImpl;
    requireThat(credentials?.client_email && credentials.private_key, "Backup Google credential is missing");
    this.email = credentials.client_email;
    const auth = getToken ? null : new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: ["https://www.googleapis.com/auth/drive"], transporterOptions: { timeout: 20000 } });
    this.getToken = getToken || (async () => { try { const token = await auth.getAccessToken(); requireThat(token.token, "missing"); return token.token; } catch { throw new Error("Backup Google authentication failed"); } });
  }
  async request(url, options = {}) {
    const token = await this.getToken(); let response;
    try { response = await this.fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30000), headers: { ...options.headers, Authorization: `Bearer ${token}` } }); }
    catch { throw new Error("Private backup request failed or timed out; scheduled retry will preserve other copies"); }
    requireThat(response.ok, `Private backup storage returned HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error("Private backup storage returned an invalid response"); }
  }
  async verifySlot(target) {
    const fields = "id,name,mimeType,trashed,parents,owners(emailAddress),permissionIds,writersCanShare,capabilities(canEdit,canShare),properties,size,md5Checksum";
    const file = await this.request(`https://www.googleapis.com/drive/v3/files/${target.id}?fields=${encodeURIComponent(fields)}`);
    requireThat(file.id === target.id && !file.trashed && file.mimeType === "application/gzip" && file.parents?.length === 1 && file.parents[0] === this.slots.folderId && file.name === `8nap-bot-${target.slot}.json.gz` && file.properties?.backupSource === SOURCE && file.properties?.slot === target.slot, "Backup slot identity changed; existing copies preserved");
    requireThat(file.owners?.length === 1 && file.owners[0].emailAddress === this.slots.ownerEmail, "Backup slot owner changed");
    // Full permission details are hidden from writers who cannot reshare.
    // Compare the exact owner-provisioned permission IDs instead.
    const permissions = file.permissionIds || [];
    requireThat(file.writersCanShare === false && file.capabilities?.canEdit === true && file.capabilities?.canShare === false && permissions.length === 2 && permissions.includes(this.slots.ownerPermissionId) && permissions.includes(this.slots.botPermissionId), "Backup slot sharing changed; upload paused");
    return file;
  }
  async upload(target, snapshot) {
    const before = await this.verifySlot(target);
    if (before.md5Checksum === snapshot.md5 && before.properties?.sha256 === snapshot.sha256 && before.properties?.capturedAt === snapshot.capturedAt) return;
    const boundary = "8nap-" + crypto.randomBytes(16).toString("hex");
    const metadata = { properties: { backupSource: SOURCE, slot: target.slot, sha256: snapshot.sha256, capturedAt: snapshot.capturedAt } };
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`), snapshot.archive, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    await this.request(`https://www.googleapis.com/upload/drive/v3/files/${target.id}?uploadType=multipart&fields=id`, { method: "PATCH", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    const after = await this.verifySlot(target);
    requireThat(after.md5Checksum === snapshot.md5 && after.properties.sha256 === snapshot.sha256 && after.properties.capturedAt === snapshot.capturedAt && Number(after.size) === snapshot.archive.length, "Private backup readback did not match; job will retry");
  }
}

async function backupBot({ client, dataDir, now = new Date(), commit }) {
  const snapshot = captureArchive(dataDir, { now, commit });
  decodeArchive(snapshot.archive);
  for (const target of selectedSlots(client.slots, now)) await client.upload(target, snapshot);
  return { mode: "apply", files: snapshot.files, bytes: snapshot.archive.length, capturedAt: snapshot.capturedAt, verifiedCopies: 3, needsReview: [] };
}

module.exports = { SOURCE, captureArchive, decodeArchive, validateSlots, selectedSlots, DriveBackupClient, backupBot };
