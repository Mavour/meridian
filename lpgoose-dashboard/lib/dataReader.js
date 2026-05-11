import fs from "fs";
import path from "path";

const MERIDIAN_PATH = process.env.MERIDIAN_PATH || ".";

function readJson(file) {
  const fp = path.join(MERIDIAN_PATH, file);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

function readJsonLines(file) {
  const fp = path.join(MERIDIAN_PATH, file);
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function readState() {
  return readJson("state.json") || { positions: {} };
}

export function readLessons() {
  return readJson("lessons.json") || { lessons: [] };
}

export function readWaves() {
  return readJson("wave-history.json") || { waves: {} };
}

export function readPoolMemory() {
  return readJson("pool-memory.json") || { pools: {} };
}

export function readUserConfig() {
  const c = readJson("user-config.json") || {};
  // sanitize sensitive keys
  const sensitive = [
    "rpcUrl",
    "walletKey",
    "llmApiKey",
    "hiveMindApiKey",
    "publicApiKey",
    "agentId",
    "hiveMindAgentId",
    "gmgnApiKey",
    "telegramChatId",
    "llmBaseUrl",
  ];
  const sanitized = {};
  for (const [k, v] of Object.entries(c)) {
    if (sensitive.includes(k)) {
      sanitized[k] = v ? "***" : v;
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

export function readActions(dateStr) {
  return readJsonLines(`logs/actions-${dateStr}.jsonl`);
}

export function readSnapshots(dateStr) {
  return readJsonLines(`logs/snapshots-${dateStr}.jsonl`);
}

export function getLogFilePath(dateStr) {
  return path.join(MERIDIAN_PATH, "logs", `agent-${dateStr}.log`);
}

export function getActionsFilePath(dateStr) {
  return path.join(MERIDIAN_PATH, "logs", `actions-${dateStr}.jsonl`);
}

export function listLogDates() {
  const logDir = path.join(MERIDIAN_PATH, "logs");
  if (!fs.existsSync(logDir)) return [];
  return fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith("agent-") && f.endsWith(".log"))
    .map((f) => f.replace("agent-", "").replace(".log", ""))
    .sort()
    .reverse();
}
