import os
import threading
import time
import logging
from typing import Any, Dict, Optional

import requests
import uuid
import json
from fastapi import HTTPException

# Logger setup
logger = logging.getLogger("gaia_client")
import logging

""" logging.basicConfig(
    level=logging.INFO,
    filename='mylog.txt',    # 写到日志文件
    filemode='a',
    encoding='utf-8',        # 指定编码为 UTF-8
    format='%(levelname)s:%(name)s:%(message)s'
) """
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

# Config
# Allow GAIA_BASE_URL to be a template containing {assistantid}.
# Resolution now happens per-call to allow using call_gaia(..., assitantid=...).
GAIA_ASSISTANT_ID = os.getenv("GAIA_ASSISTANT_ID") or os.getenv("GAIA_ASSITANT_ID")  # fallback for common typo
GAIA_BASE_URL_TEMPLATE = "https://api.gaia.draeger.net/api/assistants/{assistantid}/chat/completions?format=codegpt&stream=true"
GAIA_BASE_URL_RAW = os.getenv("GAIA_BASE_URL", GAIA_BASE_URL_TEMPLATE)

# Backward-compat placeholder; final URL is built at request time
GAIA_BASE_URL = None
MODEL_NAME = os.getenv("GAIA_MODEL", "GPT 5.1")
TIMEOUT = int(os.getenv("GAIA_TIMEOUT", "60"))
MAX_RETRY = int(os.getenv("GAIA_MAX_RETRY", "3"))
BACKOFF_BASE = float(os.getenv("GAIA_BACKOFF_BASE", "1.5"))
SESSION_TOKEN_LIMIT = int(os.getenv("GAIA_SESSION_TOKEN_LIMIT", "120000"))
MAX_RESPONSE_TOKENS = int(os.getenv("GAIA_MAX_RESPONSE_TOKENS", "102400"))
PLACEHOLDER = os.getenv("GAIA_PLACEHOLDER", "对不起，服务繁忙，请稍后再试。")
GAIA_API_KEY   = os.getenv("GAIA_API_KEY", "wQ51aOrIoNh1MCbm54bsUtCsmYRCPxH6FGRj54Dlw1s")

# Logging controls
LOG_PAYLOADS = os.getenv("GAIA_LOG_PAYLOADS", "true").lower() in ("1", "true", "yes", "on")
MAX_LOG_CHARS = int(os.getenv("GAIA_MAX_LOG_CHARS", "2000"))

# Internal state
_session_obj = requests.Session()


def _build_gaia_url(assitantid: Optional[str]) -> str:
    """Build the Gaia URL per call.
    Priority:
    1) If GAIA_BASE_URL_RAW contains {assistantid}/{assitantid}, replace with function param if provided,
       else fall back to GAIA_ASSISTANT_ID. If still missing, raise 400.
    2) If GAIA_BASE_URL_RAW has no placeholder:
       - If function param provided, prefer the official template GAIA_BASE_URL_TEMPLATE with that id.
       - Else, use GAIA_BASE_URL_RAW as-is.
    """
    template = GAIA_BASE_URL_RAW or GAIA_BASE_URL_TEMPLATE

    if "{assistantid}" in template:
        final_id = assitantid or GAIA_ASSISTANT_ID
        if not final_id:
            logger.warning("Missing assistant id: neither function param nor GAIA_ASSISTANT_ID provided, but template needs it.")
            raise HTTPException(status_code=400, detail="缺少 assistantid：请在调用参数或环境变量 GAIA_ASSISTANT_ID 中提供。")
        url = template.replace("{assistantid}", final_id)
    else:
        # No placeholder in template
        if assitantid:
            # Prefer official template when caller explicitly passes an id
            url = GAIA_BASE_URL_TEMPLATE.replace("{assistantid}", assitantid)
        else:
            url = template

    # Basic validation
    if not url or "{" in url or "}" in url:
        raise HTTPException(status_code=500, detail="GAIA_BASE_URL 解析失败：存在未替换占位符或配置为空。")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=500, detail="GAIA_BASE_URL 无效：必须以 http:// 或 https:// 开头。")

    return url
_lock = threading.Lock()
_used_tokens = 0

# Session identification (can be provided via env or auto-generated)
_session_id = os.getenv("GAIA_SESSION_ID") or uuid.uuid4().hex

# Ensure auth headers are set for the session (Gaia requires token)
if GAIA_API_KEY:
    _session_obj.headers.update({
        "Accept-Encoding": "gzip, deflate", # 压缩更快
        "Accept-Charset": "utf-8",
        "Content-Type": "application/json; charset=utf-8",
        "Connection": "keep-alive",
        "Accept": "text/event-stream",
        "Authorization": f"Bearer {GAIA_API_KEY}",
        "X-Session-Id": _session_id
    })
    try:
        logger.info(f"Gaia auth configured: key_len={len(GAIA_API_KEY)}, session_id={_session_id}")
    except Exception:
        pass
else:
    logger.warning("GAIA_API_KEY is not set; requests will likely fail with 401.")



def _reset_session() -> None:
    global _session_obj, _used_tokens
    _session_obj.close()
    _session_obj = requests.Session()
    _session_obj.headers.update({
            "Accept-Encoding": "gzip, deflate", # 压缩更快
            "Accept-Charset": "utf-8",
            "Content-Type": "application/json; charset=utf-8",
            "Connection": "keep-alive",
            "Accept": "text/event-stream",
            "Authorization": f"Bearer {GAIA_API_KEY}",
            "X-Session-Id":  _session_id
        })
    _used_tokens = 0


def count_tokens(text: str) -> int:
    """Very rough token estimator.
    Roughly 1 token ≈ 4 chars for English; Chinese roughly 1 char ≈ 1 token.
    We'll use a heuristic: tokens = max(len(text) // 2, 1)
    """
    if not text:
        return 0
    # simple heuristic that works ok for mixed content
    return max(len(text) // 2, 1)


def _clip_for_log(s: Any) -> str:
    """Clip long text for safe logging."""
    try:
        t = "" if s is None else str(s)
    except Exception:
        t = "<unprintable>"
    if len(t) <= MAX_LOG_CHARS:
        return t
    return f"{t[:MAX_LOG_CHARS]}... [truncated {len(t) - MAX_LOG_CHARS} chars]"


def _parse_gaia_response(data: Dict[str, Any]) -> str:
    # 支持两种返回风格
    if "content" in data and isinstance(data["content"], str):
        logger.info("Gaia call success (content field).")
        return data["content"].strip()
    elif "choices" in data and isinstance(data["choices"], list) and data["choices"]:
        return (data["choices"][0].get("message", {}) or {}).get("content", "").strip()
    raise RuntimeError("Unexpected Gaia response format")


def call_gaia(text: str, system_prompt: str, assistantid:str = None, glob_filter: str = None) -> str:
    logger.info(f"本批 prompt:\n{system_prompt}")
    global _used_tokens
    prompt_tokens = count_tokens(text) + count_tokens(system_prompt) + 50  # 估算 system prompt 50 token

    with _lock:
        if _used_tokens + prompt_tokens + MAX_RESPONSE_TOKENS >= SESSION_TOKEN_LIMIT:
            logger.info("Token limit reached, resetting session.")
            _reset_session()
        _used_tokens += prompt_tokens

    payload = {
        "model": MODEL_NAME,
        "stream": True,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text}
        ],
        "temperature": 0.1,
        "max_tokens": MAX_RESPONSE_TOKENS,
        "reasoningEffort": "Low"
    }

    if glob_filter:
        payload["ragConfig"] = {"globFilter": glob_filter}

    if LOG_PAYLOADS:
           logger.info("请求 payload 内容: %s", payload)




    err = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            logger.debug(f"Calling Gaia, attempt {attempt}")
            # Resolve URL per-call using function parameter or env
            url = _build_gaia_url(assistantid)
            logger.debug(f"Resolved Gaia URL: {url}")
            # Gaia endpoint may return Server-Sent Events (text/event-stream) when stream=true
            resp = _session_obj.post(url, json=payload, timeout=TIMEOUT, stream=True)
            resp.raise_for_status()

            ctype = (resp.headers.get("Content-Type") or "").lower()
            # Determine charset; default to utf-8 (Gaia uses UTF-8 for SSE/JSON)
            charset = "utf-8"
            if "charset=" in ctype:
                try:
                    charset = (ctype.split("charset=")[-1].split(";")[0] or "utf-8").strip()
                except Exception:
                    charset = "utf-8"
            # Hint requests for subsequent .text/.json decoding
            try:
                resp.encoding = charset
            except Exception:
                pass
            is_sse = "text/event-stream" in ctype

            # Accumulate content whether streaming or not
            accumulated = []
            completion_tokens = 0

            if is_sse:
                logger.debug("Parsing SSE stream from Gaia…")
                for raw_line in resp.iter_lines(decode_unicode=False):
                    if not raw_line:
                        continue
                    try:
                        line = raw_line.decode(charset, errors="replace").strip()
                    except Exception:
                        # Fallback to utf-8 decoding
                        try:
                            line = raw_line.decode("utf-8", errors="replace").strip()
                        except Exception:
                            continue
                    if not line.startswith("data:"):
                        continue
                    payload_str = line[5:].strip()  # trim leading 'data:'
                    if payload_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload_str)
                    except Exception:
                        # Skip malformed lines
                        continue

                    # Two possible shapes: OpenAI-style delta, or custom content field
                    delta = None
                    if isinstance(chunk, dict):
                        # Count tokens if provided on final message
                        completion_tokens += int(
                            chunk.get("completionTokenCount") or
                            (chunk.get("usage", {}) or {}).get("completion_tokens", 0) or 0
                        )
                        if "choices" in chunk and chunk.get("choices"):
                            delta = (((chunk.get("choices")[0] or {}).get("delta") or {}).get("content"))
                        elif "content" in chunk:
                            delta = chunk.get("content")
                    if delta:
                        accumulated.append(str(delta))

                content = ("".join(accumulated)).strip()
            else:
                # Non-stream JSON response
                data = resp.json()
                completion_tokens = int(
                    data.get("completionTokenCount") or
                    (data.get("usage", {}) or {}).get("completion_tokens", 0) or 0
                )
                content = _parse_gaia_response(data)

            # Update token usage (best effort)
            if not completion_tokens and content:
                completion_tokens = count_tokens(content)
            with _lock:
                _used_tokens += int(completion_tokens or 0)

            # Post-process: if Gaia returns JSON with a results list, sort by page ascending
            # 需求：如果响应包含 results 且其中含有 page 字段，则按 page 升序返回给前端
            if content:
                try:
                    parsed = json.loads(content)
                    if isinstance(parsed, dict) and isinstance(parsed.get("results"), list):
                        results = parsed.get("results")
                        # 仅当元素为 dict 且存在 page 字段时进行排序；无法比较的置于末尾
                        def _key(item):
                            try:
                                p = item.get("page") if isinstance(item, dict) else None
                                return p if isinstance(p, (int, float)) else float('inf')
                            except Exception:
                                return float('inf')
                        parsed["results"] = sorted(results, key=_key)
                        content = json.dumps(parsed, ensure_ascii=False)
                except Exception:
                    # 非 JSON 或解析/排序失败时，保持原样
                    pass

            if LOG_PAYLOADS:
                logger.info("Gaia 返回内容: %s", _clip_for_log(content))
            return content

        except (requests.ReadTimeout, requests.ConnectionError) as e:
            err = f"{type(e).__name__}"
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else None
            if LOG_PAYLOADS and e.response is not None:
                try:
                    body = e.response.text
                except Exception:
                    body = "<unreadable body>"
                logger.warning("Gaia 上游返回错误: HTTP %s, body=%s", status, _clip_for_log(body))
            if status in (401, 403):
                # Surface upstream auth failures to the client as 401
                logger.error("Upstream auth failed (HTTP %s). Please check GAIA_API_KEY / permissions.", status)
                raise HTTPException(status_code=401, detail="上游鉴权失败，请检查 GAIA_API_KEY 或权限是否正确。") from e
            if status not in (429, 500, 502, 503, 504):
                logger.error(f"HTTP error: {status}")
                raise
            err = f"HTTP {status}"
        except Exception as e:
            # Any JSON/parse errors etc. — retry as transient once
            err = f"{type(e).__name__}: {e}"

        if attempt == MAX_RETRY:
            logger.error(f"Gaia call failed after {MAX_RETRY} attempts: {err}")
            break
        wait = BACKOFF_BASE ** attempt
        logger.warning(f"{err}, retry {attempt}/{MAX_RETRY} in {wait}s …")
        print(f"[warn] {err}, retry {attempt}/{MAX_RETRY} in {wait}s …")
        time.sleep(wait)

    return PLACEHOLDER
