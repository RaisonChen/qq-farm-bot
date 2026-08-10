const test = require("node:test");
const assert = require("node:assert/strict");

const { SessionManager } = require("../src/session");

// 端口排队：FIFO 分配、释放递补、占用超时强制释放、幽灵排队剔除。

test("acquirePort assigns the only port and queues the rest in FIFO order", () => {
  const mgr = new SessionManager({ portPool: [18451] });
  mgr.create("a");
  mgr.create("b");
  mgr.create("c");

  assert.deepEqual(mgr.acquirePort("a"), { port: 18451 });
  assert.deepEqual(mgr.acquirePort("b"), { queued: true, position: 1, queueLength: 1 });
  assert.deepEqual(mgr.acquirePort("c"), { queued: true, position: 2, queueLength: 2 });
  assert.equal(mgr.queueLength, 2);
});

test("acquirePort is idempotent for the current holder", () => {
  const mgr = new SessionManager({ portPool: [18451] });
  assert.deepEqual(mgr.acquirePort("a"), { port: 18451 });
  // 重复轮询不重复占用，返回同一端口。
  assert.deepEqual(mgr.acquirePort("a"), { port: 18451 });
  assert.equal(mgr.queueLength, 0);
});

test("releasing a port promotes the queue head only", () => {
  const mgr = new SessionManager({ portPool: [18451] });
  mgr.acquirePort("a");
  mgr.acquirePort("b");
  mgr.acquirePort("c");

  mgr.releasePort(18451, "a");
  // 队首 b 递补拿到端口；c 仍在排队且名次前移到 1。
  assert.deepEqual(mgr.acquirePort("b"), { port: 18451 });
  assert.deepEqual(mgr.acquirePort("c"), { queued: true, position: 1, queueLength: 1 });
});

test("a non-head session cannot jump the queue even if a port is free", () => {
  const mgr = new SessionManager({ portPool: [18451] });
  mgr.acquirePort("a"); // holds port
  mgr.acquirePort("b"); // queue head
  mgr.acquirePort("c"); // queue position 2
  mgr.releasePort(18451, "a");

  // c 不是队首，即便有空闲端口也不能插队。
  assert.deepEqual(mgr.acquirePort("c"), { queued: true, position: 2, queueLength: 2 });
  // b 是队首，能拿到。
  assert.deepEqual(mgr.acquirePort("b"), { port: 18451 });
});

test("max-hold timeout force-releases the port and promotes the next", async () => {
  let forced = null;
  const mgr = new SessionManager({
    portPool: [18451],
    maxHoldSec: 1,
    onForceRelease: (id, port) => { forced = { id, port }; },
  });
  mgr.acquirePort("a");
  mgr.acquirePort("b");
  assert.ok(mgr.holdRemainingSec("a") > 0, "持有者应有剩余占用时间");

  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(forced, { id: "a", port: 18451 }, "占用超时应回调强制释放");
  assert.equal(mgr.holdsPort("a"), false, "超时后原持有者不再持有端口");
  assert.deepEqual(mgr.acquirePort("b"), { port: 18451 }, "队首应递补拿到端口");
});

test("a force-released session without a code auto re-queues at the tail", async () => {
  const mgr = new SessionManager({ portPool: [18451], maxHoldSec: 1 });
  // 用 create() 走真实会话路径：超时时 SessionManager 能查到会话并判断其是否已抓到 code。
  mgr.create("a");
  mgr.create("b");
  mgr.acquirePort("a"); // a 持有端口
  mgr.acquirePort("b"); // b 在排队（队首）

  await new Promise((r) => setTimeout(r, 1200));

  // a 占用超时且未抓到 code：应被自动重新排队；此时队列为 [b, a]。
  assert.equal(mgr.holdsPort("a"), false, "超时后 a 不再持有端口");
  assert.deepEqual(mgr.acquirePort("b"), { port: 18451 }, "原队首 b 递补拿到端口");
  assert.deepEqual(
    mgr.acquirePort("a"),
    { queued: true, position: 1, queueLength: 1 },
    "被强制释放的 a 应自动排到队尾继续等待，而不是消失",
  );
});

test("a force-released session that already captured a code does not re-queue", async () => {
  const mgr = new SessionManager({ portPool: [18451], maxHoldSec: 1, codeGraceMs: 5000 });
  const a = mgr.create("a");
  mgr.create("b");
  mgr.acquirePort("a");
  mgr.acquirePort("b");
  // a 在占用期间抓到了 code：超时释放后视为完成，不应再排队。
  a.ingest({ platform: "qq", code: "code-a", gid: "123" });

  await new Promise((r) => setTimeout(r, 1200));

  assert.deepEqual(mgr.acquirePort("b"), { port: 18451 }, "队首 b 递补拿到端口");
  // a 未被重新排队，队列此刻为空（b 刚出队）。
  assert.equal(mgr.queueLength, 0, "已抓到 code 的会话不应重新排队");
});

test("queue TTL prunes ghost waiters that stop polling", async () => {
  const mgr = new SessionManager({ portPool: [18451], queueTtlSec: 1 });
  mgr.acquirePort("a");
  mgr.acquirePort("b");
  mgr.acquirePort("c");
  assert.equal(mgr.queueLength, 2);

  await new Promise((r) => setTimeout(r, 1200));
  // 期间无人心跳 → b、c 都被剔除。
  assert.equal(mgr.queueLength, 0);
  // 仍在轮询的 c 通过再次 acquirePort 无缝重新入队。
  assert.deepEqual(mgr.acquirePort("c"), { queued: true, position: 1, queueLength: 1 });
});

test("refreshQueue keeps a still-polling waiter alive while others are pruned", async () => {
  const mgr = new SessionManager({ portPool: [18451], queueTtlSec: 1 });
  mgr.acquirePort("a");
  mgr.acquirePort("b");
  mgr.acquirePort("c");

  // 在 TTL 内持续为 c 刷新心跳，b 不刷新。
  const beat = setInterval(() => mgr.refreshQueue("c"), 300);
  await new Promise((r) => setTimeout(r, 1400));
  clearInterval(beat);

  const info = mgr.refreshQueue("c");
  assert.ok(info && info.queued, "持续心跳的 c 应仍在排队");
  assert.equal(mgr.queueLength, 1, "停止心跳的 b 应被剔除");
});

test("stop/delete path releases port with sessionId and clears holder", () => {
  const mgr = new SessionManager({ portPool: [18451] });
  mgr.create("a");
  mgr.acquirePort("a");
  assert.equal(mgr.holdsPort("a"), true);

  mgr.releasePort(18451, "a");
  assert.equal(mgr.holdsPort("a"), false);
  assert.deepEqual(mgr.portPool, [18451], "端口应回到池中");
});
