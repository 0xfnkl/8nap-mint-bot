"use strict";

const fs = require("fs");
const path = require("path");

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`Cannot read automation state: ${path.basename(file)}`); }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function localSchedule(now, timeZone, hour) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("Daily job hour must be 0–23");
  // B.C. adopted permanent UTC−7 on 8 March 2026. This also protects deployments with older ICU timezone data.
  // https://news.gov.bc.ca/releases/2026AG0013-000209
  const zone = timeZone === "America/Vancouver" && now.getTime() >= Date.parse("2026-03-08T10:00:00Z") ? "Etc/GMT+7" : timeZone;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, due: Number(parts.hour) >= hour };
}

function createDailyJob({ name, file, timeZone, hour, run, alert, now = () => new Date(), retryMs = 15 * 60 * 1000, log = console.log }) {
  localSchedule(now(), timeZone, hour);
  let inFlight = false;
  return {
    name,
    status() { return readJson(file, {}); },
    async tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const current = now(), schedule = localSchedule(current, timeZone, hour), state = readJson(file, {});
        const priorDay = new Date(Date.parse(`${schedule.day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
        const slot = schedule.due ? schedule.day : priorDay;
        const missed = state.lastCompletedDay && state.lastCompletedDay < slot;
        // Older state files can contain a first attempt without a completion marker.
        const unfinished = Boolean(state.unfinishedSlot || (!state.lastCompletedDay && state.lastAttempt));
        if ((!schedule.due && !missed && !state.lastError && !unfinished) || state.lastCompletedDay === slot || (state.nextAttempt && current.getTime() < state.nextAttempt)) return;
        // Persist before running: a process interruption must remain recoverable even
        // when the job has never succeeded or thrown. Recovery coalesces to the latest due slot.
        writeJson(file, { ...state, lastAttempt: current.toISOString(), unfinishedSlot: slot });
        try {
          const result = await run(current);
          writeJson(file, { ...state, lastAttempt: current.toISOString(), lastSuccess: now().toISOString(), lastCompletedDay: slot, unfinishedSlot: null, lastError: null, nextAttempt: 0, result });
          log(`[automation:${name}] completed ${JSON.stringify(result)}`);
          const review = result.needsReview || [];
          if (review.length && JSON.stringify(review) !== JSON.stringify(state.notifiedReview || []) && alert) {
            try {
              await alert(`${name} completed with items needing review:\n${review.join("\n")}`);
              writeJson(file, { ...readJson(file, {}), notifiedReview: review });
            } catch { log(`[automation:${name}] review alert could not be delivered; details remain in /status`); }
          } else if (!review.length && state.notifiedReview?.length) {
            writeJson(file, { ...readJson(file, {}), notifiedReview: [] });
          }
        } catch (error) {
          // Messages are deliberately generic at network/auth boundaries; never persist tokens or keys.
          writeJson(file, { ...state, lastAttempt: current.toISOString(), unfinishedSlot: slot, lastError: error.message, nextAttempt: current.getTime() + retryMs });
          log(`[automation:${name}] failed: ${error.message}`);
          if (!state.lastAlert || current.getTime() - Date.parse(state.lastAlert) >= 6 * 60 * 60 * 1000) {
            if (alert) {
              try {
                await alert(`${name}: ${error.message}. The job will retry; last successful run: ${state.lastSuccess || "none"}.`);
                const latest = readJson(file, {}); writeJson(file, { ...latest, lastAlert: current.toISOString() });
              } catch { log(`[automation:${name}] failure alert could not be delivered`); }
            }
          }
        }
      } finally { inFlight = false; }
    },
  };
}

module.exports = { readJson, writeJson, localSchedule, createDailyJob };
