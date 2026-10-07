"use strict";

const crypto = require("node:crypto");
const { readJson, writeJson } = require("./daily-jobs");
const { collectionFromProject } = require("./collection-discovery");

const PROJECT = "Project Setup", ART = "Artwork Setup", PHASE = "Phase Rules", LOG = "Setup Log";
const HEADERS = {
  [PROJECT]: ["Project", "Artist", "Group", "Status", "Supply", "Launch date", "Completed date", "Legacy sales review (unused)", "Notes", "Project ID", "Standard"],
  [PHASE]: ["Phase key", "Project", "Token ID", "Passholder start UTC", "Allowlist start UTC", "Public start UTC", "Auction starts at token", "Special reporting phase", "Source", "Notes"],
  [LOG]: ["Change ID", "Applied UTC", "Project ID", "Change", "Source"],
};
const ART_HEADERS = ["Series", "Token ID", "Artist", "Artwork", "Supply", "Phase", "Website minted · Sep 17", "Source URL", "Notes", "Contract", "Artwork key"];
const SERIES = { "0x6b1479a88695de864940e77477811205a3d52388": "Editions", "0xa1979d3fec5aec467094f274550dd5e2f41c1830": "1/1 series" };
const serial = seconds => seconds ? seconds / 86400 + 25569 : "";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entered = cell => cell?.userEnteredValue || {};
const scalar = cell => cell?.effectiveValue?.stringValue ?? cell?.effectiveValue?.numberValue ?? cell?.userEnteredValue?.stringValue ?? cell?.userEnteredValue?.numberValue ?? "";
const value = v => v === "" ? {} : typeof v === "number" ? { numberValue: v } : { stringValue: v };
const slug = v => v.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const artworkKeyFormula = row => `=IF(OR(J${row}="",B${row}=""),"",J${row}&":"&B${row})`;

function grid(resource) {
  const sheets = new Map();
  for (const s of resource.sheets || []) {
    const cells = new Map();
    for (const data of s.data || []) for (const [r, row] of (data.rowData || []).entries()) for (const [c, cell] of (row?.values || []).entries()) cells.set(`${(data.startRow || 0) + r + 1}:${(data.startColumn || 0) + c}`, cell);
    sheets.set(s.properties.title, { ...s.properties, cells });
  }
  const cell = (sheet, row, col) => sheets.get(sheet)?.cells.get(`${row}:${col}`) || {};
  return { sheets, cell, row: (sheet, row, count) => Array.from({ length: count }, (_, col) => cell(sheet, row, col)) };
}

async function readSetup(client) {
  const metadata = await client.request("?fields=sheets.properties");
  const names = new Set(metadata.sheets?.map(s => s.properties.title));
  for (const name of [PROJECT, ART, PHASE, "Project Totals", "Mint Adjustments", "Wallet Rules"]) requireThat(names.has(name), `Missing ${name}; reporting setup preserved`);
  const params = new URLSearchParams({ fields: "sheets(properties,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,dataValidation))))" });
  for (const range of ["'Project Setup'!A9:K200", "'Artwork Setup'!A9:X500", "'Phase Rules'!A1:J500", "'Project Totals'!A1:V192", "'Mint Adjustments'!L3", "'Wallet Rules'!D2:D100", ...(names.has(LOG) ? ["'Setup Log'!A1:E1000"] : [])]) params.append("ranges", range);
  const data = await client.request(`?${params}`);
  // Keep IDs of other tabs when reserving an unused ID for the audit tab.
  data.allSheetIds = metadata.sheets.map(s => s.properties.sheetId);
  return data;
}

function schedule(fields) {
  requireThat(fields && [fields.pass, fields.allow, fields.public].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 4102444800), "published phase timestamps are missing or invalid");
  requireThat(fields.public > 0, "published public phase is missing; phase review required");
  requireThat(fields.pass <= fields.public && fields.allow <= fields.public, "published phase order requires review");
  return [serial(fields.pass), serial(fields.allow), serial(fields.public)];
}

function titleAndArtist(edition, project) {
  const text = edition.reporting?.name;
  requireThat(typeof text === "string" && text.length > 0, `edition ${edition.tokenId} has no published title`);
  const by = text.split(" by ");
  const artist = edition.reporting.artist || (by.length === 2 && by[1].trim()) || (!/^(8nap\s*art|unknown)$/i.test(project.artist) && project.artist) || "Artist unlisted";
  return { title: by.length === 2 ? by[0].trim() : text, artist };
}

function planSetup({ resource, catalog, state = {}, now = new Date() }) {
  const g = grid(resource), changes = [], summaries = [], needsReview = [];
  requireThat(Array.isArray(catalog) && new Set(catalog.map(p => p.address)).size === catalog.length, "Duplicate or invalid reporting catalog");
  const next = structuredClone(state); next.observed ||= {}; next.upcoming ||= {};
  requireThat(typeof next.observed === "object" && !Array.isArray(next.observed) && typeof next.upcoming === "object" && !Array.isArray(next.upcoming), "Invalid reporting setup baseline; journal preserved");
  function headers(sheet, row, expected) { requireThat(equal(g.row(sheet, row, expected.length).map(scalar), expected), `${sheet} schema changed; reporting setup preserved`); }
  headers(PROJECT, 9, HEADERS[PROJECT]); headers(PHASE, 1, HEADERS[PHASE]); headers(ART, 9, ART_HEADERS);
  if (g.sheets.has(LOG)) headers(LOG, 1, HEADERS[LOG]);
  const rows = (sheet, start, end, count) => Array.from({ length: end - start + 1 }, (_, i) => ({ row: start + i, cells: g.row(sheet, start + i, count), values: g.row(sheet, start + i, count).map(scalar) }));
  const projects = rows(PROJECT, 10, 200, 11), artworks = rows(ART, 10, 500, 24), phases = rows(PHASE, 2, 500, 10);
  // A broken calculated key must never make an occupied edition look absent.
  // Validate its input identity and calculated identity before indexing or
  // appending. Prepared blank rows have formulas but no metadata inputs.
  for (const r of artworks) {
    const occupied = r.cells.slice(0, 9).some(c => Object.keys(entered(c)).length) ||
      (Object.keys(entered(r.cells[9])).length && !r.cells[9].userEnteredValue.formulaValue) || r.values[10] !== "";
    if (!occupied) continue;
    const [series, token] = r.values, contract = r.values[9], key = r.values[10];
    requireThat(!r.cells[9].effectiveValue?.errorValue && !r.cells[10].effectiveValue?.errorValue &&
      typeof contract === "string" && /^0x[0-9a-f]{40}$/.test(contract) &&
      /^(0|[1-9]\d*)$/.test(String(token)) && Number.isSafeInteger(Number(token)) &&
      (SERIES[contract] === series || (series === "Other collection" && !SERIES[contract])) &&
      key === `${contract}:${token}`, `Artwork Setup row ${r.row} has a missing or invalid identity; review required`);
  }
  for (const [list, key, label] of [[projects, 9, "project"], [phases, 0, "phase"], [artworks, 10, "artwork"]]) {
    const ids = list.map(r => r.values[key]).filter(Boolean);
    requireThat(new Set(ids).size === ids.length, `Duplicate ${label} identities; reporting setup preserved`);
  }
  const lastInput = (list, columns) => Math.max(list[0].row - 1, ...list.filter(r => r.cells.slice(0, columns).some(c => Object.keys(entered(c)).length)).map(r => r.row));
  let projectRow = lastInput(projects, 11) + 1, artRow = lastInput(artworks, 9) + 1, phaseRow = lastInput(phases, 10) + 1;
  const projectIds = new Map(projects.filter(r => r.values[9]).map(r => [r.values[9], r]));
  const projectSlugs = new Set(projects.filter(r => r.values[0]).map(r => slug(r.values[0])));
  const phaseIds = new Set(phases.map(r => r.values[0]).filter(Boolean));
  const artworkIds = new Map(artworks.filter(r => r.values[10]).map(r => [r.values[10], r]));
  const change = (list, sheet, row, col, v, extra = {}) => {
    const before = entered(g.cell(sheet, row, col)), after = value(v);
    if (!equal(before, after) || extra.validation) list.push({ sheet, row, col, before, after, ...(extra.validation ? { beforeValidation: g.cell(sheet, row, col).dataValidation || {} } : {}), ...extra });
  };
  for (const p of catalog) {
    const pending = [], newProjects = [], newPhases = [], newArtworks = [];
    const upcoming = { ...next.upcoming };
    let pr = projectRow, ar = artRow, phr = phaseRow;
    const observed = { standard: p.standard, editions: p.editions.map(e => [e.tokenId, e.max]), supply: p.standard === "erc1155" ? p.editions.reduce((n, e) => n + e.max, 0) : p.max };
    try {
      requireThat(!p.reportingConflict, "published reporting metadata conflicts between catalog records; setup preserved for review");
      requireThat(/^0x[0-9a-f]{40}$/.test(p.address) && ["erc721", "erc1155"].includes(p.standard) && Number.isSafeInteger(observed.supply) && observed.supply > 0 && typeof p.name === "string" && slug(p.name), "invalid collection identity or supply");
      requireThat(p.editions.every(e => /^(0|[1-9]\d*)$/.test(e.tokenId) && Number.isSafeInteger(Number(e.tokenId)) && Number.isSafeInteger(e.max) && e.max > 0) && new Set(p.editions.map(e => e.tokenId)).size === p.editions.length, "invalid edition identity or supply");
      const previous = next.observed[p.address];
      const currentIds = new Map(observed.editions);
      if (previous) requireThat(previous.standard === observed.standard && observed.supply >= previous.supply && previous.editions.every(([id, cap]) => currentIds.has(id) && currentIds.get(id) >= cap), "supply decreased or editions disappeared; existing setup preserved");
      const addedEdition = previous && observed.editions.some(([id]) => !previous.editions.some(([old]) => id === old));
      const split = !projectIds.has(p.address) && [...projectIds.keys()].some(id => id.startsWith(p.address + ":"));
      const units = split ? p.editions.map(e => ({ id: `${p.address}:${e.tokenId}`, supply: e.max, fields: e.reporting, name: `Art Card ${e.reporting?.name || e.tokenId}` })) : [{ id: p.address, supply: observed.supply, fields: p.standard === "erc1155" ? null : p.reporting, name: p.name }];
      const source = collectionFromProject(p).collectionUrl;
      for (const unit of units) {
        const existing = projectIds.get(unit.id);
        if (!existing) {
          requireThat(!p.hasAuctions, "new auction reporting requires a verified phase rule");
          const schedules = unit.fields ? [schedule(unit.fields)] : p.editions.map(e => schedule(e.reporting));
          const launch = Math.min(...schedules.flat().filter(n => typeof n === "number" && n > 0));
          requireThat(Number.isFinite(launch) && !projectSlugs.has(slug(unit.name)) && !newProjects.some(x => slug(x.name) === slug(unit.name)), "missing launch or duplicate project name");
          requireThat(pr <= 200, "Project Setup reached its 200-row formula limit");
          requireThat(g.cell("Project Totals", pr - 8, 0).userEnteredValue?.formulaValue?.includes(`J${pr}`), "new project has no prepared totals formulas");
          requireThat(g.row("Project Totals", pr - 8, 22).every(c => c.userEnteredValue?.formulaValue), "new project totals formulas are incomplete");
          const status = (now.getTime() / 86400000 + 25569) < launch ? "Upcoming" : "Active";
          const group = split ? [...projectIds].find(([id]) => id.startsWith(p.address + ":"))[1].values[2] : "Main";
          requireThat(["Main", "Secondary"].includes(group), "project group requires review");
          for (const [col, selected] of [[2, group], [3, status]]) requireThat(g.cell(PROJECT, pr, col).dataValidation?.condition?.values?.some(v => v.userEnteredValue === selected), "new project is missing prepared dropdown validation");
          const data = [unit.name, p.artist === "Unknown" ? "Artist unlisted" : p.artist, group, status, unit.supply, launch, "", "", `Added by bot from ${source}; published launch and phase schedule.`, unit.id, p.standard];
          for (let col = 0; col < data.length; col++) change(pending, PROJECT, pr, col, data[col]);
          newProjects.push({ id: unit.id, row: pr++, name: unit.name, values: data });
          if (status === "Upcoming") upcoming[unit.id] = launch;
        } else {
          requireThat(existing.values[10] === p.standard, "reporting token standard conflicts with the catalog");
          const beforeSupply = split ? previous?.editions.find(([id]) => `${p.address}:${id}` === unit.id)?.[1] : previous?.supply;
          if (existing.values[4] !== unit.supply) {
            requireThat(previous && p.standard === "erc1155" && existing.values[4] === beforeSupply && !existing.cells[4].userEnteredValue?.formulaValue, "supply differs from the reviewed baseline; manual supply preserved");
            requireThat(existing.values[3] !== "Completed" || addedEdition, "completed collection expanded without a new edition; status review required");
            change(pending, PROJECT, existing.row, 4, unit.supply);
          }
          const reactivate = addedEdition && !split && existing.values[3] === "Completed";
          const launched = existing.values[3] === "Upcoming" && next.upcoming[unit.id] === existing.values[5] && now.getTime() / 86400000 + 25569 >= existing.values[5];
          if (reactivate || launched) {
            requireThat(!existing.cells[3].userEnteredValue?.formulaValue, "reporting status is formula-owned; formula preserved for review");
            change(pending, PROJECT, existing.row, 3, "Active");
          }
        }
      }
      const phaseUnits = p.standard === "erc1155" ? p.editions.map(e => ({ id: `${p.address}:${e.tokenId}`, token: Number(e.tokenId), fields: e.reporting })) : [{ id: p.address, token: "All", fields: p.reporting }];
      const priorRules = phases.filter(r => String(r.values[0]).startsWith(p.address + ":"));
      const special = priorRules.filter(r => r.values[7]);
      for (const unit of phaseUnits) if (!phaseIds.has(unit.id)) {
        requireThat(!p.hasAuctions, "missing auction phase rule requires review");
        requireThat(!special.length || priorRules.every(r => r.values[7] === "Curator delivery"), "mixed or unsupported special phases require review");
        const inherited = special.length ? "Curator delivery" : "";
        const times = inherited ? ["", "", ""] : schedule(unit.fields);
        requireThat(phr <= 500, "Phase Rules reached its 500-row formula limit");
        const data = [unit.id, projectIds.get(p.address)?.values[0] || p.name, unit.token, ...times, "", inherited, source, inherited ? "Inherits the collection's existing curator-delivery reporting rule." : "Published 8NAP schedule; existing phase rules are never overwritten."];
        data.forEach((v, col) => change(pending, PHASE, phr, col, v));
        newPhases.push(unit.id); phr++;
      }
      for (const e of p.editions) {
        const id = `${p.address}:${e.tokenId}`, existing = artworkIds.get(id);
        if (existing) {
          if (existing.values[4] !== e.max) {
            requireThat(previous?.editions.some(([token, cap]) => token === e.tokenId && cap === existing.values[4]) && !existing.cells[4].userEnteredValue?.formulaValue, `edition ${e.tokenId} supply differs from its reviewed baseline`);
            change(pending, ART, existing.row, 4, e.max);
          }
          continue;
        }
        const metadata = titleAndArtist(e, p);
        requireThat(ar <= 500, "Artwork Setup reached its 500-row formula limit");
        for (const col of [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23]) requireThat(Boolean(g.cell(ART, ar, col).userEnteredValue?.formulaValue), `edition row ${ar} is missing prepared formulas`);
        requireThat(g.cell(ART, ar, 10).userEnteredValue.formulaValue === artworkKeyFormula(ar), `edition row ${ar} has an unrecognized artwork-key formula; review required`);
        const series = SERIES[p.address] || "Other collection";
        const data = [series, Number(e.tokenId), metadata.artist, metadata.title, e.max, "", "", source, "Published collection metadata; unknown individual artist is left unlisted. Existing allocation rules apply."];
        data.forEach((v, col) => change(pending, ART, ar, col, v, col === 0 && series === "Other collection" ? { validation: { condition: { type: "ONE_OF_LIST", values: ["Editions", "1/1 series", "Other collection"].map(userEnteredValue => ({ userEnteredValue })) }, strict: true, showCustomUi: true } } : {}));
        if (series === "Other collection") change(pending, ART, ar, 9, p.address);
        newArtworks.push(id); ar++;
      }
      changes.push(...pending); projectRow = pr; artRow = ar; phaseRow = phr;
      newProjects.forEach(x => { projectIds.set(x.id, { row: x.row, values: x.values }); projectSlugs.add(slug(x.name)); });
      newPhases.forEach(id => phaseIds.add(id)); newArtworks.forEach(id => artworkIds.set(id, {}));
      next.observed[p.address] = observed;
      next.upcoming = upcoming;
      if (pending.length) summaries.push({ id: p.address, name: p.name, source, text: `${newProjects.length} projects, ${newArtworks.length} editions, ${newPhases.length} phase rules; ${pending.length} cells updated` });
    } catch (error) { needsReview.push(`${p.name}: ${error.message}`); }
  }
  // Expand existing project pickers without changing their selected values or
  // removing any manually maintained choices. Project View already uses a range.
  const names = [...projectIds.values()].map(r => r.values[0]);
  const beforePickers = changes.length;
  for (const [sheet, row, col] of [["Mint Adjustments", 3, 11], ...Array.from({ length: 99 }, (_, i) => ["Wallet Rules", i + 2, 3])]) {
    const cell = g.cell(sheet, row, col), rule = cell.dataValidation;
    requireThat(rule?.condition?.type === "ONE_OF_LIST" && rule.condition.values.some(v => v.userEnteredValue === "All projects"), `${sheet} project picker changed; reporting setup preserved`);
    const missing = names.filter(name => !rule.condition.values.some(v => v.userEnteredValue === name));
    if (missing.length) change(changes, sheet, row, col, scalar(cell), { validationOnly: true, validation: { ...rule, condition: { ...rule.condition, values: [...rule.condition.values, ...missing.map(userEnteredValue => ({ userEnteredValue }))] } } });
  }
  if (changes.length > beforePickers) summaries.push({ id: "project-pickers", name: "Project selectors", source: "Project Setup", text: `Added missing project choices to ${changes.length - beforePickers} selectors; selections preserved` });
  return { changes, summaries, needsReview, next };
}

const matches = (g, c, after) => (c.validationOnly || equal(entered(g.cell(c.sheet, c.row, c.col)), after ? c.after : c.before)) && (!c.validation || equal(g.cell(c.sheet, c.row, c.col).dataValidation || {}, after ? c.validation : c.beforeValidation));

function updateRequest(g, c) {
  const sheetId = g.sheets.get(c.sheet)?.sheetId;
  requireThat(Number.isInteger(sheetId), "Reporting target sheet disappeared");
  return { updateCells: { start: { sheetId, rowIndex: c.row - 1, columnIndex: c.col }, rows: [{ values: [{ ...(c.validationOnly ? {} : { userEnteredValue: c.after }), ...(c.validation ? { dataValidation: c.validation } : {}) }] }], fields: c.validationOnly ? "dataValidation" : c.validation ? "userEnteredValue,dataValidation" : "userEnteredValue" } };
}

async function syncReportingSetup({ client, snapshot, stateFile, dryRun = true, now = new Date() }) {
  let state = readJson(stateFile, { version: 1, spreadsheetId: client.spreadsheetId });
  requireThat(state.version === 1 && state.spreadsheetId === client.spreadsheetId, "Reporting setup journal belongs to another workbook or schema");
  let resource = await readSetup(client), g = grid(resource);
  if (state.pending) {
    const p = state.pending;
    requireThat(p.spreadsheetId === client.spreadsheetId && Array.isArray(p.changes), "Invalid pending reporting write; journal preserved");
    const applied = p.changes.every(c => matches(g, c, true));
    const untouched = p.changes.every(c => matches(g, c, false));
    requireThat(applied || untouched, "Reporting setup changed during an interrupted write; review required");
    if (dryRun) return { mode: "dry-run", needsReview: ["Pending reporting write requires applied readback recovery"], changes: 0 };
    state = applied ? p.next : { ...state, pending: null };
    writeJson(stateFile, state);
  }
  if (!Array.isArray(snapshot?.reportingCatalog) || !snapshot.reportingCatalog.length || !Number.isFinite(Date.parse(snapshot.lastScan)) || now.getTime() - Date.parse(snapshot.lastScan) > 36 * 3600000 || Date.parse(snapshot.lastScan) > now.getTime()) return { needsReview: ["Reporting setup is awaiting a fresh successful collection scan"], changes: 0 };
  const plan = planSetup({ resource, catalog: snapshot.reportingCatalog, state, now });
  const result = { mode: dryRun ? "dry-run" : "apply", changes: plan.changes.length, projects: plan.summaries, needsReview: plan.needsReview };
  if (dryRun) return result;
  if (!plan.changes.length) { writeJson(stateFile, plan.next); return result; }
  requireThat(plan.summaries.length <= 25 && plan.changes.length <= 1500, "Reporting setup exceeds its per-run safety budget");
  const requests = [];
  if (!g.sheets.has(LOG)) {
    let sheetId = 900101; while (resource.allSheetIds.includes(sheetId)) sheetId++;
    requests.push({ addSheet: { properties: { sheetId, title: LOG, gridProperties: { rowCount: 1000, columnCount: 5, frozenRowCount: 1 } } } });
    g.sheets.set(LOG, { sheetId, cells: new Map() });
    HEADERS[LOG].forEach((v, col) => plan.changes.push({ sheet: LOG, row: 1, col, before: {}, after: value(v) }));
  }
  let logRow = 2;
  for (let row = 2; row <= 1000; row++) if (g.row(LOG, row, 5).some(c => Object.keys(entered(c)).length)) logRow = row + 1;
  const id = crypto.createHash("sha256").update(JSON.stringify(plan.changes)).digest("hex");
  for (const item of plan.summaries) {
    requireThat(logRow <= 1000, "Setup Log reached its 1000-row capacity");
    [id, now.toISOString(), item.id, item.text, item.source].forEach((v, col) => plan.changes.push({ sheet: LOG, row: logRow, col, before: {}, after: value(v) })); logRow++;
  }
  // Re-read immediately before the atomic write. This remains a single-writer
  // workflow; Sheets has no conditional compare-and-swap for arbitrary cells.
  const freshResource = await readSetup(client), fresh = grid(freshResource);
  requireThat(plan.changes.every(c => matches(fresh, c, false)), "Reporting setup changed during planning; retry required");
  const replanned = planSetup({ resource: freshResource, catalog: snapshot.reportingCatalog, state, now });
  requireThat(equal(replanned.changes, plan.changes.filter(c => c.sheet !== LOG)) && equal(replanned.next, plan.next), "Reporting formulas or metadata changed during planning; retry required");
  plan.next.pending = null;
  writeJson(stateFile, { ...state, pending: { spreadsheetId: client.spreadsheetId, changes: plan.changes, next: plan.next } });
  requests.push(...plan.changes.map(c => updateRequest(g, c)));
  await client.request(":batchUpdate", { requests });
  const after = grid(await readSetup(client));
  requireThat(plan.changes.every(c => matches(after, c, true)), "Reporting setup verification failed; journal preserved");
  writeJson(stateFile, plan.next);
  return result;
}

module.exports = { HEADERS, ART_HEADERS, grid, readSetup, schedule, planSetup, syncReportingSetup };
