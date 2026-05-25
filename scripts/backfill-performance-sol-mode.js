import fs from "fs";
import path from "path";

const root = process.cwd();
const lessonsPath = path.join(root, "lessons.json");
const configPath = path.join(root, "user-config.json");
const write = process.argv.includes("--write");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 4) {
  const n = num(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function estimatePnlSol(record, pnlUsd) {
  const existing = num(record.pnl_sol);
  if (existing != null) return { value: existing, estimated: false };
  const amountSol = num(record.amount_sol ?? record.initial_value_sol);
  const initialUsd = num(record.initial_value_usd);
  if (pnlUsd == null || amountSol == null || initialUsd == null || amountSol <= 0 || initialUsd <= 0) {
    return { value: null, estimated: false };
  }
  const entrySolPrice = initialUsd / amountSol;
  return entrySolPrice > 0
    ? { value: pnlUsd / entrySolPrice, estimated: true }
    : { value: null, estimated: false };
}

const cfg = readJson(configPath, {});
const solMode = cfg.solMode === true;
const data = readJson(lessonsPath, null);

if (!data || !Array.isArray(data.performance)) {
  console.error("lessons.json with performance[] not found");
  process.exit(1);
}

let changed = 0;
let estimated = 0;
let usdOnly = 0;

for (const record of data.performance) {
  const pnlUsd = num(record.pnl_true_usd ?? record.pnl_usd);
  if (pnlUsd != null && record.pnl_true_usd == null) {
    record.pnl_true_usd = round(pnlUsd, 2);
    changed++;
  }

  const pnlSol = estimatePnlSol(record, pnlUsd);
  if (pnlSol.value != null) {
    if (record.pnl_sol == null) {
      record.pnl_sol = round(pnlSol.value, 4);
      record.pnl_sol_estimated = pnlSol.estimated;
      changed++;
      if (pnlSol.estimated) estimated++;
    }
  } else {
    usdOnly++;
  }

  const displayUnit = solMode && record.pnl_sol != null ? "SOL" : "USD";
  const displayValue = displayUnit === "SOL" ? num(record.pnl_sol) : pnlUsd;
  if (displayValue != null && (record.pnl_display_value == null || record.pnl_display_unit == null)) {
    record.pnl_display_value = round(displayValue, displayUnit === "SOL" ? 4 : 2);
    record.pnl_display_unit = displayUnit;
    changed++;
  }
}

console.log(JSON.stringify({
  mode: write ? "write" : "dry-run",
  performance_records: data.performance.length,
  changed_fields: changed,
  estimated_sol_records: estimated,
  usd_only_records: usdOnly,
}, null, 2));

if (write && changed > 0) {
  const backup = `${lessonsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(lessonsPath, backup);
  fs.writeFileSync(lessonsPath, JSON.stringify(data, null, 2));
  console.log(`backup=${backup}`);
}
