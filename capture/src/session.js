const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 单个抓取会话的状态。字段结构对齐 core 端 addCapturedValues() 期望读取的快照格式：
//   data.channels[platform] = { status, codes: [{ code, gid, openid }] }
//   data.friends = { source, items: [{ gid }] }
//   data.publicInfo / data.proxy
class CaptureSession {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId;
    this.platform = "qq";
    this.status = "idle";
    // 抓到的登录凭据条目，允许多条（例如先拿到 gid 再拿到 code）。
    this.codes = [];
    this.friends = new Map();
    this.friendSource = "";
    this.proxyPort = 0;
    this.proxy = { running: false, status: "idle", error: "", startedAt: "" };
    this.autoStopSec = options.autoStopSec || 0;
    this.publicHost = options.publicHost || "127.0.0.1";
    // 落盘文件路径：抓到 code 后立即持久化，进程重启 / mitmdump 退出也不丢。
    this.persistPath = options.persistPath || "";
    // 会话被请求删除但仍保留在内存（宽限期）时置 true；宽限期内 /state 仍可读。
    this.pendingDelete = false;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.lastActivityAt = Date.now();
  }

  touch() {
    this.updatedAt = Date.now();
  }

  markActivity() {
    this.lastActivityAt = Date.now();
    this.touch();
  }

  setProxy(patch) {
    this.proxy = { ...this.proxy, ...patch };
    this.touch();
  }

  hasCode() {
    return this.codes.some((item) => String(item.code || "").trim());
  }

  // 从磁盘恢复已抓到的 code（如果存在）。用于进程重启 / 会话重建时兜底。
  restore() {
    if (!this.persistPath) return false;
    let raw;
    try {
      raw = fs.readFileSync(this.persistPath, "utf8");
    } catch {
      return false;
    }
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        if (data.platform === "qq" || data.platform === "wx") this.platform = data.platform;
        if (Array.isArray(data.codes)) {
          this.codes = data.codes
            .map((item) => ({
              code: String(item?.code || "").trim(),
              gid: String(item?.gid || "").trim(),
              openid: String(item?.openid || item?.open_id || "").trim(),
            }))
            .filter((item) => item.code || item.gid || item.openid);
        }
        if (typeof data.friendSource === "string") this.friendSource = data.friendSource;
        if (Array.isArray(data.friends)) {
          for (const value of data.friends) {
            const num = Number(value);
            if (Number.isSafeInteger(num) && num > 0) this.friends.set(num, num);
          }
        }
        if (this.hasCode()) this.status = "captured";
        return true;
      }
    } catch {}
    return false;
  }

  // 把当前已抓到的凭据落盘。仅在有 code/gid/好友时写，避免制造空文件。
  persist() {
    if (!this.persistPath) return;
    if (!this.codes.length && !this.friends.size) return;
    const payload = JSON.stringify({
      sessionId: this.sessionId,
      platform: this.platform,
      codes: this.codes,
      friendSource: this.friendSource,
      friends: [...this.friends.keys()],
      updatedAt: Date.now(),
    });
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, payload);
    } catch {
      // 落盘失败不影响内存态与回传；仅牺牲重启兜底能力。
    }
  }

  // 删除落盘文件（会话真正销毁时调用）。
  discardPersisted() {
    if (!this.persistPath) return;
    try {
      fs.rmSync(this.persistPath, { force: true });
    } catch {}
  }

  // 从 mitmproxy 抓包脚本回传的一条记录中吸收数据。
  ingest(record) {
    if (!record || typeof record !== "object") return;
    if (record.platform === "qq" || record.platform === "wx") {
      this.platform = record.platform;
    }
    const code = String(record.code || "").trim();
    const gid = String(record.gid || "").trim();
    const openid = String(record.openid || record.open_id || "").trim();
    let changed = false;
    if (code || gid || openid) {
      this.codes.push({ code, gid, openid });
      this.status = code ? "captured" : this.status;
      changed = true;
    }

    const friendSource = String(record.friendSource || record.friend_source || "").trim();
    if (friendSource) {
      this.friendSource = friendSource;
      changed = true;
    }
    const friendGids = Array.isArray(record.friendGids || record.friend_gids)
      ? (record.friendGids || record.friend_gids)
      : [];
    for (const value of friendGids) {
      const num = Number(value);
      if (Number.isSafeInteger(num) && num > 0 && !this.friends.has(num)) {
        this.friends.set(num, num);
        changed = true;
      }
    }
    this.markActivity();
    // 一旦有新数据（尤其 code）立即落盘，最大限度避免“抓到却没送达”丢失。
    if (changed) this.persist();
  }

  // 生成 core 端 addCapturedValues() 消费的快照。
  snapshot(certPath) {
    return {
      data: {
        channels: {
          [this.platform]: {
            status: this.status,
            codes: this.codes.map((item) => ({
              code: item.code,
              gid: item.gid,
              openid: item.openid,
            })),
          },
        },
        friends: {
          source: this.friendSource,
          items: [...this.friends.keys()].map((gid) => ({ gid })),
        },
        publicInfo: {
          host: this.publicHost,
          mitmPort: this.proxyPort,
          certUrl: certPath,
          mitmProxyAutoStopSec: this.autoStopSec,
        },
        proxy: { ...this.proxy },
      },
    };
  }
}

class SessionManager {
  constructor({ portPool = [], autoStopSec = 0, publicHost = "127.0.0.1", persistDir = "", codeGraceMs = 60_000 } = {}) {
    this.sessions = new Map();
    this.availablePorts = [...portPool];
    this.autoStopSec = autoStopSec;
    this.publicHost = publicHost;
    // code 落盘目录；为空则不落盘（测试可关闭）。
    this.persistDir = persistDir;
    // 已抓到 code 的会话被请求删除后，保留内存态的宽限期，给 core 最后一次读取机会。
    this.codeGraceMs = codeGraceMs;
    // sessionId -> 宽限期定时器
    this.graceTimers = new Map();
  }

  // 把任意 sessionId 规整成安全的文件名，避免路径穿越 / 非法字符。
  persistPathFor(id) {
    if (!this.persistDir) return "";
    const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "session";
    return path.join(this.persistDir, "sessions", `${safe}.json`);
  }

  create(sessionId) {
    const id = String(sessionId || "").trim() || crypto.randomBytes(12).toString("base64url");
    let session = this.sessions.get(id);
    if (!session) {
      session = new CaptureSession(id, {
        autoStopSec: this.autoStopSec,
        publicHost: this.publicHost,
        persistPath: this.persistPathFor(id),
      });
      // 若磁盘上存在此前抓到的 code（进程重启 / 会话曾被删），恢复它。
      session.restore();
      this.sessions.set(id, session);
    }
    // 若之前进入了宽限期删除，重新创建同名会话时取消。
    this.clearGraceTimer(id);
    session.pendingDelete = false;
    return session;
  }

  get(sessionId) {
    return this.sessions.get(String(sessionId || "").trim()) || null;
  }

  clearGraceTimer(id) {
    const timer = this.graceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(id);
    }
  }

  // 立即彻底删除会话并清除落盘。
  delete(sessionId) {
    const id = String(sessionId || "").trim();
    const session = this.sessions.get(id);
    this.clearGraceTimer(id);
    if (session) {
      session.discardPersisted();
      this.sessions.delete(id);
    }
    return session;
  }

  // 请求删除会话：
  //   - 若尚未抓到 code：立即删除（无可挽救内容）。
  //   - 若已抓到 code：进入宽限期，保留内存态与落盘 codeGraceMs，
  //     期间 /state 仍能返回 code，给 core 补读；到期后再真正删除。
  // 返回被立即删除的 session（若进入宽限期则返回 null 表示未真正删）。
  requestDelete(sessionId) {
    const id = String(sessionId || "").trim();
    const session = this.sessions.get(id);
    if (!session) return null;
    if (!session.hasCode() || this.codeGraceMs <= 0) {
      return this.delete(id);
    }
    session.pendingDelete = true;
    session.touch();
    this.clearGraceTimer(id);
    const timer = setTimeout(() => {
      this.graceTimers.delete(id);
      const current = this.sessions.get(id);
      if (current && current.pendingDelete) {
        current.discardPersisted();
        this.sessions.delete(id);
      }
    }, this.codeGraceMs);
    if (typeof timer.unref === "function") timer.unref();
    this.graceTimers.set(id, timer);
    return null;
  }

  list() {
    return [...this.sessions.values()];
  }

  acquirePort() {
    return this.availablePorts.shift() || 0;
  }

  releasePort(port) {
    const num = Number(port);
    if (Number.isInteger(num) && num > 0 && !this.availablePorts.includes(num)) {
      this.availablePorts.push(num);
    }
  }

  get portPool() {
    return [...this.availablePorts];
  }
}

module.exports = { CaptureSession, SessionManager };
