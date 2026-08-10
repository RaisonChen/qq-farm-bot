#!/usr/bin/env node
const crypto = require("node:crypto");

const express = require("express");

const { loadConfig, ensureDataDir, DATA_DIR } = require("./config");
const { logger } = require("./logger");
const { SessionManager } = require("./session");
const { MitmManager } = require("./mitm-manager");

const START_TIME = Date.now();
// 前端安装证书用的相对路径，core 会拼到 apiBase 后回源。
const CERT_PATH = "/cert/mitmproxy-ca-cert.cer";

function createServer(config = loadConfig()) {
  ensureDataDir();

  const sessions = new SessionManager({
    portPool: config.proxyPortPool,
    autoStopSec: config.autoStopSec,
    publicHost: config.publicHost,
    // 抓到的 code 落盘到 data/sessions/，进程重启或 mitmdump 退出也不丢。
    persistDir: config.persistDir || DATA_DIR,
    codeGraceMs: config.codeGraceMs,
  });
  const mitm = new MitmManager(config);
  // 抓包脚本回传时携带的内部令牌，防止本机其他进程伪造上报。
  const callbackToken = crypto.randomBytes(18).toString("base64url");

  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // ---- 鉴权：core 端所有请求都带 Authorization: Bearer <apiToken> ----
  function requireApiToken(req, res, next) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const expected = Buffer.from(config.apiToken, "utf8");
    const supplied = Buffer.from(token, "utf8");
    if (
      expected.length === 0
      || expected.length !== supplied.length
      || !crypto.timingSafeEqual(expected, supplied)
    ) {
      return res.status(401).json({ ok: false, error: "抓包服务鉴权失败" });
    }
    next();
  }

  function sessionIdFrom(req) {
    return String(
      req.headers["x-capture-session-id"] || req.body?.sessionId || req.params?.id || "",
    ).trim();
  }

  // 把当前 mitm 运行状态同步进会话快照。
  function syncProxyState(session) {
    const status = mitm.getStatus(session.sessionId);
    session.setProxy({
      running: status.running,
      status: status.running ? "running" : "stopped",
      error: status.error || "",
      startedAt: session.proxy.startedAt,
    });
  }

  // ---- 健康检查 ----
  app.get("/api/health", requireApiToken, (req, res) => {
    res.json({
      ok: true,
      uptime: Math.floor((Date.now() - START_TIME) / 1000),
      sessions: sessions.list().length,
      portPool: sessions.portPool,
    });
  });

  // ---- 创建会话 ----
  app.post("/api/sessions", requireApiToken, (req, res) => {
    try {
      const id = sessionIdFrom(req);
      const session = sessions.create(id);
      res.json({ ok: true, ...session.snapshot(CERT_PATH) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ---- 启动抓取代理 ----
  app.post("/api/capture/start", requireApiToken, (req, res) => {
    const id = sessionIdFrom(req);
    const session = sessions.get(id) || sessions.create(id);
    try {
      if (mitm.isRunning(id)) {
        syncProxyState(session);
        return res.json({ ok: true, ...session.snapshot(CERT_PATH) });
      }
      const port = sessions.acquirePort();
      if (!port) throw new Error("代理端口池已耗尽，请稍后重试");
      const mode = req.body?.mode === "wx" ? "wx" : "qq";
      session.platform = mode;
      session.proxyPort = port;

      try {
        mitm.start({
          sessionId: id,
          port,
          mode,
          bypassHosts: Array.isArray(req.body?.bypassHosts) ? req.body.bypassHosts : [],
          callbackPort: config.port,
          callbackToken,
        });
      } catch (error) {
        sessions.releasePort(port);
        session.proxyPort = 0;
        throw error;
      }

      session.status = "waiting";
      session.setProxy({
        running: true,
        status: "running",
        error: "",
        startedAt: new Date().toISOString(),
      });
      logger.info("抓取代理已启动", { sessionId: id, mode, port });
      res.json({ ok: true, ...session.snapshot(CERT_PATH) });
    } catch (error) {
      logger.warn("启动抓取代理失败", { sessionId: id, error: error.message });
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  // ---- 查询会话状态 ----
  app.get("/api/sessions/:id/state", requireApiToken, (req, res) => {
    const id = sessionIdFrom(req);
    const session = sessions.get(id);
    if (!session) return res.status(404).json({ ok: false, error: "会话不存在或已过期" });
    syncProxyState(session);
    res.json({ ok: true, ...session.snapshot(CERT_PATH) });
  });

  // ---- 停止抓取（保留会话） ----
  app.post("/api/capture/stop", requireApiToken, (req, res) => {
    const id = sessionIdFrom(req);
    const session = sessions.get(id);
    // 不立即 kill mitmdump：先保持代理运行一个网络宽限期，让手机在途流量自然收尾，
    // 避免“代理提前断开导致手机断网 → bot 更新超时”。到期真正停止后再回收端口。
    const port = session ? session.proxyPort : 0;
    mitm.scheduleStop(id, undefined, () => {
      if (port) sessions.releasePort(port);
    });
    if (session) {
      session.proxyPort = 0;
      session.setProxy({ running: false, status: "stopping", error: "" });
    }
    res.json({ ok: true });
  });

  // ---- 删除会话（释放代理与端口） ----
  app.delete("/api/sessions/:id", requireApiToken, (req, res) => {
    const id = sessionIdFrom(req);
    const session = sessions.get(id);
    // 代理不立即 kill：给一个网络宽限期让手机在途流量收尾，到期后再停并回收端口。
    const port = session ? session.proxyPort : 0;
    mitm.scheduleStop(id, undefined, () => {
      if (port) sessions.releasePort(port);
    });
    // 但如果已经抓到 code、可能还没被 core 成功读走，则进入宽限期而非立即抹除，
    // 避免“抓到 code 却在 core 读到前就随会话删除而丢失”。
    const removed = sessions.requestDelete(id);
    res.json({ ok: true, retained: removed ? false : (session ? session.hasCode() : false) });
  });

  // ---- CA 证书回源（core 的 /api/public/capture-certificate 会回源到这里） ----
  app.get("/cert/mitmproxy-ca-cert.cer", (req, res) => {
    const cert = mitm.readCertificate();
    if (!cert) {
      return res.status(404).json({
        ok: false,
        error: "证书未生成，请先启动一次抓取以生成 mitmproxy CA 证书",
      });
    }
    res.setHeader("Content-Type", "application/x-x509-ca-cert");
    res.setHeader("Content-Disposition", 'inline; filename="mitmproxy-ca-cert.cer"');
    res.send(cert);
  });

  // ---- 抓包脚本回传通道（仅限本机，用内部令牌校验） ----
  app.post("/internal/capture", (req, res) => {
    if (String(req.headers["x-capture-callback-token"] || "") !== callbackToken) {
      return res.status(403).json({ ok: false });
    }
    const id = String(req.body?.sessionId || "").trim();
    const session = sessions.get(id);
    if (session) session.ingest(req.body);
    // 醒目记录收到的登录字段，方便在终端确认 code 是否真的抓到。
    const code = String(req.body?.code || "").trim();
    const gid = String(req.body?.gid || "").trim();
    const openid = String(req.body?.openid || req.body?.open_id || "").trim();
    if (code || gid || openid) {
      logger.info("收到抓包回传", {
        sessionId: id,
        code: code || "(空)",
        gid: gid || "(空)",
        openid: openid || "(空)",
        known: session ? session.hasCode() : false,
      });
    }
    res.json({ ok: true });
  });

  return { app, sessions, mitm, config };
}

function start() {
  const config = loadConfig();
  const { app, mitm } = createServer(config);
  const server = app.listen(config.port, config.host, () => {
    logger.info("抓包服务已启动", {
      url: `http://${config.host}:${config.port}`,
      apiToken: config.apiToken,
      publicHost: config.publicHost,
      proxyPortPool: config.proxyPortPool,
    });
    logger.info("请在 core 后台「抓包服务配置」中填写以上 apiBase 与 apiToken 并启用");
  });

  const shutdown = () => {
    logger.info("正在关闭抓包服务…");
    mitm.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { createServer, start, CERT_PATH };
