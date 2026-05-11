import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { getLogFilePath } from "./dataReader.js";
import { parseLogLine } from "./logParser.js";

export function createLogWatcher(broadcastFn) {
  const todayStr = () => new Date().toISOString().split("T")[0];

  let currentLogFile = getLogFilePath(todayStr());
  let lastSize = 0;

  // Watch all agent log files
  const watcher = chokidar.watch("**/logs/agent-*.log", {
    cwd: process.env.MERIDIAN_PATH || ".",
    ignoreInitial: false,
    persistent: true,
  });

  watcher.on("change", (filePath) => {
    const fullPath = filePath.startsWith("/")
      ? filePath
      : path.join(process.env.MERIDIAN_PATH || ".", filePath);

    try {
      const stats = fs.statSync(fullPath);
      if (stats.size <= lastSize && fullPath === currentLogFile) return;

      const stream = fs.createReadStream(fullPath, {
        start: fullPath === currentLogFile ? lastSize : 0,
        encoding: "utf8",
      });

      let leftover = "";
      stream.on("data", (chunk) => {
        const lines = (leftover + chunk).split("\n");
        leftover = lines.pop(); // incomplete line
        lines.forEach((line) => {
          const parsed = parseLogLine(line);
          if (parsed) broadcastFn({ type: "log", data: parsed });
        });
      });

      stream.on("end", () => {
        if (leftover.trim()) {
          const parsed = parseLogLine(leftover);
          if (parsed) broadcastFn({ type: "log", data: parsed });
        }
        if (fullPath === currentLogFile) {
          lastSize = stats.size;
        }
      });
    } catch (err) {
      // ignore file read errors
    }
  });

  // Daily rollover: update currentLogFile at midnight
  const rolloverInterval = setInterval(() => {
    const newPath = getLogFilePath(todayStr());
    if (newPath !== currentLogFile) {
      currentLogFile = newPath;
      lastSize = 0;
      watcher.add(newPath);
    }
  }, 60_000);

  return {
    stop: () => {
      clearInterval(rolloverInterval);
      watcher.close();
    },
  };
}
