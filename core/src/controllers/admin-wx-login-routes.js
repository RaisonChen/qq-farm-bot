const crypto = require('node:crypto');
const { WxLoginService } = require('../services/wx-login/service');

const TARGET_APP_ID = 'wx5306c5978fdb76e4';
const TASK_TTL_MS = 110000;
const tasks = new Map();
const wxLogin = new WxLoginService();

function getOwner(req) {
  return String(req.currentUser?.username || req.adminToken || '');
}

function destroy(task) {
  wxLogin.destroy(task.session);
  task.code = undefined;
  tasks.delete(task.id);
}

function publicTask(task) {
  return { task_id: task.id, app_id: TARGET_APP_ID, status: task.status, openid: task.session.openid, expires_at: Math.floor((task.createdAt + TASK_TTL_MS) / 1000) };
}

function findTask(req, res) {
  const task = tasks.get(String(req.params.taskId || ''));
  if (!task || task.owner !== getOwner(req) || Date.now() - task.createdAt > TASK_TTL_MS) {
    if (task) destroy(task);
    res.status(404).json({ ok: false, error: 'Login task not found or expired' });
    return null;
  }
  return task;
}

function registerAdminWxLoginRoutes({ app, store }) {
  // 「启用微信登录」总开关：关闭时拦截所有扫码相关接口
  const requireWxEnabled = (req, res, next) => {
    try {
      if (store && typeof store.getGlobalWxConfig === 'function' && store.getGlobalWxConfig().enabled === false) {
        return res.status(403).json({ ok: false, error: '微信登录未启用' });
      }
    } catch { /* 读取失败时按启用处理，避免误伤 */ }
    return next();
  };

  app.post('/api/wx-login/tasks', requireWxEnabled, async (req, res) => {
    if (req.body?.app_id && req.body.app_id !== TARGET_APP_ID) return res.status(400).json({ ok: false, error: 'Unsupported app_id' });
    try {
      const { session, qr } = await wxLogin.createQrSession();
      const task = { id: crypto.randomBytes(32).toString('hex'), owner: getOwner(req), createdAt: Date.now(), status: 'waiting', session, qr };
      tasks.set(task.id, task);
      res.json({ ok: true, data: { ...publicTask(task), qr_url: `/api/wx-login/tasks/${task.id}/qr` } });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/wx-login/tasks/:taskId/qr', requireWxEnabled, (req, res) => {
    const task = findTask(req, res);
    if (task) res.type('jpeg').send(task.qr);
  });

  app.delete('/api/wx-login/tasks/:taskId', requireWxEnabled, (req, res) => {
    const task = tasks.get(String(req.params.taskId || ''));
    if (!task || task.owner !== getOwner(req)) return res.status(404).json({ ok: false, error: 'Login task not found or expired' });
    destroy(task);
    return res.json({ ok: true });
  });

  app.get('/api/wx-login/tasks/:taskId/status', requireWxEnabled, async (req, res) => {
    const task = findTask(req, res);
    if (!task) return;
    try {
      if (!task.pending) task.pending = (async () => { if (task.status !== 'authorized' && task.status !== 'ready_for_code') task.status = await wxLogin.poll(task.session); })().finally(() => { task.pending = undefined; });
      await task.pending;
      const data = publicTask(task);
      if (task.status === 'cancelled' || task.status === 'expired') destroy(task);
      res.json({ ok: true, data });
    } catch (error) { destroy(task); res.status(502).json({ ok: false, error: error.message }); }
  });

  app.post('/api/wx-login/tasks/:taskId/confirm', requireWxEnabled, async (req, res) => {
    const task = findTask(req, res);
    if (!task) return;
    try {
      if (task.status !== 'authorized') throw new Error('Waiting for scan authorization');
      if (!task.pending) task.pending = wxLogin.confirm(task.session).then(() => { task.status = 'ready_for_code'; }).finally(() => { task.pending = undefined; });
      await task.pending;
      res.json({ ok: true, data: publicTask(task) });
    } catch (error) { destroy(task); res.status(502).json({ ok: false, error: error.message }); }
  });

  app.post('/api/wx-login/tasks/:taskId/code', requireWxEnabled, async (req, res) => {
    const task = findTask(req, res);
    if (!task) return;
    try {
      if (task.status !== 'ready_for_code') throw new Error('Login code is not ready');
      if (!task.pending) task.pending = wxLogin.issueCode(task.session, TARGET_APP_ID).then(code => { task.code = code; }).finally(() => { task.pending = undefined; });
      await task.pending;
      const data = { wxid: task.session.openid, openid: task.session.openid, app_id: TARGET_APP_ID, code: task.code, err_msg: 'login:ok' };
      destroy(task);
      res.json({ ok: true, data });
    } catch (error) { destroy(task); res.status(502).json({ ok: false, error: error.message }); }
  });
}

module.exports = { registerAdminWxLoginRoutes };
