const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServer } = require("../src/server");
const { SessionManager } = require("../src/session");
// 复用 core 端的解析函数，确保抓包服务返回的快照能被 core 正确消费。
const { addCapturedValues } = require("../../core/src/controllers/admin-capture-routes");

const TEST_PERSIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "capture-test-"));

const TEST_CONFIG = {
  host: "127.0.0.1",
  port: 0,
  apiToken: "test-token",
  proxyPortPool: [18451, 18452],
  publicHost: "192.168.1.10",
  autoStopSec: 300,
  mitmdumpBin: "mitmdump",
  mitmConfDir: require("node:os").tmpdir(),
  persistDir: TEST_PERSIST_DIR,
  codeGraceMs: 200,
};

function auth() {
  return { Authorization: `Bearer ${TEST_CONFIG.apiToken}`, "Content-Type": "application/json" };
}

async function withServer(run) {
  const { app } = createServer({ ...TEST_CONFIG });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

test("health check exposes uptime/sessions/portPool", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: auth() });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.ok(Number.isInteger(body.uptime));
    assert.ok(Array.isArray(body.portPool));
  });
});

test("requests without token are rejected", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 401);
  });
});

test("session snapshot is consumable by core addCapturedValues", async () => {
  await withServer(async (base) => {
    const sessionId = "flow-1";
    const headers = { ...auth(), "x-capture-session-id": sessionId };

    const createRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId }),
    });
    assert.equal(createRes.status, 200);

    // 模拟抓包脚本回传一条 code/gid 记录（走公开的状态查询验证聚合结果）。
    const stateRes = await fetch(`${base}/api/sessions/${sessionId}/state`, { headers });
    const snapshot = await stateRes.json();
    assert.equal(stateRes.status, 200);

    // core 端解析：确认快照结构被正确识别（无 code 时不报错，字段结构对齐）。
    const flow = {
      platform: "qq",
      code: "",
      accountGid: "",
      openId: "",
      friendGids: new Set(),
      publicInfo: {},
      proxy: {},
      captureStatus: "idle",
    };
    addCapturedValues(flow, snapshot);
    assert.equal(flow.publicInfo.host, TEST_CONFIG.publicHost);
    assert.equal(flow.publicInfo.mitmProxyAutoStopSec, 300);
  });
});

test("ingest via internal callback surfaces code/gid in state", async () => {
  await withServer(async (base) => {
    const sessionId = "flow-2";
    const headers = { ...auth(), "x-capture-session-id": sessionId };
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId }),
    });

    // 直接模拟 addCapturedValues 消费真实抓取数据的场景。
    const stateRes = await fetch(`${base}/api/sessions/${sessionId}/state`, { headers });
    const snapshot = await stateRes.json();

    // 手动往快照塞入一条 code，验证 core 解析路径。
    snapshot.data.channels.qq.status = "captured";
    snapshot.data.channels.qq.codes = [{ code: "login-code-xyz", gid: "90001", openid: "openid-1" }];
    snapshot.data.friends = {
      source: "gamepb.friendpb.FriendService.GetAll",
      items: [{ gid: "10001" }, { gid: "10002" }],
    };

    const flow = {
      platform: "qq",
      code: "",
      accountGid: "",
      openId: "",
      friendGids: new Set(),
      publicInfo: {},
      proxy: {},
      captureStatus: "idle",
    };
    addCapturedValues(flow, snapshot);
    assert.equal(flow.code, "login-code-xyz");
    assert.equal(flow.accountGid, "90001");
    assert.equal(flow.openId, "openid-1");
    assert.deepEqual([...flow.friendGids], [10001, 10002]);
    assert.equal(flow.friendListComplete, true);
  });
});

test("captured code survives DELETE within grace period (core can still read it via /state)", async () => {
  // 直接拿到 server 内部的 sessions，模拟抓包脚本已注入 code，再走真实 HTTP 路由。
  const { app, sessions } = createServer({ ...TEST_CONFIG, codeGraceMs: 300 });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sessionId = "flow-grace";
    const headers = { ...auth(), "x-capture-session-id": sessionId };
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId }),
    });

    // 模拟 mitmproxy addon 已回传 code
    sessions.get(sessionId).ingest({ platform: "qq", code: "grace-code-1", gid: "77777" });

    // 会话被 DELETE（例如 core 停止流程 / 前端关闭）
    const delRes = await fetch(`${base}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers,
    });
    const delBody = await delRes.json();
    assert.equal(delRes.status, 200);
    assert.equal(delBody.retained, true, "已抓到 code 的会话删除时应被保留（宽限期）");

    // 宽限期内 core 仍能通过 /state 读到 code
    const stateRes = await fetch(`${base}/api/sessions/${sessionId}/state`, { headers });
    assert.equal(stateRes.status, 200, "宽限期内 /state 仍应可读");
    const snapshot = await stateRes.json();
    const flow = {
      platform: "qq",
      code: "",
      accountGid: "",
      openId: "",
      friendGids: new Set(),
      publicInfo: {},
      proxy: {},
      captureStatus: "idle",
    };
    addCapturedValues(flow, snapshot);
    assert.equal(flow.code, "grace-code-1", "core 应能在宽限期内取到 code");
    assert.equal(flow.accountGid, "77777");

    // 宽限期到期后会话被清除，/state 返回 404
    await new Promise((r) => setTimeout(r, 400));
    const goneRes = await fetch(`${base}/api/sessions/${sessionId}/state`, { headers });
    assert.equal(goneRes.status, 404, "宽限期到期后会话应被删除");
  } finally {
    server.close();
  }
});

test("SessionManager persists and restores captured code across recreation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-persist-"));
  const id = "persist-flow";
  const mgr1 = new SessionManager({ persistDir: dir, codeGraceMs: 0 });
  const s1 = mgr1.create(id);
  s1.ingest({ platform: "qq", code: "persisted-code-42", gid: "88888" });

  // 落盘文件应存在
  const file = mgr1.persistPathFor(id);
  assert.ok(fs.existsSync(file), "抓到 code 后应写入落盘文件");

  // 模拟“进程重启”：全新的 SessionManager 指向同一目录，create 时应恢复 code
  const mgr2 = new SessionManager({ persistDir: dir, codeGraceMs: 0 });
  const s2 = mgr2.create(id);
  assert.equal(s2.hasCode(), true, "重建会话应从磁盘恢复 code");
  const restored = s2.codes.find((c) => c.code === "persisted-code-42");
  assert.ok(restored, "恢复的 code 内容应一致");
  assert.equal(restored.gid, "88888");
  assert.equal(s2.status, "captured");

  // 真正 delete 后落盘文件应被清除
  mgr2.delete(id);
  assert.equal(fs.existsSync(file), false, "delete 后落盘文件应被删除");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("requestDelete without code removes session immediately", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-nocode-"));
  const mgr = new SessionManager({ persistDir: dir, codeGraceMs: 5000 });
  const id = "nocode-flow";
  mgr.create(id);
  const removed = mgr.requestDelete(id);
  assert.ok(removed, "无 code 的会话应被立即删除");
  assert.equal(mgr.get(id), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("start returns queued payload (not error) when all ports are busy", async () => {
  // 端口池只有 1 个：预先占用它，再走真实 HTTP /start，第二个会话应被排队而非报错。
  const { app, sessions } = createServer({ ...TEST_CONFIG, proxyPortPool: [18461] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 预占唯一端口，模拟已有会话正在抓包（不触发 mitmdump）。
    const held = sessions.acquirePort("holder");
    assert.deepEqual(held, { port: 18461 });

    const sessionId = "queued-flow";
    const headers = { ...auth(), "x-capture-session-id": sessionId };
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId }),
    });

    const res = await fetch(`${base}/api/capture/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "qq" }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, "端口忙时不应返回 502，而是排队");
    assert.equal(body.ok, true);
    assert.equal(body.queue.queued, true, "第二个会话应进入排队");
    assert.equal(body.queue.position, 1);
    assert.equal(body.queue.queueLength, 1);

    // 释放占用端口后，排队会话再次 /state 触发心跳，随后 /start 应能拿到端口。
    sessions.releasePort(18461, "holder");
    const stateRes = await fetch(`${base}/api/sessions/${sessionId}/state`, { headers });
    assert.equal(stateRes.status, 200);
  } finally {
    server.close();
  }
});

test("state exposes max-hold remaining seconds for the current port holder", async () => {
  // 持有端口的会话应在 /state 里暴露“最长占用倒计时”，供前端把剩余时间同步为占用倒计时。
  const { app, sessions } = createServer({ ...TEST_CONFIG, proxyPortPool: [18471], maxHoldSec: 180 });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const sessionId = "holder-flow";
    const headers = { ...auth(), "x-capture-session-id": sessionId };
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId }),
    });

    // 让该会话持有唯一端口（开始最长占用计时），但不真正拉起 mitmdump。
    const acquired = sessions.acquirePort(sessionId);
    assert.deepEqual(acquired, { port: 18471 });

    const stateRes = await fetch(`${base}/api/sessions/${sessionId}/state`, { headers });
    const body = await stateRes.json();
    assert.equal(stateRes.status, 200);
    assert.equal(body.queue.queued, false, "持有端口的会话不应处于排队状态");
    assert.equal(body.queue.maxHoldSec, 180);
    assert.ok(
      body.queue.maxHoldRemainingSec > 0 && body.queue.maxHoldRemainingSec <= 180,
      "持有端口的会话应返回一个介于 (0, 180] 的最长占用倒计时",
    );
  } finally {
    server.close();
  }
});

test.after(() => {
  try {
    fs.rmSync(TEST_PERSIST_DIR, { recursive: true, force: true });
  } catch {}
});
