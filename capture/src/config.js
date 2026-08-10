const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 8450;
// 服务监听地址。默认 0.0.0.0=监听所有网卡，外部（穿透/局域网）可连；
// 绑具体 IP 只监听那一张网卡，若该 IP 在当前环境不存在会导致启动失败（EADDRNOTAVAIL）。
const DEFAULT_HOST = "192.168.5.132";
// mitmdump 子进程抓到 code 后回传给 capture 父进程的地址。二者是同机父子进程，
// 默认走本机环回最稳；一般不需要改，除非 capture 与 mitmdump 不在同一台机器。
const DEFAULT_CALLBACK_HOST = "192.168.5.132";
// 兜底的对外可达主机名（未显式配置 CAPTURE_PUBLIC_HOST 且无法自动探测时使用）。
const DEFAULT_PUBLIC_HOST = "192.168.5.132";
// mitmproxy 代理监听端口池，core 会把其中一个端口通过 publicInfo.mitmPort 透传给前端。
const DEFAULT_PROXY_PORT_POOL = [8451];
// 抓取代理无操作后自动停止的秒数，前端会据此显示倒计时。
const DEFAULT_AUTO_STOP_SEC = 300;
// 已抓到 code 的会话被删除后保留内存态/落盘的宽限期（毫秒），给 core 最后一次读取机会。
const DEFAULT_CODE_GRACE_MS = 60_000;
// 收到 stop/DELETE 后延迟真正 kill mitmdump 的网络宽限期（毫秒）。
// 宽限期内代理仍在跑，手机在途流量可自然收尾，避免“代理提前断开导致手机断网”。
const DEFAULT_PROXY_GRACE_MS = 1_000;

const DATA_DIR = path.join(__dirname, "..", "data");
const TOKEN_FILE = path.join(DATA_DIR, "api-token.txt");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// API Token 优先取环境变量；否则读取/生成本地持久化 token，避免每次重启后 core 端配置失效。
function resolveApiToken() {
  const fromEnv = String(process.env.CAPTURE_API_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  ensureDataDir();
  try {
    const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved) return saved;
  } catch {}

  const generated = crypto.randomBytes(24).toString("base64url");
  try {
    fs.writeFileSync(TOKEN_FILE, generated, { mode: 0o600 });
  } catch {}
  return generated;
}

function parsePortPool(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return [...fallback];
  const ports = raw
    .split(/[\s,]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
  return ports.length ? ports : [...fallback];
}

// 供前端安装证书 / 配置代理时展示的对外可达主机名。
function resolvePublicHost() {
  const configured = String(process.env.CAPTURE_PUBLIC_HOST || "").trim();
  if (configured) return configured;

  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return DEFAULT_PUBLIC_HOST;
}

function loadConfig() {
  return {
    host: String(process.env.CAPTURE_HOST || DEFAULT_HOST).trim(),
    // mitmdump 抓包脚本回传给 capture 的主机名。默认本机环回，可用 CAPTURE_CALLBACK_HOST 覆盖。
    callbackHost: String(process.env.CAPTURE_CALLBACK_HOST || DEFAULT_CALLBACK_HOST).trim(),
    port: Number.parseInt(process.env.CAPTURE_PORT, 10) || DEFAULT_PORT,
    apiToken: resolveApiToken(),
    proxyPortPool: parsePortPool(process.env.CAPTURE_PROXY_PORTS, DEFAULT_PROXY_PORT_POOL),
    publicHost: resolvePublicHost(),
    autoStopSec: Number.parseInt(process.env.CAPTURE_AUTO_STOP_SEC, 10) || DEFAULT_AUTO_STOP_SEC,
    // mitmproxy 可执行文件名，Windows 上一般为 mitmdump.exe。
    mitmdumpBin: String(process.env.CAPTURE_MITMDUMP_BIN || "mitmdump").trim(),
    // mitmproxy CA 证书目录，默认 ~/.mitmproxy。
    mitmConfDir: String(process.env.CAPTURE_MITM_CONFDIR || path.join(os.homedir(), ".mitmproxy")).trim(),
    // 抓到的 code 落盘目录；默认与 DATA_DIR 相同。
    persistDir: String(process.env.CAPTURE_PERSIST_DIR || DATA_DIR).trim(),
    // 已抓到 code 的会话被删除后保留的宽限期（毫秒），给 core 最后一次读取机会。
    codeGraceMs: Number.parseInt(process.env.CAPTURE_CODE_GRACE_MS, 10) || DEFAULT_CODE_GRACE_MS,
    // 收到 stop/DELETE 后延迟真正 kill mitmdump 的网络宽限期（毫秒）。
    proxyGraceMs: Number.parseInt(process.env.CAPTURE_PROXY_GRACE_MS, 10) || DEFAULT_PROXY_GRACE_MS,
  };
}

module.exports = {
  DATA_DIR,
  DEFAULT_AUTO_STOP_SEC,
  DEFAULT_CALLBACK_HOST,
  DEFAULT_CODE_GRACE_MS,
  DEFAULT_PROXY_GRACE_MS,
  DEFAULT_PORT,
  ensureDataDir,
  loadConfig,
};
