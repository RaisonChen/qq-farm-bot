"""QQ 农场抓包插件（mitmproxy addon）。

职责：拦截 QQ / 微信小程序在登录期间产生的 HTTP(S) 流量，从中解析出：
  - code    小程序登录 code（js_code），QQ 农场用它换取会话
  - gid     账号 GID
  - openid  小程序 openid
  - 好友 GID 列表（QQ）

解析结果通过本地回传地址异步 POST 回 Node 抓包服务（server.js），
由后者写入对应会话的状态，再经 core 透传给前端。

该脚本尽量“宽进严出”：能识别的字段就上报，无法确定的字段留空，
由 Node/core 侧做去重与聚合。不同版本的小程序登录链路可能有差异，
匹配规则集中在下方常量中，便于后续维护。
"""

import json
import os
import re
import threading
import time
import urllib.request

from mitmproxy import http

try:  # ctx 用于向 mitmproxy 日志通道输出醒目信息；缺失也不影响运行。
    from mitmproxy import ctx
except Exception:  # pragma: no cover
    ctx = None

try:  # WebSocket 类型仅用于类型提示，缺失也不影响运行。
    from mitmproxy import websocket  # noqa: F401
except Exception:  # pragma: no cover
    websocket = None

CALLBACK_URL = os.environ.get("CAPTURE_CALLBACK_URL", "")
CALLBACK_TOKEN = os.environ.get("CAPTURE_CALLBACK_TOKEN", "")
SESSION_ID = os.environ.get("CAPTURE_SESSION_ID", "")
MODE = os.environ.get("CAPTURE_MODE", "qq")

# 登录 code 通常出现在腾讯登录/小游戏鉴权相关的请求里。
# 这里用宽松的关键字匹配 host + path，再从 body/query 中提取字段。
LOGIN_HOST_HINTS = (
    "qq.com",
    "weixin.qq.com",
    "wxs.qq.com",
    "minigame",
    "qzone",
    "gamecenter",
    "jsapi",
)
LOGIN_PATH_HINTS = (
    "login",
    "jscode2session",
    "code2session",
    "auth",
    "jslogin",
    "session",
    # WebSocket 长连网关（QQ 农场 wss://gate-obt.nqf.qq.com/prod/ws?...&code=）。
    "/ws",
    "gate",
    "prod",
    "obt",
)

# WebSocket 网关 host 特征：命中即视为可能承载登录 code 的长连。
WS_HOST_HINTS = (
    "nqf.qq.com",
    "gate-obt",
    "gate",
)

CODE_KEYS = ("code", "js_code", "jscode", "login_code", "authcode")
GID_KEYS = ("gid", "uin", "account_gid", "roleid", "role_id")
OPENID_KEYS = ("openid", "open_id")

# 好友列表来源（QQ 农场走 protobuf；这里按 service 名或明显的好友接口关键字识别）。
FRIEND_PATH_HINTS = ("friend", "getall", "syncall", "relation")
FRIEND_SOURCE_QQ = "gamepb.friendpb.FriendService.GetAll"

GID_PATTERN = re.compile(r"\b(\d{5,12})\b")

# 真正的登录 code 是较长的随机串（如 32 位十六进制 7e23959cbcb0e229...）。
# 而腾讯接口响应体里普遍存在 {"code":0,"msg":"success"} 这类“业务状态码”，
# 其 code 为 0 / -1 / 1001 等纯数字小整数，必须排除，否则会把状态码误当登录 code。
_LOGIN_CODE_RE = re.compile(r"^[A-Za-z0-9._-]{16,}$")


def _is_valid_login_code(value):
    """判断一个候选值是否像“登录 code”，用于剔除业务状态码等噪声。

    规则：
      - 纯数字（含负号）一律不是登录 code（业务状态码 0/-1/1001…）。
      - 长度过短（<16）不视为登录 code，避免误判短标识。
      - 其余需匹配 [A-Za-z0-9._-]{16,}（登录 code 的常见字符集与长度）。
    """
    code = str(value or "").strip()
    if not code:
        return False
    if re.fullmatch(r"-?\d+", code):
        return False
    return bool(_LOGIN_CODE_RE.match(code))


def _post_back(payload):
    """将一条抓取记录异步回传给 Node 抓包服务。

    回传对整个抓包成败至关重要：只要 Node 侧收到一次 code，就会落盘保存。
    因此这里带指数退避重试，避免因 Node 短暂繁忙/重启窗口而永久丢失 code。
    """
    if not CALLBACK_URL:
        return
    payload = dict(payload)
    payload["sessionId"] = SESSION_ID
    payload["platform"] = MODE
    data = json.dumps(payload).encode("utf-8")

    # 有 code 的记录更重要，多重试几次；纯 gid/好友记录少试即可。
    has_code = bool(str(payload.get("code") or "").strip())
    max_attempts = 6 if has_code else 3
    backoffs = [0.3, 0.6, 1.2, 2.0, 3.0]

    def _send():
        for attempt in range(max_attempts):
            try:
                req = urllib.request.Request(
                    CALLBACK_URL,
                    data=data,
                    headers={
                        "Content-Type": "application/json",
                        "X-Capture-Callback-Token": CALLBACK_TOKEN,
                    },
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=5).read()
                return  # 成功即结束
            except Exception:
                if attempt >= max_attempts - 1:
                    return  # 已尽力；Node 侧还有轮询/落盘兜底
                time.sleep(backoffs[min(attempt, len(backoffs) - 1)])

    threading.Thread(target=_send, daemon=True).start()


def _match_hint(value, hints):
    value = (value or "").lower()
    return any(hint in value for hint in hints)


def _log_hit(kind, code, gid, openid, url=""):
    """在 mitmproxy 终端醒目打印一次命中的登录字段，方便人工确认。

    只在真正抓到 code/gid/openid 时打印，避免刷屏。
    """
    parts = []
    if code:
        parts.append(f"code={code}")
    if gid:
        parts.append(f"gid={gid}")
    if openid:
        parts.append(f"openid={openid}")
    if not parts:
        return
    line = f"[capture] 命中登录字段（{kind}）: " + " ".join(parts)
    if url:
        line += f"  <= {url[:120]}"
    if ctx is not None:
        try:
            ctx.log.alert(line)
            return
        except Exception:
            pass
    print(line, flush=True)


def _extract_pairs(text):
    """从 query string / json / form body 中尽量提取扁平键值对。"""
    pairs = {}
    if not text:
        return pairs

    # 1) 尝试 JSON
    try:
        obj = json.loads(text)
        _flatten(obj, pairs)
        if pairs:
            return pairs
    except Exception:
        pass

    # 2) 尝试 query / x-www-form-urlencoded
    for part in re.split(r"[&;]", text):
        if "=" not in part:
            continue
        key, _, val = part.partition("=")
        key = key.strip().lower()
        val = val.strip()
        if key and val:
            pairs.setdefault(key, val)
    return pairs


def _flatten(obj, out, depth=0):
    if depth > 6:
        return
    if isinstance(obj, dict):
        for key, val in obj.items():
            lk = str(key).lower()
            if isinstance(val, (dict, list)):
                _flatten(val, out, depth + 1)
            else:
                out.setdefault(lk, str(val))
    elif isinstance(obj, list):
        for item in obj:
            _flatten(item, out, depth + 1)


def _pick(pairs, keys):
    for key in keys:
        if key in pairs and pairs[key]:
            return pairs[key]
    return ""


def _report_pairs(pairs, kind="http", url=""):
    """从扁平键值对中挑出登录字段并上报；有 code/gid/openid 才回传。

    code 需通过 _is_valid_login_code 过滤，剔除业务状态码（如 {"code":0} 的 0）。
    """
    raw_code = _pick(pairs, CODE_KEYS)
    code = raw_code if _is_valid_login_code(raw_code) else ""
    gid = _pick(pairs, GID_KEYS)
    openid = _pick(pairs, OPENID_KEYS)
    if code or gid or openid:
        _log_hit(kind, code, gid, openid, url)
        _post_back({"code": code, "gid": gid, "openid": openid})
        return True
    return False


def _harvest_url(url):
    """从单条 URL（含 query）里提取登录字段。用于 WebSocket 握手 URL。

    QQ 农场登录 code 直接明文写在长连 URL 的 query 中，例如：
      wss://gate-obt.nqf.qq.com/prod/ws?platform=qq&os=Android&ver=...&code=xxxx
    只要能读到该 URL（需 TLS 解密成功），无论 path 是否像“登录”，都尝试抓取。
    """
    if not url:
        return False
    query = url.split("?", 1)[1] if "?" in url else ""
    if not query:
        return False
    pairs = _extract_pairs(query)
    return _report_pairs(pairs, kind="ws", url=url)


def _harvest_login(flow):
    url = flow.request.pretty_url
    host = flow.request.pretty_host
    path = flow.request.path or ""

    host_hit = (
        _match_hint(host, LOGIN_HOST_HINTS)
        or _match_hint(url, LOGIN_HOST_HINTS)
        or _match_hint(host, WS_HOST_HINTS)
    )
    if not host_hit:
        return

    pairs = {}
    # query 串
    for key, val in flow.request.query.items(multi=True):
        if key and val:
            pairs.setdefault(key.lower(), val)
    # 请求体
    try:
        body_text = flow.request.get_text(strict=False) or ""
    except Exception:
        body_text = ""
    pairs.update(_extract_pairs(body_text))
    # 响应体（部分链路 code 在响应里）
    if flow.response is not None:
        try:
            resp_text = flow.response.get_text(strict=False) or ""
        except Exception:
            resp_text = ""
        for key, val in _extract_pairs(resp_text).items():
            pairs.setdefault(key, val)

    # 宽进：只要 query/body/response 里出现了 code/gid/openid 就上报，
    # 不再要求 path 命中登录关键字（WS 网关 path 形如 /prod/ws 不含这些词）。
    if _report_pairs(pairs, kind="http", url=url):
        return

    # 严格兜底：path 命中登录关键字时再扫一遍（历史链路）。
    if _match_hint(path, LOGIN_PATH_HINTS):
        _report_pairs(pairs, kind="http-path", url=url)


def _harvest_friends(flow):
    if MODE != "qq":
        return
    url = flow.request.pretty_url
    path = flow.request.path or ""
    if not (_match_hint(path, FRIEND_PATH_HINTS) or _match_hint(url, FRIEND_PATH_HINTS)):
        return
    if flow.response is None:
        return

    # 好友列表多为 protobuf 二进制；这里用宽松的数字扫描提取候选 GID，
    # 由 Node/core 侧再和账号自身 gid 做剔除与去重。
    try:
        raw = flow.response.get_text(strict=False) or ""
    except Exception:
        raw = ""
    if not raw:
        try:
            raw = (flow.response.content or b"").decode("latin-1", "ignore")
        except Exception:
            raw = ""

    gids = []
    seen = set()
    for match in GID_PATTERN.findall(raw):
        num = match
        if num not in seen:
            seen.add(num)
            gids.append(num)
    if gids:
        _post_back({"friendGids": gids, "friendSource": FRIEND_SOURCE_QQ})


def response(flow: http.HTTPFlow):
    try:
        _harvest_login(flow)
        _harvest_friends(flow)
    except Exception:
        # 单条流量解析异常不应影响代理本身。
        pass


def request(flow: http.HTTPFlow):
    # 部分链路 code 出现在请求阶段（尚无响应），提前抓一次。
    # WebSocket 升级请求（wss）也是一次 HTTP GET，其握手 URL 的 query 里带 code，
    # 在这里即可直接命中，无需等到连接建立。
    try:
        _harvest_login(flow)
    except Exception:
        pass


def websocket_start(flow):
    """WebSocket 握手建立时触发。QQ 农场登录 code 明文写在 wss URL 的 query 里，
    例如 wss://gate-obt.nqf.qq.com/prod/ws?platform=qq&...&code=xxxx。
    直接从握手 URL 提取，作为 request 钩子的双保险。
    需要 mitmproxy 已成功解密该 TLS 连接（即客户端信任 mitmproxy CA）。
    """
    try:
        req = getattr(flow, "request", None)
        url = getattr(req, "pretty_url", "") if req else ""
        _harvest_url(url)
    except Exception:
        pass
