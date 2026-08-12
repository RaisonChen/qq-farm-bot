/**
 * 活动服务 - 活动商店与限时抽奖
 *
 * 功能：
 * - 获取活动分组信息
 * - 操作活动（购买/刷新随机商店）
 * - 解析随机商店与活动抽奖数据
 * - 原始 protobuf 回退解码
 */
const protobuf = require('protobufjs/minimal');
const { sendMsgAsync, getUserState, isConnected, GatewayError } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');
const { getItemImageById, getItemById } = require('../config/gameConfig');
const { createModuleLogger } = require('./logger');
const { getBag, getBagItems } = require('./warehouse');

const activityLogger = createModuleLogger('activity');

const HELU_DRAW_REQUEST_GAP_MS = 450;
const HELU_DRAW_REFRESH_DELAY_MS = 350;
const QINGMEI_WINE_STEP_DELAY_MS = 1000;
const QINGMEI_DAILY_ALREADY_CLAIMED_CODE = 1034014;
const SECONDS_PER_DAY = 86400;
const BEIJING_UTC_OFFSET_SECONDS = 8 * 60 * 60;

// 写操作串行化（对齐 master 的 serializeMutation），避免并发竞态
let mutationTail = Promise.resolve();
function serializeMutation(operation) {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(() => {}, () => {});
  return result;
}

// 北京日期缓存（对齐 master 的 qingMeiSeedClaimedDateKey）
let qingMeiSeedClaimedDateKey = '';
function beijingDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// 青梅领取状态缓存（按账号记录当日是否已领取）
const qingmeiClaimedDateByAccount = new Map();

// 将 bytes/string 解析为文本
function bytesToText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try {
    const buffer = Buffer.from(value);
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('\uFFFD')) return utf8;
  } catch { /* ignore */ }
  return String(value || '');
}
function plainText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}
function findStrings(value, output) {
  if (typeof value === 'string') {
    const t = plainText(value);
    if (t) output.push(t);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(v => findStrings(v, output));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(v => findStrings(v, output));
  }
}
// 从 activity.extra 解析规则（对齐 master 的 textContent）
function parseActivityRules(extra) {
  const text = bytesToText(extra).trim();
  if (!text) return { title: '', paragraphs: [] };
  try {
    const parsed = JSON.parse(text);
    const tips = parsed && typeof parsed === 'object' ? parsed.tips : null;
    const rawParagraphs = tips && Array.isArray(tips.txt) ? tips.txt : [];
    const paragraphs = rawParagraphs
      .filter(e => typeof e === 'string')
      .map(plainText)
      .filter(Boolean);
    if (paragraphs.length) {
      return { title: typeof tips?.title === 'string' ? plainText(tips.title) : '', paragraphs };
    }
    const allText = [];
    findStrings(parsed, allText);
    return { title: '', paragraphs: Array.from(new Set(allText)) };
  } catch {
    return { title: '', paragraphs: [plainText(text)].filter(Boolean) };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

// 金币格式化：过万显示为 "X.XX万"，否则用千分位
function formatGold(value) {
  const n = Number(value) || 0;
  if (n >= 10000) {
    const rounded = Math.round((n / 10000) * 100) / 100;
    return `${rounded}万`;
  }
  return n.toLocaleString();
}

// 倍率格式化：服务端用 ×10000 表示倍数（10000=1倍，15000=1.5倍）
function formatMultiplier(value) {
  const n = Number(value) || 0;
  const rounded = Math.round((n / 10000) * 100) / 100;
  return `${rounded}倍`;
}

function getLocalDateKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getQingmeiClaimStateKey() {
  const state = getUserState();
  return String(state?.gid || state?.openid || 'current');
}

function markQingmeiClaimedToday() {
  qingmeiClaimedDateByAccount.set(getQingmeiClaimStateKey(), getLocalDateKey());
}

function isQingmeiClaimedToday() {
  return qingmeiClaimedDateByAccount.get(getQingmeiClaimStateKey()) === getLocalDateKey();
}

function assertActivityConnection(action) {
  if (!isConnected()) {
    throw new Error(`${action || '活动操作'}失败: 连接已断开，请等待自动重连后重试`);
  }
}

// ---- 活动常量 ----

// 南瓜活动标识
const NANGUA_ACTIVITY_UID = 'NanGua';
const HELU_ACTIVITY_UID = 'SAIJI';
const QINGMEI_ACTIVITY_UID = 'QingMeiActivity';

// 活动 ID（通过 proto 文件 reflect，脱混淆为可读命名）
const NANGUA_SHOP_ACTIVITY_ID = 2026030200;
const NANGUA_RANDOM_SHOP_ACTIVITY_ID = 2026030201;
const HELU_ACTIVITY_ID = 2026060100;
const HELU_DRAW_ACTIVITY_ID = 2026060101;
const HELU_EXCHANGE_ACTIVITY_ID = 2026060102;
const HELU_JOURNEY_ACTIVITY_ID = 2026060103;
const HELU_NOTES_ACTIVITY_ID = 2026060104;
const HELU_CURRENCY_ITEM_ID = 1018;
const STAR_ACTIVITY_UID = 'SAIJI_MEGA_EVENT';
const STAR_ACTIVITY_ID = 2026072700;
const STAR_RECORD_ACTIVITY_ID = 2026072701;
const STAR_SHOP_ACTIVITY_ID = 2026072702;
const STAR_SAND_ITEM_ID = 1023;
const STAR_RECORD_CLAIM_CMD = 21;
const STAR_SHOP_OPEN_CMD = 7;
const STAR_SHOP_EXCHANGE_CMD = 1;
const QINGMEI_ACTIVITY_ID = 2026081200;
const QINGMEI_SEED_CLAIM_ACTIVITY_ID = 2026081201;
const QINGMEI_WINE_ACTIVITY_ID = 2026081202;
const QINGMEI_SEED_CLAIM_CMD = 4;
const QINGMEI_WINE_PREVIEW_CMD = 14;
const QINGMEI_WINE_BREW_CMD = 15;
const QINGMEI_WINE_SELL_CMD = 16;
const QINGMEI_SEED_ITEM_ID = 21221;
const QINGMEI_FRUIT_ITEM_ID = 41221;
const QINGMEI_SEED_REWARD_COUNT = 24;
const QINGMEI_FINE_BREW_STEPS = 3;
// 新协议常量（与 master 对齐）
const QINGMEI_DAILY_GRANT_ID = 3;
const QUERY_QINGMEI_OPERATE_TYPE = 7;
const CLAIM_QINGMEI_SEED_OPERATE_TYPE = 4;
const START_QINGMEI_BREW_OPERATE_TYPE = 14;
const CONTINUE_QINGMEI_BREW_OPERATE_TYPE = 15;
const SELL_QINGMEI_BREW_OPERATE_TYPE = 16;
const QINGMEI_SHARE_SOURCE = 11;
const QINGMEI_SHARE_SCENE = 215;
const QINGMEI_SHARED_SETTLEMENT_MODE = 2;
const HELU_PASSPORT_UID = 'SAIJI_PASSPORT';
const HELU_TITLE = '荷风十里蝉初鸣';
const HELU_SUB_ACTIVITY_KEYS = {
  giftLotus: 'giftLotus',
  shop: 'shop',
  journey: 'journey',
  notes: 'notes',
};
const HELU_SUB_ACTIVITY_DEFS = [
  { key: HELU_SUB_ACTIVITY_KEYS.giftLotus, title: '奇遇礼莲', icon: 'i-carbon-gift' },
  { key: HELU_SUB_ACTIVITY_KEYS.shop, title: '荷露商店', icon: 'i-carbon-store' },
  { key: HELU_SUB_ACTIVITY_KEYS.journey, title: '荷风游记', icon: 'i-carbon-map' },
  { key: HELU_SUB_ACTIVITY_KEYS.notes, title: '节令小札', icon: 'i-carbon-notebook' },
];

// 操作命令
const NANGUA_SHOP_BUY_CMD = 2;     // 购买
const NANGUA_SHOP_REFRESH_CMD = 3; // 刷新
const HELU_EXCHANGE_CMD = 1;
const HELU_DRAW_CMD = 9;

// ---- RPC 调用 ----

/**
 * 获取活动分组信息
 */
async function getActivityGroup(activityId = NANGUA_SHOP_ACTIVITY_ID, uid = NANGUA_ACTIVITY_UID) {
  const request = types.ActivityGetGroupRequest.encode(
    types.ActivityGetGroupRequest.create({
      id: Number(activityId) || NANGUA_SHOP_ACTIVITY_ID,
      uid: String(uid || ''),
    })
  ).finish();

  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', request);
  const decoded = types.ActivityGetGroupReply.decode(body);

  // 附加原始字节供回退解析
  Object.defineProperty(decoded, '__rawBody', {
    value: Buffer.from(body || []),
    enumerable: false,
  });

  return decoded;
}

async function listActivityGroups() {
  const request = types.ActivityListRequest.encode(
    types.ActivityListRequest.create({})
  ).finish();
  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', request);
  return types.ActivityListReply.decode(body);
}

/**
 * 操作活动
 */
async function operateActivity(activityId, cmd, options = {}) {
  assertActivityConnection('活动操作');

  const payload = {
    id: Number(activityId) || NANGUA_SHOP_ACTIVITY_ID,
    cmd: Number(cmd) || 0,
  };

  if (options?.randomShopOperate && typeof options.randomShopOperate === 'object') {
    payload.random_shop_operate = {
      id: Number(options.randomShopOperate.id) || 0,
      count: Number(options.randomShopOperate.count) || 1,
    };
  } else if (options?.exchangeShopOperate && typeof options.exchangeShopOperate === 'object') {
    payload.exchange_shop_operate = {
      id: Number(options.exchangeShopOperate.id) || 0,
      count: Number(options.exchangeShopOperate.count) || 1,
    };
  } else if (options?.draw && typeof options.draw === 'object') {
    payload.draw = options.draw;
  }
  if (options?.helu_paid_draw && typeof options.helu_paid_draw === 'object') {
    payload.helu_paid_draw = options.helu_paid_draw;
  }
  if (options?.qingmeiClaim && typeof options.qingmeiClaim === 'object') {
    payload.qingmei_claim_params = {
      type: Math.max(0, toNum(options.qingmeiClaim.type)),
    };
  }
  if (options?.qingmeiWineStart && typeof options.qingmeiWineStart === 'object') {
    payload.qingmei_wine_start = {
      items: (options.qingmeiWineStart.items || []).map(item => ({
        id: toNum(item?.id),
        count: toNum(item?.count),
      })),
    };
  }
  if (options?.qingmeiWineBrew) {
    payload.qingmei_wine_brew = {};
  }
  if (options?.qingmeiWineSell && typeof options.qingmeiWineSell === 'object') {
    payload.qingmei_wine_sell = {
      multiple: Math.max(1, toNum(options.qingmeiWineSell.multiple) || 1),
    };
  }

  activityLogger.info('活动操作请求', {
    activityId: payload.id,
    cmd: payload.cmd,
    draw: payload.draw,
    exchangeShopOperate: payload.exchange_shop_operate,
    randomShopOperate: payload.random_shop_operate,
    heluPaidDraw: payload.helu_paid_draw,
    qingmeiClaim: payload.qingmei_claim_params,
    qingmeiWineStartCount: payload.qingmei_wine_start?.items?.length || 0,
    qingmeiWineBrew: !!payload.qingmei_wine_brew,
    qingmeiWineSell: payload.qingmei_wine_sell,
  });

  const request = types.ActivityOperateRequest.encode(
    types.ActivityOperateRequest.create(payload)
  ).finish();

  const { body } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', request);
  return body;
}

async function operateActivityReply(activityId, cmd, options = {}) {
  const body = await operateActivity(activityId, cmd, options);
  return types.ActivityOperateReply.decode(body);
}

function normalizeCoreItem(item) {
  const itemId = toNum(item?.id);
  const count = toNum(item?.count);
  const info = getItemById(itemId);
  return {
    itemId,
    itemCount: count,
    count,
    itemName: info?.name || (itemId ? `物品#${itemId}` : ''),
    image: getItemImageById(itemId) || '',
  };
}

function normalizeQingmeiPreviewResult(result) {
  if (!result) return null;
  return {
    price: toNum(result?.price),
  };
}

function normalizeQingmeiBrewResult(result) {
  if (!result) return null;
  return {
    wineType: toNum(result?.wine_type ?? result?.wineType),
    cost: toNum(result?.cost),
    price: toNum(result?.price),
    canDouble: !!(result?.can_double ?? result?.canDouble),
  };
}

function normalizeQingmeiSellResult(result) {
  if (!result) return null;
  const item = normalizeCoreItem(result?.item || {});
  return {
    multiple: toNum(result?.multiple),
    gold: toNum(result?.gold) || item.itemCount,
    item,
  };
}

function normalizeQingmeiClaimResult(result) {
  const items = (Array.isArray(result?.items) ? result.items : [])
    .map(normalizeCoreItem)
    .filter(item => item.itemId > 0 && item.itemCount > 0);
  const seed = items.find(item => item.itemId === QINGMEI_SEED_ITEM_ID);
  return {
    items,
    claimedCount: seed?.itemCount || 0,
  };
}

function isAlreadyClaimedError(err) {
  const message = String(err?.message || err || '');
  return message.includes('已领取')
    || message.includes('已经领取')
    || message.includes('重复领取')
    || message.includes('already')
    || message.includes('1009001');
}

function createQingmeiWineError(stage, message, cause) {
  const err = new Error(message || cause?.message || '青梅酿操作失败');
  err.stage = stage;
  err.cause = cause;
  err.qingmeiWine = true;
  return err;
}

function isNoOngoingQingmeiBrewError(err) {
  const message = String(err?.message || err || '');
  return message.includes('1034027') || message.includes('无进行中的酿造记录');
}

function extractErrorCode(err) {
  const message = String(err?.message || err || '');
  const match = message.match(/code=(\d+)/);
  return match ? Number(match[1]) : 0;
}

function isQingmeiAlreadyClaimedError(err) {
  return extractErrorCode(err) === QINGMEI_DAILY_ALREADY_CLAIMED_CODE
    || isAlreadyClaimedError(err);
}

// ===== 青酿新协议操作（与服务端匹配）=====

async function operateQingMeiNew(requestType, payload, expectedErrorCodes = []) {
  const body = Buffer.from(requestType.encode(requestType.create(payload)).finish());
  const options = expectedErrorCodes.length > 0 ? { expectedErrorCodes } : undefined;
  try {
    const { body: replyBody } = await sendMsgAsync(
      'gamepb.activitypb.ActivityService',
      'Operate',
      body,
      options,
    );
    return replyBody ? types.ActivityOperateReplyNew.decode(replyBody) : {};
  } catch (err) {
    // sendMsgAsync 已经处理了 expectedErrorCodes，这里处理 GatewayError fallback
    if (expectedErrorCodes.length > 0 && err instanceof GatewayError) {
      if (expectedErrorCodes.includes(Number(err.code))) {
        return {};
      }
    }
    throw err;
  }
}

async function reportQingMeiActivityShare() {
  const body = types.ReportShareRequest.encode(types.ReportShareRequest.create({
    shared: true,
    field_1: QINGMEI_SHARE_SOURCE,
    field_4: QINGMEI_SHARE_SCENE,
  })).finish();
  await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', body).catch(() => {});
}

// 获取背包中青酿材料（带 uid，用于酿造）
async function getQingMeiBrewIngredients() {
  const bag = await getBag();
  const items = getBagItems(bag) || [];
  const result = [];
  for (const item of items) {
    const id = toNum(item?.id);
    const uid = toNum(item?.uid);
    const count = toNum(item?.count);
    if (id === QINGMEI_FRUIT_ITEM_ID && uid > 0 && count > 0) {
      result.push({
        id,
        uid,
        count,
        mutantType: Array.isArray(item?.mutant_types) && item.mutant_types.length
          ? Math.min(...item.mutant_types.map(toNum).filter(v => v > 0))
          : 0,
      });
    }
  }
  return result;
}

async function reportQingmeiShareForDouble() {
  const checkRequest = types.CheckCanShareRequest.encode(
    types.CheckCanShareRequest.create({})
  ).finish();
  const { body: checkBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'CheckCanShare', checkRequest);
  const checkResult = types.CheckCanShareReply.decode(checkBody);

  if (!checkResult?.can_share) {
    throw new Error('当前不可分享，无法执行青梅酿售卖翻倍');
  }

  const reportRequest = types.ReportShareRequest.encode(
    types.ReportShareRequest.create({ shared: true })
  ).finish();
  const { body: reportBody } = await sendMsgAsync('gamepb.sharepb.ShareService', 'ReportShare', reportRequest);
  const reportResult = types.ReportShareReply.decode(reportBody);

  if (reportResult && Object.hasOwn(reportResult, 'success') && !reportResult.success) {
    throw new Error('青梅酿分享上报失败');
  }

  return {
    canShare: !!checkResult?.can_share,
    shared: true,
    success: reportResult?.success !== false,
  };
}

async function getSeasonInfoRaw() {
  const { body } = await sendMsgAsync('gamepb.seasonpb.SeasonService', 'GetSeasonInfo', Buffer.alloc(0));
  return Buffer.from(body || []);
}

async function claimSeasonRewardsRaw() {
  assertActivityConnection('荷风游记领取');
  const { body } = await sendMsgAsync('gamepb.seasonpb.SeasonService', 'ClaimBattlePassRewards', Buffer.alloc(0));
  return Buffer.from(body || []);
}

async function getSolarTermsRaw() {
  const { body } = await sendMsgAsync('gamepb.solartermspb.SolarTermsService', 'GetSolarTerms', Buffer.alloc(0));
  return Buffer.from(body || []);
}

async function claimSolarTermsRaw(termId) {
  assertActivityConnection('节令小札领取');
  const request = protobuf.Writer.create()
    .uint32((1 << 3) | 0)
    .uint32(Math.max(0, Number(termId) || 0))
    .finish();
  const { body } = await sendMsgAsync('gamepb.solartermspb.SolarTermsService', 'ClaimSolarTerms', request);
  return Buffer.from(body || []);
}

// ---- 商品购买 ----

/**
 * 购买南瓜商店商品
 */
async function buyNanguaShopItem(slotId, defaultCount = 1) {
  const slotIdNum = Number(slotId) || 0;
  if (slotIdNum <= 0) throw new Error('缺少有效的活动商店槽位');

  const shop = await getNanguaShop();
  const slotItems = Array.isArray(shop?.randomShop) ? shop.randomShop : [];
  const slot = slotItems.find((item) => toNum(item?.id) === slotIdNum);

  if (!slot) throw new Error(`活动商店未找到槽位: ${slotIdNum}`);
  if (!slot.purchasable) throw new Error(`活动商店槽位不可购买: ${slot.statusLabel || '不可购买'}`);

  const price = toNum(slot?.price) || Number(defaultCount) || 0;
  if (price <= 0) throw new Error('缺少有效的活动商店价格');

  const remaining = Math.max(0,
    toNum(slot?.remainingCount) ||
    toNum(slot?.stockCount) - toNum(slot?.boughtCount) ||
    0
  );

  try {
    await operateActivity(NANGUA_RANDOM_SHOP_ACTIVITY_ID, NANGUA_SHOP_BUY_CMD, {
      randomShopOperate: { id: slotIdNum, count: remaining },
    });
  } catch (err) {
    throw new Error(
      `活动商店购买失败: activityId=${NANGUA_RANDOM_SHOP_ACTIVITY_ID}, slotId=${slotIdNum}, count=${remaining}, cost=${price}: ${err.message}`
    );
  }

  return getNanguaShop();
}

/**
 * 刷新南瓜商店
 */
async function refreshNanguaShop() {
  const before = await getNanguaShop();
  await operateActivity(NANGUA_RANDOM_SHOP_ACTIVITY_ID, NANGUA_SHOP_REFRESH_CMD);
  const after = await getNanguaShop();

  if (getRandomShopStateSignature(before) === getRandomShopStateSignature(after)) {
    throw new Error('活动商店刷新请求已返回，但商店内容和刷新次数未变化，请检查剩余刷新次数或协议字段');
  }

  return after;
}

// ---- 数据解析 ----

/**
 * 生成随机商店状态签名（用于检测刷新是否生效）
 */
function getRandomShopStateSignature(group) {
  const refresh = group?.randomShopRefresh || {};
  const items = Array.isArray(group?.randomShop) ? group.randomShop : [];
  return JSON.stringify({
    nextRefreshTime: toNum(refresh.nextRefreshTime),
    manualRefreshUsedCount: toNum(refresh.manualRefreshUsedCount),
    items: items.map((it) => [
      toNum(it?.id),
      toNum(it?.itemId),
      toNum(it?.stockCount),
      toNum(it?.boughtCount),
      !!it?.special,
    ]),
  });
}

/**
 * 解析活动 payload（JSON 字符串）
 */
function getField(raw, ...names) {
  if (!raw) return undefined;
  for (const name of names) {
    if (raw[name] !== undefined) return raw[name];
    const numeric = String(name).replace(/^field_/, '');
    if (/^\d+$/.test(numeric) && raw[numeric] !== undefined) return raw[numeric];
  }
  return undefined;
}

function parsePayload(rawPayload) {
  if (!rawPayload) return null;
  if (typeof rawPayload === 'object') return rawPayload;
  if (typeof rawPayload !== 'string') return null;
  const text = rawPayload.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeItemHex(raw) {
  if (typeof raw !== 'string' || !/^[0-9a-f]+$/i.test(raw) || raw.length < 4) return null;
  try {
    return types.CoreItem ? types.CoreItem.decode(Buffer.from(raw, 'hex')) : null;
  } catch {
    return null;
  }
}

function readProtoFields(rawBytes) {
  const buf = Buffer.from(rawBytes || []);
  const reader = protobuf.Reader.create(buf);
  const entries = [];

  while (reader.pos < reader.len) {
    let tag = 0;
    try {
      tag = reader.uint32();
    } catch {
      break;
    }

    const field = tag >>> 3;
    const wire = tag & 0x7;
    try {
      if (wire === 0) {
        entries.push({ field, wire, value: toNum(reader.uint64()) });
      } else if (wire === 2) {
        entries.push({ field, wire, value: Buffer.from(reader.bytes()) });
      } else if (wire === 5) {
        entries.push({ field, wire, value: reader.uint32() });
      } else if (wire === 1) {
        entries.push({ field, wire, value: reader.fixed64() });
      } else {
        reader.skipType(wire);
      }
    } catch {
      break;
    }
  }

  return entries;
}

function getProtoNumber(entries, field, fallback = 0) {
  const hit = (entries || []).find((entry) => entry.field === field && entry.wire === 0);
  return hit ? toNum(hit.value) : fallback;
}

function getProtoBytes(entries, field) {
  const hit = (entries || []).find((entry) => entry.field === field && entry.wire === 2);
  return hit ? Buffer.from(hit.value || []) : null;
}

function getProtoBytesAll(entries, field) {
  return (entries || [])
    .filter((entry) => entry.field === field && entry.wire === 2)
    .map((entry) => Buffer.from(entry.value || []));
}

function getProtoString(entries, field, fallback = '') {
  const bytes = getProtoBytes(entries, field);
  if (!bytes || bytes.length === 0) return fallback;
  try {
    return bytes.toString('utf8');
  } catch {
    return fallback;
  }
}

function parseActivityItemMessage(rawBytes) {
  const entries = readProtoFields(rawBytes);
  const itemId = getProtoNumber(entries, 1);
  const count = Math.max(0, getProtoNumber(entries, 2) || 1);
  if (itemId <= 0) return null;

  const info = getItemById(itemId);
  return {
    itemId,
    itemCount: count,
    count,
    itemName: (info && info.name) || `物品${itemId}`,
    name: (info && info.name) || `物品${itemId}`,
    image: getItemImageById(itemId) || '',
  };
}

function getSubActivityKey(activity) {
  const id = toNum(activity?.id);
  const title = String(activity?.title || '');
  if (id === HELU_DRAW_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.giftLotus;
  if (id === HELU_EXCHANGE_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.shop;
  if (id === HELU_JOURNEY_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.journey;
  if (id === HELU_NOTES_ACTIVITY_ID) return HELU_SUB_ACTIVITY_KEYS.notes;
  if (/奇遇礼莲/.test(title)) return HELU_SUB_ACTIVITY_KEYS.giftLotus;
  if (/荷露商店/.test(title)) return HELU_SUB_ACTIVITY_KEYS.shop;
  if (/荷风游记/.test(title)) return HELU_SUB_ACTIVITY_KEYS.journey;
  if (/节令小札/.test(title)) return HELU_SUB_ACTIVITY_KEYS.notes;
  return '';
}

function summarizeActivityPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 8)
    .map(([key, value]) => ({
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
    }));
}

function normalizeHeluSubActivities(activities) {
  const byKey = new Map();
  for (const activity of activities || []) {
    const key = getSubActivityKey(activity);
    if (!key || byKey.has(key)) continue;
    const payload = parsePayload(activity?.payload);
    byKey.set(key, {
      key,
      id: toNum(activity?.id),
      parentId: toNum(activity?.parent_id ?? activity?.parentId),
      title: String(activity?.title || ''),
      type: toNum(activity?.type),
      sort: toNum(activity?.sort),
      status: toNum(activity?.status),
      visible: activity?.visible !== false,
      enabled: activity?.enabled !== false,
      startTime: toNum(activity?.start_time ?? activity?.startTime),
      endTime: toNum(activity?.end_time ?? activity?.endTime),
      payload,
      payloadSummary: summarizeActivityPayload(payload),
      hasDraw: !!(activity?.draw_info || activity?.drawInfo),
      hasExchangeShop: !!(activity?.exchange_shop || activity?.exchangeShop),
      source: 'activity_tree',
    });
  }

  return HELU_SUB_ACTIVITY_DEFS.map((def) => {
    const found = byKey.get(def.key);
    return {
      ...def,
      id: found?.id || 0,
      parentId: found?.parentId || 0,
      type: found?.type || 0,
      sort: found?.sort || 0,
      status: found?.status || 0,
      visible: found?.visible ?? true,
      enabled: found?.enabled ?? true,
      startTime: found?.startTime || 0,
      endTime: found?.endTime || 0,
      payload: found?.payload || null,
      payloadSummary: found?.payloadSummary || [],
      hasDraw: found?.hasDraw || def.key === HELU_SUB_ACTIVITY_KEYS.giftLotus,
      hasExchangeShop: found?.hasExchangeShop || def.key === HELU_SUB_ACTIVITY_KEYS.shop,
      available: !!found || def.key === HELU_SUB_ACTIVITY_KEYS.giftLotus || def.key === HELU_SUB_ACTIVITY_KEYS.shop,
      source: found?.source || 'configured',
    };
  });
}

/**
 * 标准化活动物品
 */
function normalizeActivityItem(raw) {
  if (!raw) return null;
  const decoded = decodeItemHex(raw) || raw;
  const itemId = toNum(getField(decoded, 'id', 'field_1', 1));
  const count = Math.max(0, toNum(getField(decoded, 'count', 'field_2', 2)) || 1);
  if (itemId <= 0) return null;

  const info = getItemById(itemId);
  const image = getItemImageById(itemId) || '';

  return {
    itemId,
    count,
    name: (info && info.name) || `物品${itemId}`,
    image,
  };
}

function normalizeDrawPoolItem(raw) {
  const item = normalizeActivityItem(getField(raw, 'item', 'field_3', 3));
  if (!item) return null;
  return {
    id: toNum(getField(raw, 'id', 'field_1', 1)),
    rarity: toNum(getField(raw, 'rarity', 'field_2', 2)),
    itemId: item.itemId,
    itemCount: item.count,
    itemName: item.name,
    image: item.image || '',
    probability: String(getField(raw, 'probability', 'field_6', 6) || ''),
  };
}

function normalizeDrawReward(raw) {
  const item = normalizeActivityItem(getField(raw, 'item', 'field_2', 2));
  if (!item) return null;
  return {
    slotId: toNum(getField(raw, 'slot_id', 'slotId', 'field_1', 1)),
    rarityFlag: toNum(getField(raw, 'flag', 'field_4', 4)),
    itemId: item.itemId,
    itemCount: item.count,
    itemName: item.name,
    image: item.image || '',
  };
}

function normalizeDrawInfo(raw) {
  if (!raw) return null;

  const freeMax = toNum(getField(raw, 'max_free_count', 'maxFreeCount', 'field_2', 2)) || 4;
  const paidMax = toNum(getField(raw, 'max_paid_count', 'maxPaidCount', 'field_4', 4)) || 4;
  const freeRemainingRaw = getField(raw, 'free_remaining_count', 'freeRemainingCount', 'field_1', 1);
  const paidRemainingRaw = getField(raw, 'paid_remaining_count', 'paidRemainingCount', 'free_used_count', 'freeUsedCount', 'field_3', 3);
  const hasFreeRemaining = freeRemainingRaw !== undefined;
  const hasPaidRemaining = paidRemainingRaw !== undefined;
  const freeRemaining = Math.max(0, Math.min(freeMax,
    hasFreeRemaining ? toNum(freeRemainingRaw) : hasPaidRemaining ? 0 : freeMax
  ));
  // 抓包显示：field_3 是点券剩余次数；点券 4 次全部用完后 field_3 会直接省略。
  // 初始配置也会省略 field_3，但此时免费次数未用完，所以仍应展示点券上限。
  const paidRemaining = Math.max(0, Math.min(paidMax,
    hasPaidRemaining ? toNum(paidRemainingRaw) : freeRemaining <= 0 ? 0 : paidMax
  ));
  const freeUsed = Math.max(0, freeMax - freeRemaining);
  const paidUsed = Math.max(0, paidMax - paidRemaining);
  const paidCurrencyId = toNum(getField(raw, 'paid_currency_id', 'paidCurrencyId', 'field_5', 5)) || 1002;
  const paidPrice = toNum(getField(raw, 'paid_price', 'paidPrice', 'field_6', 6)) || 30;
  const fallbackPrice = toNum(getField(raw, 'fallback_price', 'fallbackPrice', 'field_7', 7)) || paidPrice;
  const rewardPoolRaw = getField(raw, 'rewards', 'field_8', 8);
  const rewardPool = (Array.isArray(rewardPoolRaw) ? rewardPoolRaw : [])
    .map(normalizeDrawPoolItem)
    .filter(Boolean);

  return {
    freeMax,
    freeUsed,
    freeRemaining,
    paidMax,
    paidUsed,
    paidRemaining,
    paidCurrencyId,
    paidPrice,
    fallbackPrice,
    rewardPool,
    _hasFreeRemaining: hasFreeRemaining,
    _hasPaidRemaining: hasPaidRemaining,
  };
}

function normalizeDrawResult(raw) {
  if (!raw) return null;
  const rewardsRaw = getField(raw, 'rewards', 'field_1', 1);
  const itemsRaw = getField(raw, 'items', 'field_2', 2);
  const costRaw = getField(raw, 'cost', 'field_3', 3);
  return {
    rewards: (Array.isArray(rewardsRaw) ? rewardsRaw : [])
      .map(normalizeDrawReward)
      .filter(Boolean),
    items: (Array.isArray(itemsRaw) ? itemsRaw : [])
      .map(normalizeActivityItem)
      .filter(Boolean),
    cost: normalizeActivityItem(costRaw),
  };
}

/**
 * 标准化随机商店单品
 */
function normalizeRandomShopItem(raw) {
  const item = normalizeActivityItem(raw?.item);
  const cost = normalizeActivityItem(raw?.cost);
  if (!item) return null;

  const name = String(raw?.name || item.name || '').trim() || item.name;
  const stockCount = toNum(raw?.stock_count ?? raw?.stockCount ?? raw?.limit_count ?? raw?.limitCount);
  const boughtCount = toNum(raw?.bought_count ?? raw?.boughtCount);
  const hasStock = stockCount > 0;
  const isSpecial = !!raw?.special;
  const noStock = !isSpecial;
  const soldOut = isSpecial && hasStock && boughtCount >= stockCount;
  const purchasable = isSpecial && hasStock && !soldOut;
  const remainingCount = purchasable ? Math.max(0, stockCount - boughtCount) : 0;

  return {
    id: toNum(raw?.id),
    name,
    itemId: item.itemId,
    itemCount: item.count,
    itemName: item.name,
    image: item.image || '',
    currencyId: cost?.itemId || 1001,
    price: cost?.count || 0,
    priceUnitId: cost?.itemId || 1001,
    stockCount,
    boughtCount,
    remainingCount,
    special: !!raw?.special,
    stockStatus: noStock ? 'no_stock' : soldOut ? 'sold_out' : 'available',
    noStock,
    soldOut,
    purchasable,
    statusLabel: noStock ? '无库存' : soldOut ? '售罄' : purchasable ? '可购买' : '不可购买',
    source: 'random',
  };
}

/**
 * 标准化随机商店信息
 */
function normalizeRandomShopInfo(raw) {
  if (!raw) return null;

  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .map(normalizeRandomShopItem)
    .filter(Boolean);

  return {
    items,
    nextRefreshTime: toNum(raw?.next_refresh_time ?? raw?.nextRefreshTime),
    manualRefreshCost: toNum(raw?.manual_refresh_cost ?? raw?.manualRefreshCost),
    manualRefreshCurrencyId: toNum(raw?.manual_refresh_currency_id ?? raw?.manualRefreshCurrencyId),
    manualRefreshExtraValue: toNum(
      raw?.manual_refresh_extra_value ??
      raw?.manualRefreshExtraValue ??
      raw?.fallback_refresh_cost ??
      raw?.fallbackRefreshCost ??
      raw?.manual_refresh_count ??
      raw?.manualRefreshCount ??
      0
    ),
    maxManualRefreshCount: 6,
    manualRefreshUsedCount: toNum(raw?.manual_refresh_used_count ?? raw?.manualRefreshUsedCount),
  };
}

/**
 * 标准化兑换商店单品
 */
function normalizeExchangeShopItem(raw) {
  if (!raw) return null;

  const item = normalizeActivityItem(raw?.item);
  const cost = normalizeActivityItem(raw?.cost);
  if (!item) return null;

  const itemInfo = getItemById(item.itemId) || {};
  const itemType = toNum(itemInfo.type);
  const interactionType = String(itemInfo.interaction_type || itemInfo.interactionType || '');
  const name = String(raw?.name || item.name || '').trim() || item.name;
  const status = toNum(raw?.status);
  const owned = raw?.owned === true;
  const isRepeatable = itemType === 7 || interactionType === 'fertilizer' || interactionType === 'fertilizerpro';
  const exchangeLimit = isRepeatable && status > 1 ? status : 0;
  const ownedBlocksExchange = owned && !isRepeatable;
  const isDecoration = itemType === 18
    || /装扮/.test(String(itemInfo.desc || ''))
    || /装扮/.test(String(itemInfo.effectDesc || ''))
    || /(?:小屋|街道|狗屋|木牌|仓库|栅栏|围栏|头像框)$/.test(name)
    || name.startsWith('枕水听荷');

  return {
    id: toNum(raw?.id),
    sort: toNum(raw?.sort),
    status,
    owned,
    isRepeatable,
    exchangeLimit,
    ownedBlocksExchange,
    statusLabel: ownedBlocksExchange
      ? '已拥有'
      : status === 1 || exchangeLimit > 0
        ? '可兑换'
        : status === 5
          ? '特殊商品'
          : status === 120 || status === 130
            ? '可兑换'
            : `状态${status}`,
    name,
    itemId: item.itemId,
    itemCount: item.count,
    itemName: name,
    image: item.image || '',
    itemType,
    itemTypeLabel: isDecoration ? '装扮' : itemType === 7 ? '道具' : `类型${itemType || 0}`,
    isDecoration,
    currencyId: cost?.itemId || 0,
    currencyName: cost?.name || '',
    price: cost?.count || 0,
    desc: String(getItemById(item.itemId)?.desc || getItemById(item.itemId)?.effectDesc || ''),
    extra: String(raw?.extra || ''),
  };
}

// ---- 活动树遍历 ----

function flattenActivityNode(node, result = []) {
  if (!node) return result;
  if (node.activity) {
    if (!node.activity.random_shop && node.random_shop) node.activity.random_shop = node.random_shop;
    if (!node.activity.exchange_shop && node.exchange_shop) node.activity.exchange_shop = node.exchange_shop;
    if (!node.activity.draw_info && node.draw_info) node.activity.draw_info = node.draw_info;
    result.push(node.activity);
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    flattenActivityNode(child, result);
  }
  return result;
}

function flattenActivityChildren(reply) {
  const list = flattenActivityNode(reply?.group, []);
  for (const group of Array.isArray(reply?.groups) ? reply.groups : []) {
    flattenActivityNode(group, list);
  }
  if (Array.isArray(reply?.activities)) list.push(...reply.activities);
  return list.filter(Boolean);
}

// ---- 原始 Protobuf 扫描（回退方案） ----

function skipUnknown(reader, wireType) {
  try {
    reader.skipType(wireType);
  } catch {
    reader.pos = reader.len;
  }
}

/**
 * 扫描长度分隔字段
 */
function scanLengthDelimitedFields(rawBytes, targetFieldNum, maxDepth = 3, results = []) {
  const buf = Buffer.from(rawBytes || []);
  if (buf.length === 0 || maxDepth <= 0) return results;

  const reader = protobuf.Reader.create(buf);
  while (reader.pos < reader.len) {
    let tag = 0;
    try {
      tag = reader.uint32();
    } catch {
      break;
    }
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;

    if (wireType === 2) {
      let bytes = null;
      try {
        bytes = reader.bytes();
      } catch {
        break;
      }
      if (fieldNum === targetFieldNum) results.push(Buffer.from(bytes));
      scanLengthDelimitedFields(bytes, targetFieldNum, maxDepth - 1, results);
      continue;
    }

    skipUnknown(reader, wireType);
  }
  return results;
}

/**
 * 从原始 body 中扫描随机商店信息
 */
function scanRandomShopInfoFromRawBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return null;

  const RandomShopInfo = types.ActivityRandomShopInfo;
  if (!RandomShopInfo) return null;

  let best = null;
  const seen = new Set();

  for (const chunk of scanLengthDelimitedFields(rawBody, 7)) {
    try {
      const decoded = RandomShopInfo.decode(chunk);
      const normalized = normalizeRandomShopInfo(decoded);
      if (!normalized || normalized.items.length === 0) continue;

      const deduped = [];
      for (const item of normalized.items) {
        if (!item) continue;
        const key = `${item.id}:${item.itemId}:${item.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }

      normalized.items = deduped;

      if (!best || normalized.items.length > best.items.length) {
        best = normalized;
      }
    } catch {
      // 跳过解码失败的块
    }
  }

  return best;
}

/**
 * 从原始 body 中扫描兑换商店信息
 */
function scanExchangeShopInfoFromRawBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return null;

  const ExchangeShopInfo = types.ActivityExchangeShopInfo;
  if (!ExchangeShopInfo) return null;

  let best = null;
  const seen = new Set();

  for (const chunk of scanLengthDelimitedFields(rawBody, 102)) {
    try {
      const decoded = ExchangeShopInfo.decode(chunk);
      const items = (Array.isArray(decoded?.items) ? decoded.items : [])
        .map(normalizeExchangeShopItem)
        .filter(Boolean);
      if (items.length === 0) continue;

      const deduped = [];
      for (const item of items) {
        const key = `${item.id}:${item.itemId}:${item.currencyId}:${item.price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }

      const normalized = {
        items: deduped.sort((a, b) => {
          if (a.sort !== b.sort) return a.sort - b.sort;
          return a.id - b.id;
        }),
      };

      if (!best || normalized.items.length > best.items.length) best = normalized;
    } catch {
      // skip
    }
  }

  return best;
}

function scanDrawInfoFromRawBody(rawBody) {
  if (!rawBody || rawBody.length === 0) return null;

  const DrawInfo = types.ActivityDrawInfo;
  if (!DrawInfo) return null;

  let best = null;
  for (const chunk of scanLengthDelimitedFields(rawBody, 105)) {
    try {
      const decoded = DrawInfo.decode(chunk);
      const normalized = normalizeDrawInfo(decoded);
      if (!normalized || normalized.rewardPool.length === 0) continue;
      if (!best || normalized.rewardPool.length > best.rewardPool.length) best = normalized;
    } catch {
      // skip
    }
  }
  return best;
}

function getHeluActivityUidCandidates() {
  return [HELU_ACTIVITY_UID, 'SAIJI_DRAW', 'SaiJi', 'HeLu', 'Helu', ''];
}

async function getActivityGroupWithUidFallback(activityId, uidCandidates) {
  let lastErr = null;
  for (const uid of uidCandidates) {
    try {
      const reply = await getActivityGroup(activityId, uid);
      const activities = flattenActivityChildren(reply);
      if (activities.length > 0) {
        Object.defineProperty(reply, '__activityUid', {
          value: uid,
          enumerable: false,
          configurable: true,
        });
        return reply;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return getActivityGroup(activityId, uidCandidates[0]);
}

async function getHeluBalance() {
  try {
    const bag = await getBag();
    const items = getBagItems(bag);
    for (const item of items || []) {
      if (toNum(item?.id) === HELU_CURRENCY_ITEM_ID) {
        return Math.max(0, toNum(item?.count));
      }
    }
  } catch {
    // ignore
  }
  return 0;
}

async function getBagItemCount(itemId) {
  try {
    const bag = await getBag();
    return (getBagItems(bag) || [])
      .filter(entry => toNum(entry?.id) === toNum(itemId))
      .reduce((sum, item) => sum + Math.max(0, toNum(item?.count)), 0);
  } catch {
    return 0;
  }
}

async function getQingmeiWineMaterialItems() {
  const bag = await getBag();
  return (getBagItems(bag) || [])
    .map(item => ({
      id: toNum(item?.id),
      uid: toNum(item?.uid),
      count: Math.max(0, toNum(item?.count)),
      mutantType: Array.isArray(item?.mutant_types) && item.mutant_types.length
        ? Math.min(...item.mutant_types.map(toNum).filter(value => value > 0))
        : 0,
    }))
    .filter(item => item.id === QINGMEI_FRUIT_ITEM_ID && item.uid > 0 && item.count > 0)
    .sort((a, b) => {
      const aOrder = a.mutantType > 0 ? a.mutantType : Number.MAX_SAFE_INTEGER;
      const bOrder = b.mutantType > 0 ? b.mutantType : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.uid - b.uid;
    })
    .map(item => ({
      id: item.uid,
      count: item.count,
    }));
}

let qingmeiActivityIdsCache = null;

function collectQingmeiActivityNodes(nodes, result = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.activity && /青梅|青酿/.test(String(node?.activity?.title || ''))) {
      result.push(node);
    }
    if (Array.isArray(node?.children)) collectQingmeiActivityNodes(node.children, result);
  }
  return result;
}

async function resolveQingmeiActivityIds() {
  if (qingmeiActivityIdsCache) return qingmeiActivityIdsCache;
  const fallback = {
    rootId: QINGMEI_ACTIVITY_ID,
    claimId: QINGMEI_SEED_CLAIM_ACTIVITY_ID,
    wineId: QINGMEI_WINE_ACTIVITY_ID,
  };
  try {
    const listed = await listActivityGroups();
    const nodes = collectQingmeiActivityNodes(listed?.groups);
    if (nodes.length === 0) {
      qingmeiActivityIdsCache = fallback;
      return qingmeiActivityIdsCache;
    }
    nodes.sort((a, b) => toNum(a?.activity?.id) - toNum(b?.activity?.id));
    const rootId = toNum(nodes[0]?.activity?.id) || fallback.rootId;
    let claimId = fallback.claimId;
    let wineId = fallback.wineId;
    if (nodes.length >= 3) {
      claimId = toNum(nodes[1]?.activity?.id) || fallback.claimId;
      wineId = toNum(nodes[2]?.activity?.id) || fallback.wineId;
    } else if (nodes.length === 2) {
      wineId = toNum(nodes[1]?.activity?.id) || fallback.wineId;
    }
    const rootNode = nodes.find(n => Array.isArray(n?.children) && n.children.length > 0);
    if (rootNode) {
      const childNodes = collectQingmeiActivityNodes(rootNode.children);
      if (childNodes.length >= 2) {
        childNodes.sort((a, b) => toNum(a?.activity?.id) - toNum(b?.activity?.id));
        claimId = toNum(childNodes[0]?.activity?.id) || claimId;
        wineId = toNum(childNodes[childNodes.length - 1]?.activity?.id) || wineId;
      }
    }
    qingmeiActivityIdsCache = { rootId, claimId, wineId };
    return qingmeiActivityIdsCache;
  } catch {
    qingmeiActivityIdsCache = fallback;
    return qingmeiActivityIdsCache;
  }
}

function normalizeQingmeiActivity(reply, ids = null) {
  const rootId = ids?.rootId || QINGMEI_ACTIVITY_ID;
  const claimId = ids?.claimId || QINGMEI_SEED_CLAIM_ACTIVITY_ID;
  const wineId = ids?.wineId || QINGMEI_WINE_ACTIVITY_ID;
  const activities = flattenActivityChildren(reply);
  const root = reply?.group?.activity || activities.find(item => toNum(item?.id) === rootId) || {};
  const claim = activities.find(item => toNum(item?.id) === claimId) || {};
  const wine = activities.find(item => toNum(item?.id) === wineId) || {};
  const status = toNum(claim?.status);
  const claimedToday = isQingmeiClaimedToday();
  const materialInfo = getItemById(QINGMEI_FRUIT_ITEM_ID);

  return {
    uid: reply?.__activityUid || QINGMEI_ACTIVITY_UID,
    title: '青梅酿万金',
    activityId: toNum(root?.id) || rootId,
    claimActivityId: toNum(claim?.id) || claimId,
    claimCommand: QINGMEI_SEED_CLAIM_CMD,
    wineActivityId: toNum(wine?.id) || wineId,
    wineTitle: wine?.title || '青酿换万金',
    winePreviewCommand: QINGMEI_WINE_PREVIEW_CMD,
    wineBrewCommand: QINGMEI_WINE_BREW_CMD,
    wineSellCommand: QINGMEI_WINE_SELL_CMD,
    startTime: toNum(root?.start_time ?? root?.startTime ?? claim?.start_time ?? claim?.startTime),
    endTime: toNum(root?.end_time ?? root?.endTime ?? claim?.end_time ?? claim?.endTime),
    status,
    claimed: claimedToday || status === 3,
    claimable: !claimedToday && status !== 3 && claim?.enabled !== false,
    reward: {
      itemId: QINGMEI_SEED_ITEM_ID,
      itemCount: QINGMEI_SEED_REWARD_COUNT,
      itemName: getItemById(QINGMEI_SEED_ITEM_ID)?.name || '青梅种子',
      image: getItemImageById(QINGMEI_SEED_ITEM_ID) || '',
    },
    material: {
      itemId: QINGMEI_FRUIT_ITEM_ID,
      itemCount: 0,
      itemName: materialInfo?.name || '青梅',
      image: getItemImageById(QINGMEI_FRUIT_ITEM_ID) || '',
    },
    payload: parsePayload(root?.payload || wine?.payload || claim?.payload),
  };
}

const QINGMEI_RULES = {
  title: '活动说明',
  paragraphs: [
    '1. 活动期间，每日可在「青梅」页面领取 24 颗青梅种子（领取后需种植并收获才能参与酿造）。',
    '2. 酿造流程：选择青梅投入（默认 1 颗，可调整数量）→ 开始酿造 → 逐轮查看报价（点击继续酿造） → 合适时机点击「分享出售」结算（分享后享受约 1.5 倍价格）。',
    '3. 保底价格：酿造未报价前显示保底单价，若报价未达预期可等待后续轮次；报价可能随轮次上涨或下跌。',
    '4. 同一时间仅可进行一笔酿造，建议在高报价轮次及时出售锁定收益。',
  ],
};

async function queryQingMeiBrewState(ids) {
  try {
    const reply = await operateQingMeiNew(types.QueryActivityRequest, {
      activity_id: String(ids.wineId),
      operate_type: QUERY_QINGMEI_OPERATE_TYPE,
    });
    return reply?.data?.qingmei_brew || null;
  } catch {
    return null;
  }
}

async function getQingmeiActivity() {
  const ids = await resolveQingmeiActivityIds();
  const balance = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID).catch(() => null);
  // 用新协议 query 获取完整状态（对齐 master 的 queryQingMeiReply）
  try {
    const reply = await queryQingMeiBrewStateInternal(ids);
    if (reply && reply.data) {
      return qingmeiDtoFromReply({ data: reply }, ids, balance);
    }
  } catch (_) { /* ignore */ }
  // fallback：兜底返回 DTO（空状态 + 已知余额）
  const fallback = qingmeiDtoFromReply({}, ids, balance);
  try {
    const [groupReply, brewState] = await Promise.all([
      getActivityGroupWithUidFallback(ids.rootId, [QINGMEI_ACTIVITY_UID, '']).catch(() => null),
      queryQingMeiBrewState(ids).catch(() => null),
    ]);
    if (groupReply) {
      const normalized = normalizeQingmeiActivity(groupReply, ids);
      fallback.claimed = !!normalized.claimed || fallback.claimed;
      fallback.claimable = !!normalized.claimable || fallback.claimable;
      fallback.startTime = normalized.startTime || fallback.startTime;
      fallback.endTime = normalized.endTime || fallback.endTime;
    }
    if (brewState) {
      fallback.currentRound = toNum(brewState.current_round);
      fallback.maxRounds = toNum(brewState.max_rounds) || QINGMEI_FINE_BREW_STEPS;
      fallback.started = toNum(brewState.base_gold) > 0 || (Array.isArray(brewState.quote_prices) && brewState.quote_prices.length > 0) || !!brewState.finished;
      fallback.baseGold = String(toNum(brewState.base_gold));
      fallback.basePrice = String(toNum(brewState.base_price));
      fallback.guaranteedPrice = String(toNum(brewState.guaranteed_price));
      fallback.quotePrices = (Array.isArray(brewState.quote_prices) ? brewState.quote_prices : []).map(v => String(toNum(v)));
      fallback.quoteTotals = (Array.isArray(brewState.quote_totals) ? brewState.quote_totals : []).map(v => String(toNum(v)));
      fallback.finished = !!brewState.finished;
      if (fallback.actions) {
        fallback.actions.continue.enabled = fallback.currentRound < fallback.maxRounds && !fallback.finished && toNum(brewState.base_gold) > 0;
        fallback.actions.continue.available = fallback.actions.continue.enabled;
        fallback.actions.settle.enabled = fallback.currentRound >= fallback.maxRounds && toNum(brewState.base_gold) > 0;
        fallback.actions.settle.available = fallback.actions.settle.enabled;
      }
    }
    return fallback;
  } catch (err) {
    fallback.warning = err?.message || String(err);
    return fallback;
  }
}

// 对齐 master 的 queryQingMeiReply：用 QueryActivityRequest 查询酿造活动完整 data（activity + qingmei_brew + qingmei_daily_seed）
async function queryQingMeiBrewStateInternal(ids) {
  const reply = await operateQingMeiNew(types.QueryActivityRequest, {
    activity_id: String(ids.wineId),
    operate_type: QUERY_QINGMEI_OPERATE_TYPE,
  });
  return reply?.data || null;
}

async function claimQingmeiSeeds() {
  return serializeMutation(async () => {
    const ids = await resolveQingmeiActivityIds();
    let reply = null;
    let alreadyClaimed = false;
    try {
      reply = await operateQingMeiNew(
        types.ClaimQingMeiDailySeedRequest,
        {
          activity_id: String(ids.claimId),
          operate_type: CLAIM_QINGMEI_SEED_OPERATE_TYPE,
          params: { grant_id: String(QINGMEI_DAILY_GRANT_ID) },
        },
        [QINGMEI_DAILY_ALREADY_CLAIMED_CODE],
      );
    } catch (err) {
      if (!(err instanceof GatewayError) || Number(err.code) !== QINGMEI_DAILY_ALREADY_CLAIMED_CODE) {
        throw err;
      }
      alreadyClaimed = true;
    }
    qingMeiSeedClaimedDateKey = beijingDateKey();
    const rewards = (Array.isArray(reply?.rewards) ? reply.rewards : []).map(normalizeCoreItem).filter(i => i.itemId > 0);
    // 对齐 master：不二次查询背包比较，直接从响应获取状态
    const balance = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID).catch(() => 0);
    const after = reply && Object.keys(reply).length > 0 ? reply : null;
    const qingmei = after ? qingmeiDtoFromReply(after, ids, balance) : await getQingmeiActivity().catch(() => null);
    activityLogger.info('领取青梅种子完成（新协议）', {
      event: 'qingmei_seed_claim',
      alreadyClaimed,
      rewardCount: rewards.length,
    });
    return {
      ok: true,
      alreadyClaimed,
      message: alreadyClaimed ? '今日青梅种子已经领取，无需重复领取' : '青梅种子领取成功',
      claimedCount: rewards.filter(r => r.itemId === QINGMEI_SEED_ITEM_ID).reduce((s, r) => s + (r.itemCount || r.count || 0), 0) || (alreadyClaimed ? 0 : QINGMEI_SEED_REWARD_COUNT),
      rewards,
      qingmei,
    };
  });
}

async function brewAndSellQingmeiWine(options = {}) {
  const ids = await resolveQingmeiActivityIds();
  const wineActivityId = String(ids.wineId);
  const share = options?.share !== false;
  const brewSteps = Math.max(1, Number(options?.brewSteps) || QINGMEI_FINE_BREW_STEPS);
  const brewIngredients = await getQingMeiBrewIngredients();
  const beforeMaterialCount = brewIngredients.reduce((sum, item) => sum + Math.max(0, toNum(item?.count)), 0);
  if (beforeMaterialCount <= 0) {
    throw createQingmeiWineError('material', '青梅不足，无法精酿');
  }

  let startWarning = '';
  // 步骤 1：StartQingMeiBrew（投入青梅，必须带 uid）
  const firstIngredient = brewIngredients[0];
  const requestedCount = Math.max(1, Math.min(
    Math.floor(Number(options?.count) || 0),
    beforeMaterialCount,
  )) || Math.max(1, Math.min(toNum(firstIngredient?.count), beforeMaterialCount));
  const useCount = Math.max(1, Math.min(requestedCount, toNum(firstIngredient?.count) || beforeMaterialCount));
  let startReply = null;
  try {
    startReply = await operateQingMeiNew(types.StartQingMeiBrewRequest, {
      activity_id: wineActivityId,
      operate_type: START_QINGMEI_BREW_OPERATE_TYPE,
      params: {
        ingredient: {
          uid: String(firstIngredient.uid),
          count: String(useCount),
        },
      },
    });
  } catch (err) {
    if (isNoOngoingQingmeiBrewError(err) || err?.message?.includes('进行中') || extractErrorCode(err) === 0) {
      startWarning = `投入青梅: ${err?.message || String(err)}（继续已有酿造）`;
    } else {
      throw createQingmeiWineError('start', `青梅酿投入失败: ${err.message}`, err);
    }
  }
  await delay(QINGMEI_WINE_STEP_DELAY_MS);

  // 步骤 2：Continue（多轮报价）
  const quotes = [];
  let currentQuote = null;
  for (let index = 0; index < brewSteps; index += 1) {
    let contReply = null;
    try {
      contReply = await operateQingMeiNew(types.ContinueQingMeiBrewRequest, {
        activity_id: wineActivityId,
        operate_type: CONTINUE_QINGMEI_BREW_OPERATE_TYPE,
        params: {},
      });
    } catch (err) {
      if (index > 0) break;
      throw createQingmeiWineError('brew', `青梅酿第${index + 1}轮报价失败: ${err.message}`, err);
    }
    const q = contReply?.qingmei_quote || null;
    if (q) {
      currentQuote = {
        round: toNum(q.round),
        unitPrice: toNum(q.unit_price),
        totalGold: toNum(q.total_gold),
        doubled: !!q.doubled,
      };
      quotes.push(currentQuote);
    }
    await delay(QINGMEI_WINE_STEP_DELAY_MS);
  }

  const lastQuote = quotes[quotes.length - 1] || null;
  const brewStarted = !!(startReply?.qingmei_brew_started || lastQuote);
  if (!brewStarted) {
    throw createQingmeiWineError('brew', `精酿未返回有效结果，请稍后刷新重试`);
  }

  // 步骤 3：分享（可选）
  let shared = false;
  if (share) {
    try {
      await reportQingMeiActivityShare();
      shared = true;
    } catch (err) {
      // 分享上报非关键，失败不阻塞
    }
    await delay(HELU_DRAW_REFRESH_DELAY_MS);
  }

  // 步骤 4：Settle（结算售卖）
  let settleReply = null;
  try {
    settleReply = await operateQingMeiNew(types.SettleQingMeiBrewRequest, {
      activity_id: wineActivityId,
      operate_type: SELL_QINGMEI_BREW_OPERATE_TYPE,
      params: { settlement_mode: shared ? QINGMEI_SHARED_SETTLEMENT_MODE : 1 },
    });
  } catch (err) {
    throw createQingmeiWineError('sell', `青梅酿售卖结算失败: ${err.message}`, err);
  }
  const settlement = settleReply?.qingmei_settlement || null;
  const settleRewards = (Array.isArray(settleReply?.rewards) ? settleReply.rewards : []).map(normalizeCoreItem).filter(i => i.itemId > 0);
  const totalGold = toNum(settlement?.total_gold) || 0;
  if (totalGold <= 0 && settleRewards.length === 0) {
    throw createQingmeiWineError('sell', '售卖未返回金币收益，请稍后刷新活动状态');
  }
  await delay(HELU_DRAW_REFRESH_DELAY_MS);
  const afterMaterialCount = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID);

  activityLogger.info('青梅酿售卖完成（新协议）', {
    event: 'qingmei_wine_sell',
    beforeMaterialCount,
    afterMaterialCount,
    ingredientBatches: brewIngredients.length,
    quoteCount: quotes.length,
    shared,
    totalGold,
    settleRewardCount: settleRewards.length,
  });

  return {
    ok: true,
    beforeMaterialCount,
    afterMaterialCount,
    consumedCount: Math.max(0, beforeMaterialCount - afterMaterialCount),
    materialBatchCount: brewIngredients.length,
    preview: { price: toNum(startReply?.qingmei_brew_started?.base_gold) || 0 },
    previewWarning: startWarning,
    brews: quotes,
    brew: lastQuote || {
      wineType: 0,
      price: toNum(startReply?.qingmei_brew_started?.base_price) || 0,
      cost: 0,
      canDouble: false,
    },
    share: {
      canShare: true,
      shared,
      success: true,
    },
    sell: {
      multiple: shared ? 2 : 1,
      gold: totalGold,
      item: settleRewards[0] || null,
    },
    activity: await getHeluActivity().catch(() => null),
  };
}

// ===== 青酿分步操作 =====

// 从 operate 响应中直接提取青酿状态（对齐 master 的 qingMeiDto）
function qingmeiDtoFromReply(reply, ids, balance = null) {
  const activity = reply?.data?.activity;
  const brew = reply?.data?.qingmei_brew || {};
  const quote = reply?.qingmei_quote || reply?.data?.qingmei_quote || null;
  const dailySeed = reply?.data?.qingmei_daily_seed || null;
  const currentRound = toNum(brew.current_round);
  const started = toNum(brew.base_gold) > 0;
  const maxRounds = Math.max(1, toNum(brew.max_rounds) || QINGMEI_FINE_BREW_STEPS);
  const quotePrices = (Array.isArray(brew.quote_prices) ? brew.quote_prices : []).map(v => String(toNum(v)));
  const quoteTotals = (Array.isArray(brew.quote_totals) ? brew.quote_totals : []).map(v => String(toNum(v)));
  const materialInfo = getItemById(QINGMEI_FRUIT_ITEM_ID);
  const balStr = balance !== null ? String(balance) : null;
  const balNum = balance !== null ? Number(balance) || 0 : 0;
  // 优先使用内存缓存判断领取状态（beijing 日期），避免 query 状态延迟误显示
  const dailySeedClaimed = qingMeiSeedClaimedDateKey === beijingDateKey() || !!dailySeed?.claimed;
  // 动态解析活动说明（对齐 master 的 textContent），兜底硬编码规则
  const rulesFromExtra = parseActivityRules(activity?.extra);
  const rules = rulesFromExtra?.paragraphs?.length ? rulesFromExtra : QINGMEI_RULES;
  // grant 的奖励物品从 dailySeed.grant.item 取（对齐 master）
  let grantReward = null;
  if (dailySeed?.grant?.item) {
    const gItem = dailySeed.grant.item;
    const gId = toNum(gItem.item_id || gItem.itemId || gItem.id);
    const meta = gId > 0 ? getItemById(gId) : null;
    grantReward = {
      itemId: gId,
      itemCount: toNum(gItem.count),
      itemName: meta?.name || bytesToText(gItem.name) || '青梅种子',
      image: gId > 0 ? getItemImageById(gId) : '',
    };
  }
  if (!grantReward) {
    grantReward = {
      itemId: QINGMEI_SEED_ITEM_ID,
      itemCount: QINGMEI_SEED_REWARD_COUNT,
      itemName: getItemById(QINGMEI_SEED_ITEM_ID)?.name || '青梅种子',
      image: getItemImageById(QINGMEI_SEED_ITEM_ID) || '',
    };
  }
  const ingredientMeta = materialInfo || {};
  return {
    uid: QINGMEI_ACTIVITY_UID,
    title: '青梅酿万金',
    name: bytesToText(activity?.name) || '青酿换万金',
    activityId: String(toNum(activity?.activity_id) || String(ids.wineId)),
    dailyActivityId: String(ids.claimId),
    claimActivityId: ids.claimId,
    claimCommand: QINGMEI_SEED_CLAIM_CMD,
    wineActivityId: ids.wineId,
    wineTitle: '青酿换万金',
    startTime: toNum(activity?.begin_time) || undefined,
    endTime: toNum(activity?.end_time) || undefined,
    claimed: dailySeedClaimed,
    claimable: !dailySeedClaimed,
    reward: grantReward,
    material: {
      itemId: QINGMEI_FRUIT_ITEM_ID,
      itemCount: balNum,
      itemName: ingredientMeta.name || '青梅',
      image: getItemImageById(QINGMEI_FRUIT_ITEM_ID) || '',
    },
    ingredient: {
      id: String(QINGMEI_FRUIT_ITEM_ID),
      count: balStr || '0',
      name: ingredientMeta.name || '青梅',
      image: getItemImageById(QINGMEI_FRUIT_ITEM_ID) || '',
      rarity: Number(ingredientMeta.rarity) || 0,
      itemId: QINGMEI_FRUIT_ITEM_ID,
      itemCount: balNum,
      itemName: ingredientMeta.name || '青梅',
    },
    balance: balStr,
    balanceKnown: balance !== null,
    baseGold: String(toNum(brew.base_gold)),
    basePrice: String(toNum(brew.base_price)),
    guaranteedPrice: String(toNum(brew.guaranteed_price)),
    currentRound,
    started,
    maxRounds,
    finished: !!brew.finished,
    quotePrices,
    quoteTotals,
    quote: quote ? {
      round: toNum(quote.round),
      unitPrice: String(toNum(quote.unit_price)),
      totalGold: String(toNum(quote.total_gold)),
      doubled: !!quote.doubled,
    } : null,
    dailySeed: {
      claimed: dailySeedClaimed,
      grantId: dailySeed ? String(toNum(dailySeed?.grant?.grant_id) || QINGMEI_DAILY_GRANT_ID) : String(QINGMEI_DAILY_GRANT_ID),
      reward: grantReward,
      grant: { grantId: toNum(dailySeed?.grant?.grant_id) || QINGMEI_DAILY_GRANT_ID },
    },
    actions: {
      claimSeed: { enabled: !dailySeedClaimed, available: !dailySeedClaimed },
      start: {
        enabled: balance === null || balNum > 0,
        available: balance === null || balNum > 0,
      },
      continue: {
        enabled: currentRound < maxRounds && !brew.finished && toNum(brew.base_gold) > 0,
        available: currentRound < maxRounds && !brew.finished && toNum(brew.base_gold) > 0,
      },
      settle: {
        enabled: currentRound >= maxRounds && toNum(brew.base_gold) > 0,
        available: currentRound >= maxRounds && toNum(brew.base_gold) > 0,
      },
    },
    rules,
  };
}

async function startQingmeiBrew(options = {}) {
  return serializeMutation(async () => {
    const ids = await resolveQingmeiActivityIds();
    const wineActivityId = String(ids.wineId);
    const countText = String(Math.floor(Number(options?.count) || 0));
    if (!/^[1-9]\d*$/.test(countText)) {
      throw createQingmeiWineError('invalid_count', '投入数量必须是正整数');
    }
    const count = BigInt(countText);
    // 对齐 master：必须找到单个背包条目，该条目的 count >= inputCount
    const bagReply = await getBag();
    const candidates = getBagItems(bagReply).filter(item => toNum(item?.id) === QINGMEI_FRUIT_ITEM_ID);
    const item = candidates.find(entry => {
      const entryCount = BigInt(String(toNum(entry?.count) || '0'));
      return entryCount >= count;
    });
    if (!item) {
      throw createQingmeiWineError('material', '青梅数量不足，或数量分散在多个背包条目中');
    }
    let startReply = null;
    try {
      startReply = await operateQingMeiNew(types.StartQingMeiBrewRequest, {
        activity_id: wineActivityId,
        operate_type: START_QINGMEI_BREW_OPERATE_TYPE,
        params: {
          ingredient: { uid: String(item.uid), count: countText },
        },
      });
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (msg.includes('进行中') || msg.includes('已投入') || extractErrorCode(err) === 1034026) {
        startReply = startReply || {};
      } else {
        throw createQingmeiWineError('start', `青梅酿启动失败: ${err.message}`, err);
      }
    }
    const newBalance = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID).catch(() => 0);
    const qingmei = qingmeiDtoFromReply(startReply, ids, newBalance);
    activityLogger.info('青梅酿启动成功（新协议）', {
      event: 'qingmei_brew_start',
      count: countText,
    });
    return {
      ok: true,
      activity: qingmei,
      qingmei,
      count: countText,
      message: `已投入 ${countText} 个青梅开始酿造`,
    };
  });
}

async function continueQingmeiBrew(options = {}) {
  return serializeMutation(async () => {
    const ids = await resolveQingmeiActivityIds();
    const wineActivityId = String(ids.wineId);
    let contReply = null;
    try {
      contReply = await operateQingMeiNew(types.ContinueQingMeiBrewRequest, {
        activity_id: wineActivityId,
        operate_type: CONTINUE_QINGMEI_BREW_OPERATE_TYPE,
        params: {},
      });
    } catch (err) {
      throw createQingmeiWineError('continue', `青梅酿报价失败: ${err.message}`, err);
    }
    const q = contReply?.qingmei_quote || contReply?.data?.qingmei_quote || null;
    const quote = q ? {
      round: toNum(q.round),
      unitPrice: String(toNum(q.unit_price)),
      totalGold: String(toNum(q.total_gold)),
      doubled: !!q.doubled,
    } : null;
    const balance = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID).catch(() => 0);
    const qingmei = qingmeiDtoFromReply(contReply, ids, balance);
    return {
      ok: true,
      quote,
      snapshot: { qingMei: qingmei },
      qingmei,
      message: quote ? `第 ${quote.round} 轮报价：倍率 ${formatMultiplier(quote.unitPrice)}，共 ${formatGold(quote.totalGold)} 金币` : '酿造进度已更新',
    };
  });
}

/**
 * 一键酿造：自动循环 continue 直到完成全部轮次（默认3轮）
 * 适用于已启动酿造后，一次性跑完所有报价轮次
 */
async function autoBrewQingmei(options = {}) {
  return serializeMutation(async () => {
    const ids = await resolveQingmeiActivityIds();
    const wineActivityId = String(ids.wineId);

    activityLogger.info('一键酿造开始', {
      event: 'qingmei_auto_brew_start',
      wineActivityId,
    });

    // 先查询当前状态，确认已启动且未完成
    let stateReply = null;
    try {
      stateReply = await queryQingMeiBrewStateInternal(ids);
    } catch (err) {
      activityLogger.warn('一键酿造：查询初始状态失败', {
        event: 'qingmei_auto_brew_state_query_failed',
        error: err?.message || String(err),
      });
    }
    const initialBrew = stateReply?.data?.qingmei_brew || stateReply?.qingmei_brew || {};
    const maxRounds = Math.max(1, toNum(initialBrew.max_rounds) || QINGMEI_FINE_BREW_STEPS);
    const baseGold = toNum(initialBrew.base_gold);
    let currentRound = toNum(initialBrew.current_round);

    activityLogger.info('一键酿造：初始状态', {
      event: 'qingmei_auto_brew_initial',
      maxRounds,
      currentRound,
      baseGold,
      finished: !!initialBrew.finished,
    });

    if (baseGold <= 0) {
      activityLogger.warn('一键酿造中止：尚未启动酿造', {
        event: 'qingmei_auto_brew_not_started',
      });
      throw createQingmeiWineError('auto', '尚未启动青梅酿造，请先投入青梅');
    }
    if (currentRound >= maxRounds || initialBrew.finished) {
      // 已完成所有轮次，直接返回当前状态
      const balance = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID).catch(() => 0);
      const qingmei = qingmeiDtoFromReply(stateReply?.data ? { data: stateReply.data } : stateReply || {}, ids, balance);
      activityLogger.info('一键酿造：已完成全部轮次，无需继续', {
        event: 'qingmei_auto_brew_already_done',
        maxRounds,
        currentRound,
      });
      return {
        ok: true,
        quotes: [],
        completedRounds: 0,
        qingmei,
        snapshot: { qingMei: qingmei },
        message: `已完成全部 ${maxRounds} 轮酿造，可直接结算出售`,
      };
    }

    const remainRounds = Math.max(0, maxRounds - currentRound);
    const quotes = [];
    let lastReply = null;
    activityLogger.info('一键酿造：开始循环报价', {
      event: 'qingmei_auto_brew_loop_start',
      remainRounds,
      fromRound: currentRound + 1,
      toRound: maxRounds,
    });
    for (let i = 0; i < remainRounds; i += 1) {
      const roundIndex = i + 1;
      const expectedRound = currentRound + 1;
      activityLogger.info(`一键酿造：开始第 ${roundIndex}/${remainRounds} 次 continue（期望得到第 ${expectedRound} 轮报价）`, {
        event: 'qingmei_auto_brew_round_start',
        loopIndex: i,
        roundIndex,
        remainRounds,
        expectedRound,
      });

      let contReply = null;
      const roundStartTime = Date.now();
      try {
        contReply = await operateQingMeiNew(types.ContinueQingMeiBrewRequest, {
          activity_id: wineActivityId,
          operate_type: CONTINUE_QINGMEI_BREW_OPERATE_TYPE,
          params: {},
        });
      } catch (err) {
        const elapsedMs = Date.now() - roundStartTime;
        activityLogger.error(`一键酿造：第 ${roundIndex} 次 continue 失败`, {
          event: 'qingmei_auto_brew_round_failed',
          loopIndex: i,
          roundIndex,
          expectedRound,
          elapsedMs,
          error: err?.message || String(err),
          completedQuotes: quotes.length,
        });
        // 如果非首轮失败，保留已完成轮次，返回中间状态
        if (quotes.length > 0) break;
        throw createQingmeiWineError('auto', `一键酿造第${roundIndex}轮报价失败: ${err.message}`, err);
      }
      lastReply = contReply;
      const elapsedMs = Date.now() - roundStartTime;
      const q = contReply?.qingmei_quote || contReply?.data?.qingmei_quote || null;
      if (q) {
        const quoteData = {
          round: toNum(q.round),
          unitPrice: String(toNum(q.unit_price)),
          totalGold: String(toNum(q.total_gold)),
          doubled: !!q.doubled,
        };
        quotes.push(quoteData);
        currentRound = toNum(q.round);
        activityLogger.info(`一键酿造：第 ${roundIndex}/${remainRounds} 次 continue 完成`, {
          event: 'qingmei_auto_brew_round_done',
          loopIndex: i,
          roundIndex,
          returnedRound: quoteData.round,
          unitPrice: quoteData.unitPrice,
          totalGold: quoteData.totalGold,
          doubled: quoteData.doubled,
          elapsedMs,
          currentRound,
          maxRounds,
          progress: `${currentRound}/${maxRounds}`,
        });
      } else {
        activityLogger.warn(`一键酿造：第 ${roundIndex}/${remainRounds} 次 continue 无报价数据`, {
          event: 'qingmei_auto_brew_round_no_quote',
          loopIndex: i,
          roundIndex,
          elapsedMs,
          replyKeys: contReply ? Object.keys(contReply) : [],
        });
      }
      // 最后一轮不需要再 delay
      if (i < remainRounds - 1) {
        await delay(QINGMEI_WINE_STEP_DELAY_MS);
      }
    }

    const balance = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID).catch(() => 0);
    const qingmei = lastReply
      ? qingmeiDtoFromReply(lastReply, ids, balance)
      : stateReply?.data
        ? qingmeiDtoFromReply({ data: stateReply.data }, ids, balance)
        : qingmeiDtoFromReply({}, ids, balance);

    const lastQ = quotes[quotes.length - 1];
    activityLogger.info('一键酿造：全部完成', {
      event: 'qingmei_auto_brew_complete',
      totalRounds: maxRounds,
      completedRounds: quotes.length,
      finalRound: lastQ?.round || currentRound,
      finalTotalGold: lastQ?.totalGold,
      finalUnitPrice: lastQ?.unitPrice,
      quotesSummary: quotes.map(q => ({ round: q.round, totalGold: q.totalGold, unitPrice: q.unitPrice, doubled: q.doubled })),
      balance,
    });

    return {
      ok: true,
      quotes,
      completedRounds: quotes.length,
      totalRounds: maxRounds,
      qingmei,
      snapshot: { qingMei: qingmei },
      message: lastQ
        ? `一键酿造完成：共 ${quotes.length} 轮，最终报价 ${formatGold(lastQ.totalGold)} 金币（倍率 ${formatMultiplier(lastQ.unitPrice)}，第 ${lastQ.round}/${maxRounds} 轮）`
        : `一键酿造完成，已完成 ${quotes.length} 轮报价`,
    };
  });
}

async function settleQingmeiBrew(options = {}) {
  return serializeMutation(async () => {
    const ids = await resolveQingmeiActivityIds();
    const wineActivityId = String(ids.wineId);

    // 先检查状态：必须完成 3 轮酿造才能结算
    try {
      const stateReply = await queryQingMeiBrewStateInternal(ids);
      const brew = stateReply?.data?.qingmei_brew || stateReply?.qingmei_brew || {};
      const currentRound = toNum(brew.current_round);
      const maxRounds = Math.max(1, toNum(brew.max_rounds) || QINGMEI_FINE_BREW_STEPS);
      const baseGold = toNum(brew.base_gold);
      if (baseGold <= 0) {
        throw new Error('尚未启动青梅酿造，无法结算');
      }
      if (currentRound < maxRounds && !brew.finished) {
        throw new Error(`需要完成全部 ${maxRounds} 轮酿造后才能结算，当前第 ${currentRound}/${maxRounds} 轮`);
      }
    } catch (err) {
      if (err?.message?.includes('需要完成') || err?.message?.includes('尚未启动')) {
        throw err;
      }
      // 状态查询失败不阻断结算，继续尝试
    }

    // 对齐 master：先分享再结算，不 delay
    try {
      await reportQingMeiActivityShare();
    } catch (_) { /* non-critical */ }

    let settleReply = null;
    try {
      settleReply = await operateQingMeiNew(types.SettleQingMeiBrewRequest, {
        activity_id: wineActivityId,
        operate_type: SELL_QINGMEI_BREW_OPERATE_TYPE,
        params: { settlement_mode: QINGMEI_SHARED_SETTLEMENT_MODE },
      });
    } catch (err) {
      throw createQingmeiWineError('settle', `青梅酿结算失败: ${err.message}`, err);
    }
    const settlement = settleReply?.qingmei_settlement || null;
    const settlementReward = settlement?.reward ? [normalizeCoreItem(settlement.reward)].filter(i => i.itemId > 0) : [];
    const extraRewards = (Array.isArray(settleReply?.rewards) ? settleReply.rewards : []).map(normalizeCoreItem).filter(i => i.itemId > 0);
    const settleRewards = settlementReward.length > 0 ? settlementReward : extraRewards;
    const totalGold = toNum(settlement?.total_gold) || 0;
    const balance = await getBagItemCount(QINGMEI_FRUIT_ITEM_ID).catch(() => 0);
    const qingmei = qingmeiDtoFromReply(settleReply, ids, balance);

    activityLogger.info('青梅酿分步结算完成（新协议）', {
      event: 'qingmei_wine_settle',
      shared: true,
      totalGold,
      settleRewardCount: settleRewards.length,
    });

    return {
      ok: true,
      settlement: {
        mode: toNum(settlement?.settlement_mode) || QINGMEI_SHARED_SETTLEMENT_MODE,
        totalGold: String(totalGold),
      },
      shared: true,
      multiple: 2,
      gold: totalGold,
      rewards: settleRewards,
      snapshot: { qingMei: qingmei },
      qingmei,
      message: settlement
        ? `分享出售成功（1.5倍），获得 ${formatGold(totalGold)} 金币`
        : '青梅酿已按分享奖励出售（1.5倍）',
    };
  });
}

function computeHeluDrawActions(drawInfo) {
  const freeRemaining = Math.max(0, toNum(drawInfo?.freeRemaining));
  const paidRemaining = Math.max(0, toNum(drawInfo?.paidRemaining));
  const paidPrice = Math.max(0, toNum(drawInfo?.paidPrice));
  const paidCurrencyId = toNum(drawInfo?.paidCurrencyId) || 1002;

  const drawOneIsFree = freeRemaining > 0;
  const drawOnePaid = !drawOneIsFree && paidRemaining > 0;
  const drawOneCount = drawOneIsFree || drawOnePaid ? 1 : 0;

  let batchCount = 0;
  let batchCost = 0;
  let batchType = 'none';
  if (freeRemaining > 0) {
    batchCount = Math.min(4, freeRemaining);
    batchType = 'free';
  } else if (paidRemaining > 0) {
    batchCount = Math.min(4, paidRemaining);
    batchCost = batchCount * paidPrice;
    batchType = 'paid';
  }

  return {
    one: {
      count: drawOneCount,
      available: drawOneCount > 0,
      cost: drawOnePaid ? paidPrice : 0,
      currencyId: drawOnePaid ? paidCurrencyId : 0,
      type: drawOneIsFree ? 'free' : drawOnePaid ? 'paid' : 'none',
      label: drawOneIsFree ? '免费1次' : drawOnePaid ? `${paidPrice}点券1次` : '已抽完',
    },
    batch: {
      count: batchCount,
      available: batchCount > 0,
      cost: batchCost,
      currencyId: batchType === 'paid' ? paidCurrencyId : 0,
      type: batchType,
      label: batchType === 'free'
        ? `免费${batchCount}次`
        : batchType === 'paid'
          ? `${batchCost}点券${batchCount}次`
          : '已抽完',
    },
  };
}

function normalizeSeasonRewardTier(rawBytes) {
  const entries = readProtoFields(rawBytes);
  return {
    level: getProtoNumber(entries, 1),
    freeRewards: getProtoBytesAll(entries, 2).map(parseActivityItemMessage).filter(Boolean),
    premiumRewards: getProtoBytesAll(entries, 3).map(parseActivityItemMessage).filter(Boolean),
  };
}

function normalizeSeasonPassport(rawBytes, rewardItems = []) {
  const entries = readProtoFields(rawBytes);
  const currentLevel = getProtoNumber(entries, 2);
  const score = getProtoNumber(entries, 3);
  const currentProgress = getProtoNumber(entries, 4);
  const nextLevelNeed = getProtoNumber(entries, 5);
  const maxLevel = getProtoNumber(entries, 6);
  const freeClaimedLevel = getProtoNumber(entries, 9);
  const premiumClaimedLevel = getProtoNumber(entries, 11);
  const levelRewardTiers = getProtoBytesAll(entries, 8)
    .map(normalizeSeasonRewardTier)
    .filter((tier) => tier.level > 0);

  return {
    uid: HELU_PASSPORT_UID,
    title: getProtoString(entries, 16, '荷风游记'),
    activityId: getProtoNumber(entries, 1) || HELU_ACTIVITY_ID,
    currentLevel,
    score,
    currentProgress,
    nextLevelNeed,
    maxLevel,
    freeClaimedLevel,
    premiumClaimedLevel,
    claimableLevels: Math.max(0, currentLevel - freeClaimedLevel),
    rewardTierCount: levelRewardTiers.length,
    levelRewardTiers,
    rewards: rewardItems,
    configText: getProtoString(entries, 17, ''),
  };
}

function normalizeSeasonInfo(rawBody) {
  const replyEntries = readProtoFields(rawBody);
  const seasonBytes = getProtoBytes(replyEntries, 1);
  if (!seasonBytes) {
    return {
      uid: HELU_PASSPORT_UID,
      title: '荷风游记',
      currentLevel: 0,
      claimableLevels: 0,
      rewards: [],
      levelRewardTiers: [],
    };
  }

  const seasonEntries = readProtoFields(seasonBytes);
  const passportBytes = getProtoBytes(seasonEntries, 10);
  const passport = normalizeSeasonPassport(passportBytes, []);

  return {
    ...passport,
    seasonTitle: getProtoString(seasonEntries, 2, HELU_TITLE),
    seasonStatus: getProtoNumber(seasonEntries, 3),
    startTime: getProtoNumber(seasonEntries, 5),
    endTime: getProtoNumber(seasonEntries, 6),
    nowTime: getProtoNumber(seasonEntries, 7),
  };
}

function normalizeSeasonClaimResult(rawBody) {
  const entries = readProtoFields(rawBody);
  const rewards = getProtoBytesAll(entries, 1).map(parseActivityItemMessage).filter(Boolean);
  const passportBytes = getProtoBytes(entries, 3);
  return {
    rewards,
    passport: passportBytes ? normalizeSeasonPassport(passportBytes, rewards) : null,
  };
}

function solarStatusLabel(status) {
  if (status === 2) return '可领取';
  if (status === 3) return '已领取';
  if (status === 1) return '未开启';
  if (status === 5) return '已结束';
  return `状态${status}`;
}

function normalizeSolarTerm(rawBytes) {
  const entries = readProtoFields(rawBytes);
  const status = getProtoNumber(entries, 2);
  return {
    id: getProtoNumber(entries, 1),
    status,
    statusLabel: solarStatusLabel(status),
    claimable: status === 2,
    startTime: getProtoNumber(entries, 3),
    endTime: getProtoNumber(entries, 4),
    rewards: getProtoBytesAll(entries, 5).map(parseActivityItemMessage).filter(Boolean),
    title: getProtoString(entries, 6, ''),
  };
}

function normalizeSolarTermsInfo(rawBody) {
  const entries = readProtoFields(rawBody);
  const terms = getProtoBytesAll(entries, 1)
    .map(normalizeSolarTerm)
    .filter((term) => term.id > 0);
  const configEntries = readProtoFields(getProtoBytes(entries, 3));

  return {
    nowTime: getProtoNumber(entries, 2),
    terms,
    claimableCount: terms.filter((term) => term.claimable).length,
    currentTerm: terms.find((term) => term.claimable) || terms.find((term) => term.status === 3) || terms[0] || null,
    tipsText: getProtoString(configEntries, 3, ''),
  };
}

function normalizeSolarTermsClaimResult(rawBody) {
  const entries = readProtoFields(rawBody);
  const termBytes = getProtoBytes(entries, 2);
  return {
    rewards: getProtoBytesAll(entries, 1).map(parseActivityItemMessage).filter(Boolean),
    term: termBytes ? normalizeSolarTerm(termBytes) : null,
  };
}

async function getSeasonPassport() {
  return normalizeSeasonInfo(await getSeasonInfoRaw());
}

async function claimSeasonPassportRewards() {
  const before = await getSeasonPassport();
  const result = normalizeSeasonClaimResult(await claimSeasonRewardsRaw());
  const after = await getSeasonPassport();

  activityLogger.info('荷风游记领取成功', {
    event: 'season_passport_claim',
    beforeLevel: before.currentLevel,
    beforeClaimedLevel: before.freeClaimedLevel,
    afterLevel: after.currentLevel,
    afterClaimedLevel: after.freeClaimedLevel,
    rewardCount: result.rewards.length,
  });

  return {
    ok: true,
    rewards: result.rewards,
    passport: after,
    claimedLevels: Math.max(0, after.freeClaimedLevel - before.freeClaimedLevel),
  };
}

async function getSolarTermsInfo() {
  return normalizeSolarTermsInfo(await getSolarTermsRaw());
}

async function claimSolarTermsReward(termId = 0) {
  const before = await getSolarTermsInfo();
  const resolvedTermId = Number(termId) || toNum(before?.currentTerm?.id);
  if (resolvedTermId <= 0) throw new Error('未找到可领取的节令奖励');

  const target = (before.terms || []).find((term) => term.id === resolvedTermId) || null;
  if (target && !target.claimable) {
    throw new Error(`${target.title || '该节令'}当前不可领取`);
  }

  const result = normalizeSolarTermsClaimResult(await claimSolarTermsRaw(resolvedTermId));
  const after = await getSolarTermsInfo();

  activityLogger.info('节令小札领取成功', {
    event: 'solar_terms_claim',
    termId: resolvedTermId,
    termTitle: target?.title || result.term?.title || '',
    rewardCount: result.rewards.length,
  });

  return {
    ok: true,
    termId: resolvedTermId,
    rewards: result.rewards,
    term: result.term,
    solarTerms: after,
  };
}

function parseStarRecordExtra(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeStarRecord(node) {
  const info = node?.star_record || node?.starRecord || {};
  const configs = Array.isArray(info?.configs) ? info.configs : [];
  const states = new Map(
    (Array.isArray(info?.records) ? info.records : [])
      .map(record => [toNum(record?.id), record])
  );

  const records = configs.map((config) => {
    const id = toNum(config?.id);
    const state = states.get(id) || {};
    const extra = parseStarRecordExtra(config?.extra);
    return {
      id,
      title: String(config?.title || `星宿${id}`),
      category: String(extra?.category || ''),
      explain: String(extra?.explain || ''),
      graph: String(config?.graph || ''),
      featured: !!config?.featured,
      unlocked: !!state?.unlocked,
      claimed: !!state?.claimed,
      claimable: !!state?.unlocked && !state?.claimed,
      rewards: (state?.rewards || []).map(normalizeCoreItem).filter(item => item.itemId > 0),
    };
  });

  return {
    status: toNum(info?.status),
    openedDays: toNum(info?.opened_days ?? info?.openedDays),
    records,
    totalCount: records.length,
    unlockedCount: records.filter(record => record.unlocked).length,
    claimedCount: records.filter(record => record.claimed).length,
    claimableCount: records.filter(record => record.claimable).length,
  };
}

function findActivityNode(nodes, activityId) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (toNum(node?.activity?.id) === toNum(activityId)) return node;
    const child = findActivityNode(node?.children, activityId);
    if (child) return child;
  }
  return null;
}

async function getStarActivity() {
  if (!getUserState()) {
    return {
      uid: STAR_ACTIVITY_UID,
      title: '心许千灯星垂野',
      activityId: STAR_ACTIVITY_ID,
      starRecord: normalizeStarRecord(null),
      exchangeShop: [],
      starSandBalance: 0,
      passport: null,
      solarTerms: null,
      qingmei: null,
      warning: 'runtime connection is not open',
    };
  }

  const listed = await listActivityGroups();
  const rootNode = findActivityNode(listed?.groups, STAR_ACTIVITY_ID);
  const recordNode = findActivityNode(listed?.groups, STAR_RECORD_ACTIVITY_ID);
  if (!rootNode || !recordNode) {
    throw new Error('未在活动列表中找到“心许千灯星垂野”');
  }

  let shopItems = [];
  let shopWarning = '';
  try {
    const shopReply = await operateActivityReply(STAR_SHOP_ACTIVITY_ID, STAR_SHOP_OPEN_CMD);
    const shopNode = shopReply?.group || null;
    const shop = shopNode?.exchange_shop || shopNode?.exchangeShop || null;
    shopItems = (shop?.items || []).map(normalizeExchangeShopItem).filter(Boolean).map(item => ({
      ...item,
      currencyName: item.currencyId === STAR_SAND_ITEM_ID ? '星砂' : item.currencyName,
    }));
  } catch (err) {
    shopWarning = err?.message || String(err);
    activityLogger.error('getStarActivity shopOperate failed', {
      error: err?.message,
      stack: err?.stack?.split('\n').slice(0, 5).join(' | '),
    });
  }

  const currencyId = toNum(shopItems.find(item => item.currencyId > 0)?.currencyId) || STAR_SAND_ITEM_ID;
  const [passport, solarTerms, starSandBalance, qingmei] = await Promise.all([
    getSeasonPassport().catch(err => ({ title: '千星游记', warning: err?.message || String(err), claimableLevels: 0 })),
    getSolarTermsInfo().catch(err => ({ terms: [], claimableCount: 0, warning: err?.message || String(err) })),
    currencyId > 0 ? getBagItemCount(currencyId) : Promise.resolve(0),
    getQingmeiActivity().catch(err => {
      activityLogger.error('getQingmeiActivity failed in getStarActivity', {
        error: err?.message,
        stack: err?.stack?.split('\n').slice(0, 5).join(' | '),
      });
      return { warning: err?.message || String(err), claimed: false, claimable: false };
    }),
  ]);

  return {
    uid: STAR_ACTIVITY_UID,
    title: String(rootNode?.activity?.title || '心许千灯星垂野'),
    activityId: STAR_ACTIVITY_ID,
    recordActivityId: STAR_RECORD_ACTIVITY_ID,
    recordClaimCommand: STAR_RECORD_CLAIM_CMD,
    shopActivityId: STAR_SHOP_ACTIVITY_ID,
    shopOpenCommand: STAR_SHOP_OPEN_CMD,
    startTime: toNum(rootNode?.activity?.start_time),
    endTime: toNum(rootNode?.activity?.end_time),
    starRecord: normalizeStarRecord(recordNode),
    exchangeShop: shopItems,
    shopReadOnly: false,
    shopWarning,
    starSandCurrencyId: currencyId,
    starSandBalance,
    passport,
    solarTerms,
    qingmei,
    summary: {
      starCount: normalizeStarRecord(recordNode).totalCount,
      exchangeShopCount: shopItems.length,
    },
  };
}

async function claimStarRecordRewards() {
  assertActivityConnection('观星礼录领取');
  const before = await getStarActivity();
  if (before?.starRecord?.claimableCount <= 0) {
    throw new Error('当前没有可点亮或领取的星宿');
  }

  const reply = await operateActivityReply(STAR_RECORD_ACTIVITY_ID, STAR_RECORD_CLAIM_CMD);
  const result = reply?.star_record_claim || reply?.starRecordClaim || {};
  const recordIds = (result?.record_ids || result?.recordIds || []).map(toNum).filter(id => id > 0);
  const rewards = (result?.rewards || []).map(normalizeCoreItem).filter(item => item.itemId > 0);
  const after = await getStarActivity();

  activityLogger.info('观星礼录领取成功', {
    event: 'star_record_claim',
    recordIds,
    rewardCount: rewards.length,
  });

  return {
    ok: true,
    recordIds,
    rewards,
    activity: after,
  };
}

async function exchangeStarShopItem(slotId, count = 1) {
  const slotIdNum = Number(slotId) || 0;
  if (slotIdNum <= 0) throw new Error('缺少有效的星砂商店槽位');

  const exchangeCount = Math.floor(Number(count) || 0);
  if (exchangeCount <= 0) throw new Error('兑换数量必须大于 0');

  const before = await getStarActivity();
  const slots = Array.isArray(before?.exchangeShop) ? before.exchangeShop : [];
  const slot = slots.find(item => toNum(item?.id) === slotIdNum);
  if (!slot) throw new Error(`星砂商店未找到槽位: ${slotIdNum}`);

  const price = Math.max(0, toNum(slot?.price));
  const balance = Math.max(0, toNum(before?.starSandBalance));
  const exchangeLimit = Math.max(0, toNum(slot?.exchangeLimit));
  const totalPrice = price * exchangeCount;
  const ownedBlocksExchange = slot?.ownedBlocksExchange !== false
    && slot?.owned
    && !slot?.isRepeatable;

  if (toNum(slot?.currencyId) !== STAR_SAND_ITEM_ID) {
    throw new Error(`暂不支持非星砂货币兑换: slotId=${slotIdNum}`);
  }
  if (ownedBlocksExchange) throw new Error(`该商品已拥有，不能重复兑换: slotId=${slotIdNum}`);
  if (!slot?.isRepeatable && exchangeCount > 1) throw new Error('该商品每次只能兑换 1 个');
  if (exchangeLimit > 0 && exchangeCount > exchangeLimit) {
    throw new Error(`兑换数量超过上限: 最多可兑换 ${exchangeLimit} 个`);
  }
  if (totalPrice > balance) throw new Error(`星砂不足: 需要 ${totalPrice}, 当前 ${balance}`);

  activityLogger.info('星砂商店兑换开始', {
    slotId: slotIdNum,
    itemId: toNum(slot?.itemId),
    itemName: slot?.itemName || slot?.name || '',
    price,
    count: exchangeCount,
    totalPrice,
    balance,
    activityId: STAR_SHOP_ACTIVITY_ID,
    cmd: STAR_SHOP_EXCHANGE_CMD,
  });

  try {
    await operateActivity(STAR_SHOP_ACTIVITY_ID, STAR_SHOP_EXCHANGE_CMD, {
      exchangeShopOperate: {
        id: slotIdNum,
        count: exchangeCount,
      },
    });
  } catch (err) {
    throw new Error(
      `星砂商店兑换失败: slotId=${slotIdNum}, itemId=${toNum(slot?.itemId)}, price=${price}: ${err.message}`
    );
  }

  return {
    ok: true,
    slotId: slotIdNum,
    price,
    count: exchangeCount,
    totalPrice,
    currencyId: STAR_SAND_ITEM_ID,
    item: slot,
    activity: await getStarActivity(),
  };
}

function normalizeHeluGroup(reply, lastDrawResult = null) {
  const activities = flattenActivityChildren(reply);
  const getDrawInfo = (act) => act?.draw_info || act?.drawInfo || null;
  const getExchangeShop = (act) => act?.exchange_shop || act?.exchangeShop || null;

  const drawAct = activities.find((a) => toNum(a?.id) === HELU_DRAW_ACTIVITY_ID)
    || activities.find((a) => /奇遇礼莲/.test(String(a?.title || '')))
    || activities.find((a) => getDrawInfo(a))
    || null;

  const exchangeAct = activities.find(
    (a) => /荷露商店/.test(String(a?.title || ''))
      || (getExchangeShop(a) && Array.isArray(getExchangeShop(a).items) && getExchangeShop(a).items.length > 0)
  ) || null;

  let drawInfo = normalizeDrawInfo(getDrawInfo(drawAct)) || scanDrawInfoFromRawBody(reply?.__rawBody);
  let exchangeItems = (getExchangeShop(exchangeAct)?.items || [])
    .map(normalizeExchangeShopItem)
    .filter(Boolean);
  const rawExchange = scanExchangeShopInfoFromRawBody(reply?.__rawBody);
  if (exchangeItems.length === 0 && rawExchange) {
    exchangeItems = rawExchange.items;
  }
  if (!drawInfo) drawInfo = normalizeDrawInfo({});
  if (!drawInfo._hasPaidRemaining && drawInfo.freeRemaining <= 0) {
    drawInfo.paidUsed = drawInfo.paidMax;
    drawInfo.paidRemaining = 0;
  }
  drawInfo.actions = computeHeluDrawActions(drawInfo);
  drawInfo.dailyMax = drawInfo.freeMax + drawInfo.paidMax;
  drawInfo.dailyUsed = drawInfo.freeUsed + drawInfo.paidUsed;
  drawInfo.dailyRemaining = drawInfo.freeRemaining + drawInfo.paidRemaining;

  const root = reply?.group?.activity || {};
  const subActivities = normalizeHeluSubActivities(activities);
  return {
    uid: reply?.__activityUid || HELU_ACTIVITY_UID,
    title: String(root?.title || '荷风十里蝉初鸣'),
    activityId: toNum(root?.id) || HELU_ACTIVITY_ID,
    drawActivityId: toNum(drawAct?.id) || HELU_DRAW_ACTIVITY_ID,
    drawCommand: HELU_DRAW_CMD,
    draw: drawInfo,
    exchangeActivityId: toNum(exchangeAct?.id),
    exchangeShop: exchangeItems,
    subActivities,
    lastDrawResult,
    summary: {
      rewardPoolCount: drawInfo.rewardPool.length,
      exchangeShopCount: exchangeItems.length,
      activityCount: activities.length,
      subActivityCount: subActivities.length,
      dailyUsed: drawInfo.dailyUsed,
      dailyRemaining: drawInfo.dailyRemaining,
    },
    raw: {
      activityCount: activities.length,
      activityTitles: activities.map((a) => String(a?.title || '')).filter(Boolean),
      activityIds: activities.map((a) => toNum(a?.id)).filter((id) => id > 0),
    },
  };
}

async function getHeluActivity() {
  const state = getUserState();
  if (!state) {
    return {
      uid: HELU_ACTIVITY_UID,
      title: '荷风十里蝉初鸣',
      draw: {
        ...normalizeDrawInfo({}),
        actions: computeHeluDrawActions(normalizeDrawInfo({})),
      },
      heluBalance: 0,
      subActivities: normalizeHeluSubActivities([]),
      passport: {
        uid: HELU_PASSPORT_UID,
        title: '荷风游记',
        currentLevel: 0,
        claimableLevels: 0,
        rewards: [],
        levelRewardTiers: [],
      },
      solarTerms: {
        terms: [],
        claimableCount: 0,
        currentTerm: null,
      },
      summary: { rewardPoolCount: 0, subActivityCount: HELU_SUB_ACTIVITY_DEFS.length },
      qingmei: await getQingmeiActivity(),
      warning: 'runtime connection is not open',
    };
  }

  const activity = normalizeHeluGroup(
    await getActivityGroupWithUidFallback(HELU_ACTIVITY_ID, getHeluActivityUidCandidates())
  );
  activity.heluBalance = await getHeluBalance();
  try {
    activity.passport = await getSeasonPassport();
  } catch (err) {
    activity.passport = {
      uid: HELU_PASSPORT_UID,
      title: '荷风游记',
      currentLevel: 0,
      claimableLevels: 0,
      rewards: [],
      levelRewardTiers: [],
      warning: err?.message || String(err),
    };
  }
  try {
    activity.solarTerms = await getSolarTermsInfo();
  } catch (err) {
    activity.solarTerms = {
      terms: [],
      claimableCount: 0,
      currentTerm: null,
      warning: err?.message || String(err),
    };
  }
  activity.qingmei = await getQingmeiActivity();
  return activity;
}

function resolveHeluDrawCount(activity, options = {}) {
  const draw = activity?.draw || {};
  const mode = String(options?.mode || '').toLowerCase();
  const requestedCount = Math.max(0, toNum(options?.count));

  if (mode === 'batch' || mode === 'four' || mode === 'max') {
    return draw.actions?.batch?.count || 0;
  }
  if (mode === 'one') return draw.actions?.one?.count || 0;
  if (requestedCount > 0) {
    if (draw.freeRemaining > 0) return Math.min(requestedCount, draw.freeRemaining);
    return Math.min(requestedCount, draw.paidRemaining);
  }
  return draw.actions?.one?.count || 0;
}

async function drawHeluGiftLotus(options = {}) {
  const before = await getHeluActivity();
  const count = resolveHeluDrawCount(before, options);
  if (count <= 0) throw new Error('奇遇礼莲今日次数已用完');

  const usingFree = toNum(before?.draw?.freeRemaining) > 0;
  const expectedCost = usingFree ? 0 : count * toNum(before?.draw?.paidPrice);

  let drawResult = null;
  const drawPayload = { id: HELU_DRAW_ACTIVITY_ID, count };
  const paidPayload = { type: 0, count };
  if (!usingFree && expectedCost > 0) {
    drawPayload.cost = {
      id: toNum(before?.draw?.paidCurrencyId) || 1002,
      count: expectedCost,
    };
  }

  const drawContext = {
    requestedMode: options?.mode || '',
    requestedCount: toNum(options?.count) || 0,
    resolvedCount: count,
    mode: usingFree ? 'free' : 'paid',
    expectedCost,
    paidCurrencyId: toNum(before?.draw?.paidCurrencyId) || 1002,
    before: {
      freeUsed: toNum(before?.draw?.freeUsed),
      freeMax: toNum(before?.draw?.freeMax),
      freeRemaining: toNum(before?.draw?.freeRemaining),
      paidUsed: toNum(before?.draw?.paidUsed),
      paidMax: toNum(before?.draw?.paidMax),
      paidRemaining: toNum(before?.draw?.paidRemaining),
      paidPrice: toNum(before?.draw?.paidPrice),
    },
    payload: usingFree ? drawPayload : paidPayload,
    legacyDrawPayload: usingFree ? null : drawPayload,
  };
  activityLogger.info('奇遇礼莲抽奖开始', drawContext);

  try {
    if (usingFree && count > 1) {
      const merged = { rewards: [], items: [], cost: null };
      for (let i = 0; i < count; i += 1) {
        assertActivityConnection('奇遇礼莲抽奖');
        if (i > 0) await delay(HELU_DRAW_REQUEST_GAP_MS);

        const body = await operateActivity(HELU_DRAW_ACTIVITY_ID, HELU_DRAW_CMD, {
          draw: { id: HELU_DRAW_ACTIVITY_ID, count: 1 },
        });
        const decoded = types.ActivityOperateReply.decode(body);
        const result = normalizeDrawResult(decoded?.draw_result || decoded?.drawResult);
        if (Array.isArray(result?.rewards)) merged.rewards.push(...result.rewards);
        if (Array.isArray(result?.items)) merged.items.push(...result.items);
        if (!merged.cost && result?.cost) merged.cost = result.cost;
      }
      drawResult = merged;
    } else {
      assertActivityConnection('奇遇礼莲抽奖');
      const params = usingFree
        ? { draw: drawPayload }
        : { helu_paid_draw: paidPayload };
      const body = await operateActivity(HELU_DRAW_ACTIVITY_ID, HELU_DRAW_CMD, params);
      const decoded = types.ActivityOperateReply.decode(body);
      drawResult = normalizeDrawResult(decoded?.draw_result || decoded?.drawResult);
    }
  } catch (err) {
    activityLogger.error('奇遇礼莲抽奖失败', {
      ...drawContext,
      error: err?.message || String(err),
    });
    throw new Error(
      `奇遇礼莲抽奖失败: activityId=${HELU_DRAW_ACTIVITY_ID}, count=${count}, expectedCost=${expectedCost}: ${err.message}`
    );
  }

  await delay(HELU_DRAW_REFRESH_DELAY_MS);
  assertActivityConnection('刷新奇遇礼莲活动');
  const after = await getHeluActivity();
  activityLogger.info('奇遇礼莲抽奖成功', {
    ...drawContext,
    cost: drawResult?.cost || null,
    rewardCount: (Array.isArray(drawResult?.items) ? drawResult.items.length : 0)
      + (Array.isArray(drawResult?.rewards) ? drawResult.rewards.length : 0),
    after: {
      freeUsed: toNum(after?.draw?.freeUsed),
      freeMax: toNum(after?.draw?.freeMax),
      freeRemaining: toNum(after?.draw?.freeRemaining),
      paidUsed: toNum(after?.draw?.paidUsed),
      paidMax: toNum(after?.draw?.paidMax),
      paidRemaining: toNum(after?.draw?.paidRemaining),
    },
  });

  return {
    ok: true,
    count,
    expectedCost,
    costCurrencyId: usingFree ? 0 : toNum(before?.draw?.paidCurrencyId) || 1002,
    mode: usingFree ? 'free' : 'paid',
    result: drawResult,
    activity: {
      ...after,
      lastDrawResult: drawResult,
    },
  };
}

async function exchangeHeluShopItem(slotId, count = 1) {
  const slotIdNum = Number(slotId) || 0;
  if (slotIdNum <= 0) throw new Error('缺少有效的荷露商店槽位');

  const exchangeCount = Math.floor(Number(count) || 0);
  if (exchangeCount <= 0) throw new Error('兑换数量必须大于 0');

  const before = await getHeluActivity();
  const exchangeItems = Array.isArray(before?.exchangeShop) ? before.exchangeShop : [];
  const slot = exchangeItems.find((item) => toNum(item?.id) === slotIdNum);
  if (!slot) throw new Error(`荷露商店未找到槽位: ${slotIdNum}`);

  const price = Math.max(0, toNum(slot?.price));
  const balance = Math.max(0, toNum(before?.heluBalance));
  const isHeluCurrency = toNum(slot?.currencyId) === HELU_CURRENCY_ITEM_ID;
  const ownedBlocksExchange = slot?.ownedBlocksExchange !== false && slot?.owned && !slot?.isRepeatable;
  const exchangeLimit = Math.max(0, toNum(slot?.exchangeLimit));
  const totalPrice = price * exchangeCount;

  if (!isHeluCurrency) throw new Error(`暂不支持非荷露货币兑换: slotId=${slotIdNum}`);
  if (ownedBlocksExchange) throw new Error(`该商品已拥有，不能重复兑换: slotId=${slotIdNum}`);
  if (!slot?.isRepeatable && exchangeCount > 1) throw new Error('该商品每次只能兑换 1 个');
  if (exchangeLimit > 0 && exchangeCount > exchangeLimit) {
    throw new Error(`兑换数量超过上限: 最多可兑换 ${exchangeLimit} 个`);
  }
  if (totalPrice > balance) throw new Error(`荷露不足: 需要 ${totalPrice}, 当前 ${balance}`);

  activityLogger.info('荷露商店兑换开始', {
    slotId: slotIdNum,
    itemId: toNum(slot?.itemId),
    itemName: slot?.itemName || slot?.name || '',
    price,
    count: exchangeCount,
    totalPrice,
    balance,
    exchangeActivityId: HELU_EXCHANGE_ACTIVITY_ID,
    cmd: HELU_EXCHANGE_CMD,
  });

  try {
    await operateActivity(HELU_EXCHANGE_ACTIVITY_ID, HELU_EXCHANGE_CMD, {
      exchangeShopOperate: {
        id: slotIdNum,
        count: exchangeCount,
      },
    });
  } catch (err) {
    activityLogger.error('荷露商店兑换失败', {
      slotId: slotIdNum,
      itemId: toNum(slot?.itemId),
      price,
      count: exchangeCount,
      totalPrice,
      balance,
      error: err?.message || String(err),
    });
    throw new Error(`荷露商店兑换失败: slotId=${slotIdNum}, itemId=${toNum(slot?.itemId)}, price=${price}: ${err.message}`);
  }

  const after = await getHeluActivity();
  return {
    ok: true,
    slotId: slotIdNum,
    price,
    count: exchangeCount,
    totalPrice,
    currencyId: HELU_CURRENCY_ITEM_ID,
    item: slot,
    activity: after,
  };
}

// ---- 南瓜活动标准化 ----

function normalizeNanguaGroup(reply) {
  const activities = flattenActivityChildren(reply);

  const getRandomShop = (act) => act?.random_shop || act?.randomShop || null;
  const getExchangeShop = (act) => act?.exchange_shop || act?.exchangeShop || null;

  const randomAct = activities.find(
    (a) => getRandomShop(a) && Array.isArray(getRandomShop(a).items) && getRandomShop(a).items.length > 0
  ) || null;

  const exchangeAct = activities.find(
    (a) => getExchangeShop(a) && Array.isArray(getExchangeShop(a).items) && getExchangeShop(a).items.length > 0
  ) || null;

  // 优先使用 proto 解码
  let randomShop = normalizeRandomShopInfo(getRandomShop(randomAct));

  // 原始 body 扫描作为回退
  const rawRandomShop = scanRandomShopInfoFromRawBody(reply?.__rawBody);
  if (!randomShop || randomShop.items.length === 0) {
    randomShop = rawRandomShop;
  } else if (rawRandomShop) {
    randomShop = {
      ...randomShop,
      nextRefreshTime: randomShop.nextRefreshTime || rawRandomShop.nextRefreshTime,
      manualRefreshCost: randomShop.manualRefreshCost || rawRandomShop.manualRefreshCost,
      manualRefreshCurrencyId: randomShop.manualRefreshCurrencyId || rawRandomShop.manualRefreshCurrencyId,
      manualRefreshExtraValue: randomShop.manualRefreshExtraValue || rawRandomShop.manualRefreshExtraValue,
      maxManualRefreshCount: 6,
      manualRefreshUsedCount: randomShop.manualRefreshUsedCount || rawRandomShop.manualRefreshUsedCount,
    };
  }

  const randomItems = randomShop?.items || [];

  let exchangeItems = (getExchangeShop(exchangeAct)?.items || [])
    .map(normalizeExchangeShopItem)
    .filter(Boolean);

  const rawExchange = scanExchangeShopInfoFromRawBody(reply?.__rawBody);
  if (exchangeItems.length === 0 && rawExchange) {
    exchangeItems = rawExchange.items;
  }

  const refreshInfo = {
    nextRefreshTime: randomShop?.nextRefreshTime || 0,
    manualRefreshCost: randomShop?.manualRefreshCost || 0,
    manualRefreshCurrencyId: randomShop?.manualRefreshCurrencyId || 1001,
    manualRefreshExtraValue: randomShop?.manualRefreshExtraValue || 0,
    maxManualRefreshCount: 6,
    manualRefreshUsedCount: randomShop?.manualRefreshUsedCount || 0,
  };

  return {
    uid: NANGUA_ACTIVITY_UID,
    title: String(reply?.group?.activity?.title || '南瓜乐翻天'),
    randomActivityId: toNum(randomAct?.id),
    exchangeActivityId: toNum(exchangeAct?.id),
    randomShop: randomItems,
    randomShopRefresh: refreshInfo,
    exchangeShop: exchangeItems,
    summary: {
      randomShopCount: randomItems.length,
      exchangeShopCount: exchangeItems.length,
      activityCount: activities.length,
    },
    raw: {
      activityCount: activities.length,
      activityTitles: activities.map((a) => String(a?.title || '')).filter(Boolean),
      activityIds: activities.map((a) => toNum(a?.id)).filter((id) => id > 0),
    },
  };
}

/**
 * 获取南瓜商店
 */
async function getNanguaShop() {
  const state = getUserState();
  if (!state) {
    return {
      uid: NANGUA_ACTIVITY_UID,
      title: '南瓜乐翻天',
      randomShop: [],
      exchangeShop: [],
      summary: { randomShopCount: 0, exchangeShopCount: 0 },
      warning: 'runtime connection is not open',
    };
  }

  return normalizeNanguaGroup(await getActivityGroup(NANGUA_SHOP_ACTIVITY_ID));
}

module.exports = {
  NANGUA_ACTIVITY_UID,
  HELU_ACTIVITY_UID,
  STAR_ACTIVITY_UID,
  QINGMEI_ACTIVITY_UID,
  NANGUA_SHOP_ACTIVITY_ID,
  NANGUA_RANDOM_SHOP_ACTIVITY_ID,
  HELU_ACTIVITY_ID,
  STAR_ACTIVITY_ID,
  STAR_RECORD_ACTIVITY_ID,
  STAR_SHOP_ACTIVITY_ID,
  STAR_SHOP_EXCHANGE_CMD,
  HELU_DRAW_ACTIVITY_ID,
  HELU_EXCHANGE_ACTIVITY_ID,
  QINGMEI_ACTIVITY_ID,
  QINGMEI_SEED_CLAIM_ACTIVITY_ID,
  QINGMEI_WINE_ACTIVITY_ID,
  HELU_SUB_ACTIVITY_KEYS,
  NANGUA_SHOP_BUY_CMD,
  NANGUA_SHOP_REFRESH_CMD,
  HELU_EXCHANGE_CMD,
  HELU_DRAW_CMD,
  getActivityGroup,
  getNanguaShop,
  getHeluActivity,
  getStarActivity,
  claimStarRecordRewards,
  exchangeStarShopItem,
  getQingmeiActivity,
  claimQingmeiSeeds,
  brewAndSellQingmeiWine,
  startQingmeiBrew,
  continueQingmeiBrew,
  autoBrewQingmei,
  settleQingmeiBrew,
  getSeasonPassport,
  claimSeasonPassportRewards,
  getSolarTermsInfo,
  claimSolarTermsReward,
  exchangeHeluShopItem,
  drawHeluGiftLotus,
  buyNanguaShopItem,
  refreshNanguaShop,
  normalizeNanguaGroup,
  normalizeHeluGroup,
};
