# 清理第三方取码 API + 让「启用微信登录」开关真正生效

## Context（为什么做这次改动）

项目里存在**两套**微信取 code 机制：

1. **旧的第三方服务**（`code.z74d.top`）——通过配置面板的「API地址 / API密钥 / 代理API地址」三字段，被「自动刷新 Code」后台任务和一个独立代理路由 `/api/proxy` 使用。
2. **新的自建协议**（本次已迁移的 `wx-login` 扫码服务）——完全不依赖那三字段。

既然扫码取 code 已改为自建协议，第三方链路（三字段 + 自动刷新 Code + 代理路由）已成为无用/冗余功能，需**彻底移除**。同时，配置面板里的「启用微信登录」开关目前是**空壳**——前端 `wxLoginStore.loadConfig()` 从不拉取服务端真实值，`config.enabled` 恒为 `true`，导致开关关了也拦不住扫码。本次要让该开关**前端隐藏入口 + 后端拦截接口**双向生效。

用户确认的范围：
- 彻底删除三字段（apiBase / apiKey / proxyApiUrl）。
- 彻底删除「自动刷新 Code」功能（前后端）。
- 一并删除独立代理路由 `admin-proxy-routes.js`（`/api/proxy`）。
- 「启用微信登录」关闭时：前端隐藏扫码入口 + 后端 `/api/wx-login/*` 返回 403。

---

## 关键复用点（已确认存在，直接复用）

- **`GET /api/user/wxlogin-config`**（[admin-current-user-routes.js:54-63](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin-current-user-routes.js#L54-L63)）：仅需 `requireAdminToken`（普通登录用户即可访问），返回 `store.getGlobalWxConfig()`，含 `enabled`。→ 前端开关的数据源直接用它，无需新增接口。
- **`store.getGlobalWxConfig()`**（[store.js:1664](file:///c:/_Farm/qq-farm-bot/core/src/models/store.js#L1664)）：`enabled` / `autoAddAccount` / `userIsolation` 仍被 `admin-account-access.js`（用户隔离）等依赖，**必须保留函数本体**，仅删其中的 API 字段。
- **`AccountModal.vue` 已有门栏** `v-if="wxLoginStore.config.enabled"`（微信扫码 tab）——数据源修好后自动生效，无需新增模板判断。

---

## 实施步骤

### A. 后端：删除「自动刷新 Code」

1. **删除整个文件** [auto-code-refresh.js](file:///c:/_Farm/qq-farm-bot/core/src/runtime/auto-code-refresh.js)（唯一实现 + 唯一调用第三方 API 的地方）。
2. [runtime-engine.js](file:///c:/_Farm/qq-farm-bot/core/src/runtime/runtime-engine.js)：删 require（L9）、`createAutoCodeRefreshService` 实例化（L81-88）、传给 dataProvider 的 `scheduleAutoCodeRefresh`/`refreshAccountCode`（L144-145）、`autoCodeRefresh.rescheduleAll()`（L208）。
3. [data-provider.js](file:///c:/_Farm/qq-farm-bot/core/src/runtime/data-provider.js)：删 deps 解构（L27-28）、`saveSettings` 里的 `autoCodeRefresh` 三处（L223、L242-244、L251）、`saveAutoCodeRefresh` 方法（L269-275）、`refreshAccountCode` 方法（L277-283）。**保留** L324 的 `stopAccount`（worker 停止，无关）。
4. [admin-settings-routes.js](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin-settings-routes.js)：删 settings GET 里的 `autoCodeRefresh` 字段（L95-98）、路由 `POST /api/settings/auto-code-refresh`（L288-301）、`POST /api/settings/auto-code-refresh/run`（L303-316）。
5. [admin-account-routes.js](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin-account-routes.js)：删 `hasWxRefreshIdentity` 辅助（L18-20）与批量刷新路由 `POST /api/accounts/refresh-wx-codes`（L61-123）。**保留** L244 `provider.stopAccount`。
6. [store.js](file:///c:/_Farm/qq-farm-bot/core/src/models/store.js)：删账号级 `autoCodeRefresh` 全部 8 处（L255-258、L455-458、L562-567、L684、L1031、L1077-1082、`getAutoCodeRefresh` L1185-1191、`setAutoCodeRefresh` L1193-1202、exports L1842-1843）。

### B. 后端：删除第三方 API 三字段（保留 wx 配置函数）

7. [store.js](file:///c:/_Farm/qq-farm-bot/core/src/models/store.js)：从 load 路径（L866-869）、`DEFAULT_WX_CONFIG`（L1656-1659）、`setGlobalWxConfig`（L1674-1677）中删除 `apiBase`/`apiKey`/`proxyApiUrl`/`appId`。**保留** `enabled`/`autoAddAccount`/`userIsolation` 及三个访问函数本体。
8. [admin-system-routes.js](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin-system-routes.js)：删 `POST /api/admin/wx-config` 日志里的 `apiBase` 字段（L407）。路由本体保留。

### C. 后端：删除独立代理路由

9. **删除整个文件** [admin-proxy-routes.js](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin-proxy-routes.js)。
10. [admin.js](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin.js)：删 require（L55）、`registerAdminProxyRoutes({ app, logger })`（L559）、`PUBLIC_API_PATHS` 里的 `"/proxy"`（L78）、CORS 允许头里的 `x-proxy-api-key, x-proxy-api-url, x-proxy-app-id`（L144，改回不含这三项）。

### D. 后端：「启用微信登录」拦截扫码接口

11. [admin-wx-login-routes.js](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin-wx-login-routes.js)：`registerAdminWxLoginRoutes` 需能访问 `store`（在 [admin.js:558](file:///c:/_Farm/qq-farm-bot/core/src/controllers/admin.js#L558) 调用处传入 `store`）。新增一个轻量守卫，在**创建任务/下载二维码/状态轮询/确认/取码**等路由入口检查 `store.getGlobalWxConfig().enabled !== false`，为 `false` 时返回 `403 { ok:false, error:'微信登录未启用' }`。

### E. 前端：删除「自动刷新获取 Code」UI 与状态

12. [setting.ts](file:///c:/_Farm/qq-farm-bot/web/src/stores/setting.ts)：删 `AutoCodeRefreshConfig` 类型、`createDefaultAutoCodeRefresh`、defaults/clear/merge/save-payload 中的 `autoCodeRefresh`、`saveAutoCodeRefresh` 与 `runAutoCodeRefresh` 两个函数及其导出（对应 L80-83、96、130-135、156、191、228-231、269、317-356、365-366）。
13. [useAutomationSettings.ts](file:///c:/_Farm/qq-farm-bot/web/src/composables/settings/useAutomationSettings.ts)：删 `localAutoCodeRefresh`、`autoCodeRefreshing`、`normalizeAutoCodeRefreshInterval`、`runAutoCodeRefreshNow` 及相关引用与导出。
14. [AutomationSettingsTab.vue](file:///c:/_Farm/qq-farm-bot/web/src/components/settings/AutomationSettingsTab.vue)：删「自动刷新获取 Code」整块模板（L199-242）、`autoCodeRefreshing` prop、`showRunAutoCodeRefresh` prop、`runAutoCodeRefresh` emit、`autoCodeRefresh` defineModel、本地 `AutoCodeRefreshConfig` 接口。
15. [DefaultPlanSettingsTab.vue](file:///c:/_Farm/qq-farm-bot/web/src/components/settings/DefaultPlanSettingsTab.vue)：删 `autoCodeRefresh` ref、apply/build 引用、`<AutomationSettingsTab>` 上的三个相关绑定（L363、368、369）。
16. [Settings.vue](file:///c:/_Farm/qq-farm-bot/web/src/views/Settings.vue)：删解构的 `localAutoCodeRefresh`/`autoCodeRefreshing`/`runAutoCodeRefreshNow`（L134、136、141）与 `<AutomationSettingsTab>` 上的三个绑定（L318、323、326）。

> 说明：`AutomationSettingsTab` 的 `autoCodeRefresh` 是 `required` defineModel，两个调用处（Settings.vue、DefaultPlanSettingsTab.vue）必须与 defineModel 同批删除，避免 Vue 缺失必需 model 告警。

### F. 前端：删除微信三字段

17. [useAdminSystemConfig.ts](file:///c:/_Farm/qq-farm-bot/web/src/composables/useAdminSystemConfig.ts)：`WxConfig` 接口删 `apiBase`/`apiKey`/`proxyApiUrl`（L13-15），`defaultWxConfig` 删对应默认值（L51-53）。保存/加载用的是对象展开，删字段后自动不再收发。**不动** `CaptureConfig.apiBase`（另一功能）。
18. [AdminSystemPanel.vue](file:///c:/_Farm/qq-farm-bot/web/src/components/admin/AdminSystemPanel.vue)：删三个 `BaseInput`（API地址/API密钥/代理API地址，L350-370）。顺带精简提示文案里的“代理地址”措辞（L339-341）。保留 `BaseInput` import。
19. [wx-login.ts](file:///c:/_Farm/qq-farm-bot/web/src/stores/wx-login.ts)：`WxLoginConfig` 接口删 `apiBase`/`apiKey`/`proxyApiUrl`（L8-10），`defaultConfig` 删对应值（L19-21）。扫码流程实际只读 `appId` 与 `autoAddAccount`，删除零影响。

### G. 前端：让「启用微信登录」开关生效

20. [wx-login.ts](file:///c:/_Farm/qq-farm-bot/web/src/stores/wx-login.ts) 的 `loadConfig()`（L44-46，当前空壳）：改为调用 `GET /api/user/wxlogin-config`，把返回的 `enabled`（及 `autoAddAccount`/`userIsolation`）写入 `rawConfig`；失败时回退默认值。这样 `config.enabled` 反映服务端真实状态。
21. [AccountModal.vue](file:///c:/_Farm/qq-farm-bot/web/src/components/AccountModal.vue)：确认打开弹窗时会触发 `loadConfig`/`loadConfigFromServer`（若未触发则在打开时补一次调用），使 L453 的 `v-if="wxLoginStore.config.enabled"` 门栏拿到真实值。同步检查 [WxLoginModal.vue](file:///c:/_Farm/qq-farm-bot/web/src/components/WxLoginModal.vue) 的挂载入口是否也需按 `enabled` 隐藏。

---

## Verification（端到端验证）

1. **构建**：`pnpm -C web build`（含 `vue-tsc` 类型检查）必须通过——可捕获前端删漏（如遗留 `autoCodeRefresh` 引用、缺失 model）。
2. **后端启动**：启动 core 服务，确认无 `require` 报错、无 `undefined is not a function`（重点看 runtime-engine / data-provider / 路由注册）。
3. **开关关闭态**：管理面板把「启用微信登录」关掉并保存 → 刷新后打开「添加账号」，确认「微信扫码」tab 不显示；直接 `curl POST /api/wx-login/tasks` 应返回 403。
4. **开关开启态**：打开开关保存 → 「微信扫码」tab 出现，二维码正常显示、可扫码登录（沿用上一轮验证）。
5. **回归**：设置页「自动化」tab 不再有「自动刷新获取 Code」区块，其余设置项保存/加载正常；`/api/proxy`、`/api/accounts/refresh-wx-codes`、`/api/settings/auto-code-refresh*` 均已不存在（404）。
6. **搜索兜底**：全仓 `rg -n "autoCodeRefresh|proxyApiUrl|apiKey|admin-proxy-routes|refresh-wx-codes|code\.z74d\.top"` 应无残留（`CaptureConfig` 相关除外）。
