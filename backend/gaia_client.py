import os
import threading
import time
import logging
from typing import Any, Dict

import requests
import uuid
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
GAIA_BASE_URL = os.getenv("GAIA_BASE_URL", "https://api.gaia.draeger.net/api/assistants/fab9226e-cb6b-4ced-9310-e3560804e675/chat/completions")
MODEL_NAME = os.getenv("GAIA_MODEL", "GPT 4.1")
TIMEOUT = int(os.getenv("GAIA_TIMEOUT", "60"))
MAX_RETRY = int(os.getenv("GAIA_MAX_RETRY", "3"))
BACKOFF_BASE = float(os.getenv("GAIA_BACKOFF_BASE", "1.5"))
SESSION_TOKEN_LIMIT = int(os.getenv("GAIA_SESSION_TOKEN_LIMIT", "120000"))
MAX_RESPONSE_TOKENS = int(os.getenv("GAIA_MAX_RESPONSE_TOKENS", "102400"))
PLACEHOLDER = os.getenv("GAIA_PLACEHOLDER", "对不起，服务繁忙，请稍后再试。")
GAIA_API_KEY   = os.getenv("GAIA_API_KEY", "bX3AA33tqeXZmEI1uTrXjhOVKuDSacFNCyZ_taV5xIM")

# Logging controls
LOG_PAYLOADS = os.getenv("GAIA_LOG_PAYLOADS", "true").lower() in ("1", "true", "yes", "on")
MAX_LOG_CHARS = int(os.getenv("GAIA_MAX_LOG_CHARS", "2000"))

# Internal state
_session_obj = requests.Session()
_lock = threading.Lock()
_used_tokens = 0

# Session identification (can be provided via env or auto-generated)
_session_id = os.getenv("GAIA_SESSION_ID") or uuid.uuid4().hex

# Ensure auth headers are set for the session (Gaia requires token)
if GAIA_API_KEY:
    _session_obj.headers.update({
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


def call_gaia(text: str, system_prompt: str, glob_filter: str = None) -> str:
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
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text}
        ],
        "temperature": 0.1,
        "max_tokens": MAX_RESPONSE_TOKENS
    }

    if glob_filter:
        payload["ragConfig"] = {"globFilter": glob_filter}

    if LOG_PAYLOADS:
           logger.info("请求 payload 内容: %s", payload)




    err = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            logger.debug(f"Calling Gaia, attempt {attempt}")
            resp = _session_obj.post(GAIA_BASE_URL, json=payload, timeout=TIMEOUT)
            resp.raise_for_status()
            data = resp.json()

            completion = (
                data.get("completionTokenCount") or
                (data.get("usage", {}) or {}).get("completion_tokens", 0)
            )
            with _lock:
                _used_tokens += int(completion or 0)

            content = _parse_gaia_response(data)
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
