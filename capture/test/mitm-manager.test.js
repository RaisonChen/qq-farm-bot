const test = require("node:test");
const assert = require("node:assert/strict");

const { MitmManager } = require("../src/mitm-manager");

// 构造一个不触发真实 spawn 的 MitmManager，并注入一个假的代理 entry，
// 用可观察的 kill 记录验证“延迟停止”的时序，而不真正拉起 mitmdump。
function managerWithFakeProxy(sessionId, { proxyGraceMs = 0 } = {}) {
  const mitm = new MitmManager({ proxyGraceMs });
  const kills = [];
  const entry = {
    port: 18999,
    exited: false,
    exitError: "",
    proc: {
      killed: false,
      kill(signal) {
        kills.push(signal);
        if (signal === "SIGKILL") this.killed = true;
      },
    },
  };
  mitm.proxies.set(String(sessionId), entry);
  return { mitm, kills, entry };
}

test("scheduleStop keeps proxy alive during grace period then kills it", async () => {
  const id = "grace-proxy";
  const { mitm, kills } = managerWithFakeProxy(id, { proxyGraceMs: 120 });
  let stoppedCalled = false;

  const scheduled = mitm.scheduleStop(id, undefined, () => {
    stoppedCalled = true;
  });
  assert.equal(scheduled, true, "存在运行中的代理时应成功排期");

  // 宽限期内：代理仍在（未从 proxies 移除），尚未发出 kill，onStopped 未触发。
  assert.equal(mitm.isRunning(id), true, "宽限期内代理应保持运行");
  assert.equal(kills.length, 0, "宽限期内不应 kill 进程");
  assert.equal(stoppedCalled, false, "宽限期内不应触发 onStopped");

  // 宽限期到期后：代理被真正停止（发出 SIGTERM），onStopped 触发。
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mitm.isRunning(id), false, "宽限期到期后代理应被停止");
  assert.ok(kills.includes("SIGTERM"), "到期后应发出 SIGTERM 平滑停止");
  assert.equal(stoppedCalled, true, "到期后应触发 onStopped 回收端口");
});

test("scheduleStop with zero grace stops immediately", () => {
  const id = "no-grace";
  const { mitm, kills } = managerWithFakeProxy(id, { proxyGraceMs: 0 });
  let stoppedCalled = false;
  mitm.scheduleStop(id, undefined, () => {
    stoppedCalled = true;
  });
  assert.equal(mitm.isRunning(id), false, "宽限期为 0 时应立即停止");
  assert.ok(kills.includes("SIGTERM"), "立即停止应发出 SIGTERM");
  assert.equal(stoppedCalled, true, "立即停止也应触发 onStopped");
});

test("clearStopTimer cancels a pending delayed stop (e.g. session recreated)", async () => {
  const id = "recreate";
  const { mitm, kills } = managerWithFakeProxy(id, { proxyGraceMs: 120 });
  let stoppedCalled = false;
  mitm.scheduleStop(id, undefined, () => {
    stoppedCalled = true;
  });

  // 模拟同名会话被重新启动：取消挂起的延迟停止。
  mitm.clearStopTimer(id);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(mitm.isRunning(id), true, "取消挂起停止后代理应仍在运行");
  assert.equal(kills.length, 0, "取消后不应 kill 进程");
  assert.equal(stoppedCalled, false, "取消后不应触发 onStopped");
});

test("start cancels a pending delayed stop for the same session", () => {
  const id = "start-cancels";
  const { mitm } = managerWithFakeProxy(id, { proxyGraceMs: 120 });
  mitm.scheduleStop(id);
  assert.equal(mitm.stopTimers.has(id), true, "排期后应存在挂起定时器");

  // start 内部会先 clearStopTimer，再因为 proxies 已存在而抛“已在运行”。
  // 这里只验证挂起定时器被清除（start 的其余逻辑由集成流程覆盖）。
  assert.throws(() => {
    mitm.start({ sessionId: id, port: 18999, mode: "qq", bypassHosts: [], callbackPort: 1, callbackToken: "t" });
  }, /已在运行/);
  assert.equal(mitm.stopTimers.has(id), false, "start 应清除同名会话的挂起延迟停止");
});

test("scheduleStop on unknown session is a no-op", () => {
  const mitm = new MitmManager({ proxyGraceMs: 120 });
  let stoppedCalled = false;
  const result = mitm.scheduleStop("nope", undefined, () => {
    stoppedCalled = true;
  });
  assert.equal(result, false, "代理未运行时应返回 false");
  assert.equal(mitm.stopTimers.has("nope"), false, "不应为不存在的会话创建定时器");
  assert.equal(stoppedCalled, false, "不存在的会话不应触发 onStopped");
});
