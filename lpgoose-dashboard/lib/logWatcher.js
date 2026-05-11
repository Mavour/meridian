import fs from "fs";
import path from "path";
import { parseLogLine } from "./logParser.js";

/**
 * Robust log tail using polling.
 * More reliable than chokidar for append-only log files.
 */
export function createLogWatcher(broadcastFn) {
  const MERIDIAN_PATH = process.env.MERIDIAN_PATH || ".";
  const getTodayFile = () =>
    path.join(MERIDIAN_PATH, "logs", `agent-${new Date().toISOString().split("T")[0]}.log`);

  let currentFile = getTodayFile();
  let lastSize = 0;
  let leftover = "";

  // Check every second
  const interval = setInterval(() => {
    const todayFile = getTodayFile();

    // Day rollover
    if (todayFile !== currentFile) {
      currentFile = todayFile;
      lastSize = 0;
      leftover = "";
    }

    if (!fs.existsSync(currentFile)) return;

    const stats = fs.statSync(currentFile);
    if (stats.size <= lastSize) return;

    const stream = fs.createReadStream(currentFile, {
      start: lastSize,
      encoding: "utf8",
    });

    let chunkLeftover = leftover;
    stream.on("data", (chunk) => {
      const lines = (chunkLeftover + chunk).split("\n");
      chunkLeftover = lines.pop(); // incomplete line
      for (const line of lines) {
        const parsed = parseLogLine(line);
        if (parsed) broadcastFn({ type: "log", data: parsed });
      }
    });

    stream.on("end", () => {
      leftover = chunkLeftover;
      lastSize = stats.size;
    });

    stream.on("error", () => {
      // ignore read errors
    });
  }, 1000);

  return {
    stop: () => clearInterval(interval),
  };
}
