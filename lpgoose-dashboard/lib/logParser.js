/**
 * Parse a single log line from agent-YYYY-MM-DD.log
 * Format: [2026-05-11T05:28:28.587Z] [STATE] Wave #4 recorded for AGI-SOL
 */
export function parseLogLine(line) {
  if (!line || !line.trim()) return null;
  const match = line.match(/^\[(.+?)\]\s+\[(.+?)\]\s+(.*)$/);
  if (!match) return null;

  const [, timestamp, rawTag, message] = match;
  const tag = rawTag.toUpperCase().trim();

  const tagLevelMap = {
    ERROR: "error",
    CLOSE_ERROR: "error",
    STATE_ERROR: "error",
    WAVE_ERROR: "error",
    WARN: "warn",
    CLOSE_WARN: "warn",
    SAFETY_BLOCK: "error",
    CLOSE: "info",
    DEPLOY: "info",
    CLAIM: "info",
    SWAP: "info",
    SCREENING: "info",
    AGENT: "info",
    STATE: "info",
    CRON: "debug",
    MANAGE: "debug",
    POLITICAL_DEBUG: "debug",
    DEBUG: "debug",
  };

  return {
    timestamp,
    tag,
    message: message.trim(),
    level: tagLevelMap[tag] || "info",
  };
}

export function parseLogLines(lines) {
  return lines.map(parseLogLine).filter(Boolean);
}
