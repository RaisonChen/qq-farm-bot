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
      // 去重：完全相同的 {code, gid, openid} 组合不重复入列。
      // 抓包脚本可能因 request/response/websocket 三个钩子各命中一次而回传 3 条重复数据。
      const duplicate = this.codes.some(
        (item) => item.code === code && item.gid === gid && item.openid === openid,
      );
      if (!duplicate) {
        this.codes.push({ code, gid, openid });
        this.status = code ? "captured" : this.status;
        changed = true;
      }
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
  constructor({
    portPool = [],
    autoStopSec = 0,
    publicHost = "127.0.0.1",
    persistDir = "",
    codeGraceMs = 60_000,
    maxHoldSec = 0,
    queueTtlSec = 0,
    onForceRelease = null,
  } = {}) {
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
    // ---- 端口排队 ----
    // 单会话最长占用端口毫秒数；<=0 表示不限制（超时强制释放关闭）。
    this.maxHoldMs = maxHoldSec > 0 ? maxHoldSec * 1000 : 0;
    // 排队者存活超时毫秒数；<=0 表示不剔除幽灵排队。
    this.queueTtlMs = queueTtlSec > 0 ? queueTtlSec * 1000 : 0;
    // 强制释放回调：(sessionId, port) => void，由 server.js 注入用于 kill mitm。
    this.onForceRelease = typeof onForceRelease === "function" ? onForceRelease : null;
    // 当前持有端口的会话：sessionId -> { port, acquiredAt, timer }
    this.holders = new Map();
    // FIFO 排队队列：[{ sessionId, enqueuedAt, lastSeenAt }]
    this.waitQueue = [];
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
    // 会话销毁时同步清理排队/占用记录，避免留下幽灵。端口回收仍由调用方（stop/DELETE
    // 的 scheduleStop 回调）负责，这里只清空 hold 计时器，防止超时回调对已释放端口重复操作。
    this.clearHoldTimer(id);
    this.holders.delete(id);
    this.removeFromQueue(id);
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

  // 剔除超过存活超时未轮询的幽灵排队者（关页/断网），避免阻塞后面的人。
  pruneQueue() {
    if (this.queueTtlMs <= 0 || !this.waitQueue.length) return;
    const now = Date.now();
    this.waitQueue = this.waitQueue.filter((item) => now - item.lastSeenAt <= this.queueTtlMs);
  }

  // 会话是否已持有端口。
  holdsPort(sessionId) {
    return this.holders.has(String(sessionId || "").trim());
  }

  // 当前会话占用端口的剩余秒数（未持有或不限时返回 0）。
  holdRemainingSec(sessionId) {
    if (this.maxHoldMs <= 0) return 0;
    const holder = this.holders.get(String(sessionId || "").trim());
    if (!holder) return 0;
    const remain = holder.acquiredAt + this.maxHoldMs - Date.now();
    return remain > 0 ? Math.ceil(remain / 1000) : 0;
  }

  // 记录持有并启动最长占用计时器；到时强制释放端口 + 回调 kill mitm + 递补队首。
  startHold(id, port) {
    this.clearHoldTimer(id);
    let timer = null;
    if (this.maxHoldMs > 0) {
      timer = setTimeout(() => {
        // 超时：先回调让 server 停 mitm，再回收端口。releasePort 内部会 promote 队首。
        if (this.onForceRelease) {
          try {
            this.onForceRelease(id, port);
          } catch {}
        }
        this.releasePort(port, id);
        // 占用超时但尚未抓到 code 的会话：自动重新排到队尾，让前端无需关页即可继续等待，
        // 轮到时再次自动启动。已抓到 code 的会话视为完成，不再排队。
        const session = this.sessions.get(id);
        if (session && !session.hasCode()) {
          this.enqueue(id);
        }
      }, this.maxHoldMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    this.holders.set(id, { port, acquiredAt: Date.now(), timer });
  }

  clearHoldTimer(id) {
    const holder = this.holders.get(id);
    if (holder && holder.timer) clearTimeout(holder.timer);
  }

  // 申请端口。返回：
  //   { port }                              → 分配成功（并开始占用计时）。
  //   { queued: true, position, queueLength } → 端口忙，已入队（或刷新队列存活时间）。
  // 规则：仅当调用者位于队首（或队列为空）且有空闲端口时才分配，保证 FIFO。
  acquirePort(sessionId) {
    const id = String(sessionId || "").trim();
    // 已持有端口：幂等返回原端口（重复轮询不重复占用）。
    if (id && this.holders.has(id)) {
      return { port: this.holders.get(id).port };
    }
    this.pruneQueue();
    const head = this.waitQueue[0];
    const isHeadOrEmpty = !head || head.sessionId === id;
    if (this.availablePorts.length && isHeadOrEmpty) {
      // 轮到我了：出队（如果在队列里）并分配端口。
      if (head && head.sessionId === id) this.waitQueue.shift();
      const port = this.availablePorts.shift();
      if (id) this.startHold(id, port);
      return { port };
    }
    // 拿不到端口 → 入队（已在队列则刷新存活时间）。
    return this.enqueue(id);
  }

  // 将会话加入排队（或刷新其存活时间），返回排队信息。
  enqueue(sessionId) {
    const id = String(sessionId || "").trim();
    this.pruneQueue();
    const now = Date.now();
    let entry = this.waitQueue.find((item) => item.sessionId === id);
    if (entry) {
      entry.lastSeenAt = now;
    } else if (id) {
      entry = { sessionId: id, enqueuedAt: now, lastSeenAt: now };
      this.waitQueue.push(entry);
    }
    const position = id ? this.waitQueue.findIndex((item) => item.sessionId === id) + 1 : 0;
    return { queued: true, position, queueLength: this.waitQueue.length };
  }

  // 排队者心跳：轮询时刷新存活时间并返回最新排队信息（不占用端口）。
  refreshQueue(sessionId) {
    const id = String(sessionId || "").trim();
    this.pruneQueue();
    const idx = this.waitQueue.findIndex((item) => item.sessionId === id);
    if (idx < 0) return null;
    this.waitQueue[idx].lastSeenAt = Date.now();
    return { queued: true, position: idx + 1, queueLength: this.waitQueue.length };
  }

  removeFromQueue(sessionId) {
    const id = String(sessionId || "").trim();
    const before = this.waitQueue.length;
    this.waitQueue = this.waitQueue.filter((item) => item.sessionId !== id);
    return this.waitQueue.length !== before;
  }

  // 当前排队人数（供健康检查/展示）。
  get queueLength() {
    this.pruneQueue();
    return this.waitQueue.length;
  }

  releasePort(port, sessionId) {
    const id = String(sessionId || "").trim();
    if (id) {
      this.clearHoldTimer(id);
      this.holders.delete(id);
    } else {
      // 未指定会话时，按端口反查并清理持有记录。
      for (const [holderId, holder] of this.holders.entries()) {
        if (holder.port === Number(port)) {
          if (holder.timer) clearTimeout(holder.timer);
          this.holders.delete(holderId);
          break;
        }
      }
    }
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
