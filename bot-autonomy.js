"use strict";

const path = require("path");
const { createDailyJob, localSchedule } = require("./daily-jobs");
const { SheetsClient, sheetStatePaths, syncMintSheet } = require("./sheets-sync");
const { createCollectionRegistry } = require("./collection-discovery");
const { syncReportingSetup } = require("./reporting-setup");

function settings(value, defaults, modes) {
  const options = { ...defaults, ...value };
  if (typeof options.enabled !== "boolean" || !modes.includes(options.mode)) throw new Error("Invalid enabled flag or automation mode");
  localSchedule(new Date(), options.timeZone, options.hour, options.minute);
  for (const field of ["maxRows", "maxAdditionsPerScan", "maxMintCatchupBlocks", "mintCatchupBatchesPerPoll"]) {
    if (options[field] !== undefined && (!Number.isSafeInteger(options[field]) || options[field] < 1)) throw new Error(`Invalid automation option ${field}`);
  }
  for (const field of ["autoAdd", "autoRetire"]) if (options[field] !== undefined && typeof options[field] !== "boolean") throw new Error(`Invalid automation option ${field}`);
  return options;
}

function createBotAutonomy({ config, stateDir, ledger, provider, confirmations, mintCollections, loadMintState, initializeMint, initializeSales, alert, env = process.env, log = console.log }) {
  const jobs = [], errors = [], registryFile = path.join(stateDir, "collection_registry.json");
  let registry;
  let discoveryOptions;
  try {
    discoveryOptions = settings(config.collectionDiscovery, { enabled: false, mode: "observe", autoAdd: false, autoRetire: false, timeZone: "America/Vancouver", hour: 20, minute: 0, maxAdditionsPerScan: 5, maxMintCatchupBlocks: 10000, mintCatchupBatchesPerPoll: 10 }, ["observe", "apply"]);
    registry = createCollectionRegistry({ file: registryFile, options: discoveryOptions, mintCollections, salesCollections: config.sales?.collections || [], loadMintState, provider, confirmations, initializeMint, initializeSales });
    if (registry.configurationError) errors.push(`Collection discovery paused: ${registry.configurationError}`);
    else if (discoveryOptions.enabled) jobs.push(createDailyJob({ name: "collection discovery", file: path.join(stateDir, "discovery_job.json"), timeZone: discoveryOptions.timeZone, hour: discoveryOptions.hour, minute: discoveryOptions.minute, alert, log, run: date => registry.scan(date) }));
  } catch (e) { errors.push(`Collection discovery disabled: ${e.message}`); registry = null; }
  try {
    const options = settings(config.sheetSync, { enabled: false, mode: "dry-run", timeZone: "America/Vancouver", hour: 21, minute: 0, maxRows: 12000 }, ["dry-run", "apply"]);
    if (options.enabled) {
      let credentials;
      try { credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}"); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
      const client = new SheetsClient({ spreadsheetId: options.spreadsheetId, credentials });
      const paths = sheetStatePaths(stateDir, options.spreadsheetId);
      if (options.reportingSetup !== undefined && typeof options.reportingSetup !== "boolean") throw new Error("Invalid reportingSetup option");
      jobs.push(createDailyJob({ name: "mint sheet sync", file: paths.jobFile, timeZone: options.timeZone, hour: options.hour, minute: options.minute, alert, log, run: async date => {
        const setup = options.reportingSetup ? await syncReportingSetup({ client, snapshot: registry?.status(), stateFile: path.join(stateDir, `reporting_setup-${options.spreadsheetId}.json`), dryRun: options.mode !== "apply", now: date }) : null;
        const result = await syncMintSheet({ client, records: ledger.read(), stateFile: paths.stateFile, maxRows: options.maxRows, dryRun: options.mode !== "apply", now: date });
        return setup ? { ...result, reportingSetup: setup, needsReview: [...setup.needsReview, ...result.needsReview] } : result;
      } }));
    }
  } catch (e) { errors.push(`Sheet sync disabled: ${e.message}`); }
  let timer;
  let startupAlertSent = false;
  const stateAlerts = new Map();
  return {
    mintCollections: () => registry ? registry.mintCollections() : [...mintCollections],
    salesCollections: () => registry ? registry.salesCollections() : [...(config.sales?.collections || [])],
    catchupBatches: collection => collection.discoveryCatchup ? discoveryOptions?.mintCatchupBatchesPerPoll || 1 : 1,
    status() {
      return [...errors, ...(!config.sheetSync?.enabled ? ["mint sheet sync: disabled"] : []), ...(!config.collectionDiscovery?.enabled ? ["collection discovery: disabled"] : []), ...jobs.map(job => {
        try {
          const st = job.status();
          const review = st.result?.needsReview || [];
          const mode = st.result?.mode || "awaiting schedule";
          return `${job.name} (${mode}): last success ${st.lastSuccess || "none"}; ${st.lastError ? `ERROR: ${st.lastError}` : review.length ? `REVIEW: ${review.join("; ")}` : "healthy"}`;
        }
        catch (e) { return e.message; }
      })];
    },
    async tick() {
      if (errors.length && !startupAlertSent) {
        log(`[automation] ${errors.join("; ")}`);
        try { await alert(errors.join("\n")); startupAlertSent = true; } catch { /* Retry on the next tick. */ }
      }
      for (const job of jobs) {
        try { await job.tick(); }
        catch (e) {
          log(`[automation] state/scheduler failure: ${e.message}`);
          if (!stateAlerts.has(job.name) || Date.now() - stateAlerts.get(job.name) >= 6 * 60 * 60 * 1000) {
            try { await alert(`${job.name}: ${e.message}. Existing monitoring is preserved; inspect the persistent automation state.`); stateAlerts.set(job.name, Date.now()); } catch { /* Next tick can retry the alert. */ }
          }
        }
      }
    },
    start() { if (!jobs.length && !errors.length) return; timer = setInterval(() => { this.tick().catch(e => log(`[automation] ${e.message}`)); }, 60000); this.tick().catch(e => log(`[automation] ${e.message}`)); },
    stop() { if (timer) clearInterval(timer); },
  };
}

module.exports = { createBotAutonomy, settings };
