const fs = require("node:fs");
const http = require("node:http");

function timestamp() {
  return new Date().toISOString();
}

function format(level, message, meta) {
  const base = `${timestamp()} [${level}] ${message}`;
  if (meta && Object.keys(meta).length) {
    try {
      return `${base} ${JSON.stringify(meta)}`;
    } catch {
      return base;
    }
  }
  return base;
}

// #region debug-point A-E:capture-service-events
function reportDebugEvent(level, message, meta) {
  let url = "http://127.0.0.1:7777/event";
  let sessionId = "long-run-capture";
  try {
    const env = fs.readFileSync(".dbg/long-run-capture.env", "utf8");
    url = env.match(/^DEBUG_SERVER_URL=(.+)$/m)?.[1] || url;
    sessionId = env.match(/^DEBUG_SESSION_ID=(.+)$/m)?.[1] || sessionId;
  } catch {}
  try {
    const target = new URL(url);
    const body = JSON.stringify({
      sessionId,
      runId: "pre-fix",
      hypothesisId: level === "ERROR" ? "C" : "A",
      location: "src/logger.js",
      msg: `[DEBUG] ${message}`,
      data: { level, ...(meta || {}) },
      ts: Date.now(),
    });
    const request = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } });
    request.on("error", () => {});
    request.end(body);
  } catch {}
}
// #endregion

const logger = {
  info(message, meta) {
    reportDebugEvent("INFO", message, meta);
    console.log(format("INFO", message, meta));
  },
  warn(message, meta) {
    reportDebugEvent("WARN", message, meta);
    console.warn(format("WARN", message, meta));
  },
  error(message, meta) {
    reportDebugEvent("ERROR", message, meta);
    console.error(format("ERROR", message, meta));
  },
};

module.exports = { logger };
