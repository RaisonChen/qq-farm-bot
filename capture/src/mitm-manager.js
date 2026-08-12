const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { logger } = require("./logger");

// mitmproxy 抓包脚本路径（Python 插件），随包分发。
const ADDON_SCRIPT = path.join(__dirname, "..", "mitm", "capture_addon.py");

// mitmproxy 生成的 CA 证书候选文件名。前端安装的是 .cer/.pem。
const CERT_CANDIDATES = [
  "mitmproxy-ca-cert.cer",
  "mitmproxy-ca-cert.pem",
];

class MitmManager {
  constructor(config) {
    this.config = config;
    // sessionId -> { proc, port, callbackPort }
    this.proxies = new Map();
    // sessionId -> 延迟停止定时器；宽限期内代理保持运行，避免手机在途流量被突然切断。
    this.stopTimers = new Map();
    // 收到 stop/DELETE 后延迟真正 kill mitmdump 的网络宽限期（毫秒）。
    this.proxyGraceMs = Number.isFinite(config?.proxyGraceMs) ? config.proxyGraceMs : 0;
  }

  isRunning(sessionId) {
    const entry = this.proxies.get(String(sessionId || ""));
    return Boolean(entry && !entry.exited);
  }

  // 子进程异常退出时移除对应记录，避免后续启动被旧记录误判为仍在运行。
  markExited(sessionId, entry, exitError = "") {
    const id = String(sessionId || "").trim();
    entry.exited = true;
    if (exitError && !entry.exitError) entry.exitError = exitError;
    if (this.proxies.get(id) === entry) {
      this.proxies.delete(id);
      this.clearStopTimer(id);
    }
  }

  // 取消某会话挂起的延迟停止（例如同名会话被重新启动，或需要保持代理）。
  clearStopTimer(sessionId) {
    const id = String(sessionId || "").trim();
    const timer = this.stopTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.stopTimers.delete(id);
    }
  }

  // 启动一个 mitmdump 子进程。抓包脚本通过 CAPTURE_* 环境变量拿到回传地址与过滤模式。
  start({ sessionId, port, mode, bypassHosts, callbackPort, callbackToken }) {
    const id = String(sessionId || "").trim();
    // 若该会话此前进入了延迟停止宽限期，重新启动时先取消，避免刚启动就被旧定时器杀掉。
    this.clearStopTimer(id);
    if (this.proxies.has(id)) {
      throw new Error("该会话代理已在运行");
    }
    if (!fs.existsSync(ADDON_SCRIPT)) {
      throw new Error(`抓包脚本缺失：${ADDON_SCRIPT}`);
    }

    const args = [
      "-p", String(port),
      "--set", `confdir=${this.config.mitmConfDir}`,
      "-s", ADDON_SCRIPT,
      "--set", "block_global=false",
      // 安静模式：不逐条打印流经的 flow，避免刷屏淹没抓到的 code。
      // addon 命中登录字段时会用 [capture] 前缀单独醒目打印。
      "-q",
      "--set", "flow_detail=0",
      "--set", "termlog_verbosity=warn",
    ];
    for (const host of Array.isArray(bypassHosts) ? bypassHosts : []) {
      const clean = String(host || "").trim();
      if (clean) args.push("--ignore-hosts", clean);
    }

    const callbackHost = String(this.config.callbackHost || "127.0.0.1").trim() || "127.0.0.1";
    const proc = spawn(this.config.mitmdumpBin, args, {
      env: {
        ...process.env,
        CAPTURE_SESSION_ID: id,
        CAPTURE_MODE: mode === "wx" ? "wx" : "qq",
        CAPTURE_CALLBACK_URL: `http://${callbackHost}:${callbackPort}/internal/capture`,
        CAPTURE_CALLBACK_TOKEN: callbackToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // 只转发有价值的行：addon 命中登录字段的 [capture] 行，或含 error/错误的行。
    // 其余（TLS 握手提示、逐条 flow 等）一律丢弃，保持终端清爽。
    const forwardMitmLine = (raw, level) => {
      const text = String(raw || "").trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes("[capture]")) {
          logger.info("抓包命中", { sessionId: id, hit: trimmed.slice(0, 300) });
        } else if (/error|错误|failed|exception|traceback/i.test(trimmed)) {
          logger.warn("mitmdump", { sessionId: id, err: trimmed.slice(0, 300) });
        }
        // 其余噪声行忽略。
      }
    };
    proc.stdout.on("data", (chunk) => forwardMitmLine(chunk, "info"));
    proc.stderr.on("data", (chunk) => forwardMitmLine(chunk, "warn"));

    const entry = { proc, port, exited: false, exitError: "" };
    proc.on("error", (error) => {
      const exitError = error.code === "ENOENT"
        ? `未找到 mitmdump 可执行文件（${this.config.mitmdumpBin}），请先安装 mitmproxy`
        : error.message;
      this.markExited(id, entry, exitError);
      logger.error("mitmdump 启动失败", { sessionId: id, error: entry.exitError });
    });
    proc.on("exit", (code, signal) => {
      const exitError = code && code !== 0
        ? `mitmdump 退出（code=${code}${signal ? `, signal=${signal}` : ""}）`
        : "";
      this.markExited(id, entry, exitError);
      logger.info("mitmdump 退出", { sessionId: id, code, signal });
    });

    this.proxies.set(id, entry);
    return entry;
  }

  getStatus(sessionId) {
    const entry = this.proxies.get(String(sessionId || ""));
    if (!entry) return { running: false, error: "" };
    return {
      running: !entry.exited,
      error: entry.exitError || "",
      port: entry.port,
    };
  }

  stop(sessionId) {
    const id = String(sessionId || "").trim();
    // 立即停止时同样清掉可能挂起的延迟停止定时器，避免重复触发。
    this.clearStopTimer(id);
    const entry = this.proxies.get(id);
    if (!entry) return false;
    this.proxies.delete(id);
    try {
      if (!entry.exited && entry.proc && !entry.proc.killed) {
        entry.proc.kill("SIGTERM");
        // Windows 上部分子进程需要强制结束兜底。
        setTimeout(() => {
          try {
            if (!entry.proc.killed) entry.proc.kill("SIGKILL");
          } catch {}
        }, 2000).unref?.();
      }
    } catch (error) {
      logger.warn("停止 mitmdump 失败", { sessionId: id, error: error.message });
    }
    return true;
  }

  // 延迟停止：收到 stop/DELETE 后，先保持代理运行一个网络宽限期（proxyGraceMs），
  // 让手机在途流量自然收尾，到期后再平滑 kill（SIGTERM→SIGKILL 兜底），
  // 避免“代理被提前断开导致手机断网 → bot 更新超时”。
  // 宽限期 <=0 时退化为立即停止。若代理未运行则无操作。
  // onStopped 在代理真正停止时回调（无论立即停还是宽限期到期），用于延迟回收端口等资源。
  scheduleStop(sessionId, delayMs = this.proxyGraceMs, onStopped = null) {
    const id = String(sessionId || "").trim();
    if (!this.proxies.has(id)) return false;
    const grace = Number.isFinite(delayMs) ? delayMs : 0;
    const done = () => {
      if (typeof onStopped === "function") {
        try {
          onStopped();
        } catch {}
      }
    };
    if (grace <= 0) {
      const stopped = this.stop(id);
      done();
      return stopped;
    }
    // 已有挂起定时器则不重复排期，沿用最早的那次宽限期。
    if (this.stopTimers.has(id)) return true;
    logger.info("代理进入延迟停止宽限期", { sessionId: id, delayMs: grace });
    const timer = setTimeout(() => {
      this.stopTimers.delete(id);
      this.stop(id);
      done();
    }, grace);
    if (typeof timer.unref === "function") timer.unref();
    this.stopTimers.set(id, timer);
    return true;
  }

  stopAll() {
    for (const id of [...this.stopTimers.keys()]) this.clearStopTimer(id);
    for (const id of [...this.proxies.keys()]) this.stop(id);
  }

  // 返回 mitmproxy CA 证书内容（供 core 的 /cert 端点回源）。
  readCertificate() {
    for (const name of CERT_CANDIDATES) {
      const file = path.join(this.config.mitmConfDir, name);
      try {
        if (fs.existsSync(file)) return fs.readFileSync(file);
      } catch {}
    }
    return null;
  }
}

module.exports = { MitmManager, ADDON_SCRIPT };
