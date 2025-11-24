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

def _call_gaia_core(
    text: str,
    system_prompt: str,
    assistantid: str | None = None,
    glob_filter: str | None = None,
    mode: Optional[str] = None
) -> str:
    logger.info(f"本批 prompt:\n{system_prompt}")
    global _used_tokens
    prompt_tokens = count_tokens(text) + count_tokens(system_prompt) + 50

    with _lock:
        if _used_tokens + prompt_tokens + MAX_RESPONSE_TOKENS >= SESSION_TOKEN_LIMIT:
            logger.info("Token limit reached, resetting session.")
            _reset_session()
        _used_tokens += prompt_tokens

    call_mode = (mode or "").strip().lower()
    # 1) 构造 payload
    if call_mode == "ask":
        # 走 Assistant 接口：model / tools / containers 都在助手里配置好了
        payload: dict[str, Any] = {
            "assistantId": assistantid,
            "stream": True,
            "messages": [
                {"role": "user", "content": text},
            ],
            "temperature": 0.1,
            "max_tokens": MAX_RESPONSE_TOKENS,
        }
        # 一般不再传 ragConfig，避免覆盖助手的容器设置
        # 如确实要按文件再细分，可以在这里按需开启
        # if glob_filter:
        #     if "*" not in glob_filter and "?" not in glob_filter:
        #         glob_filter = glob_filter.rstrip("/") + "/**"
        #     payload["ragConfig"] = {"globFilter": glob_filter}
    else:
        # 裸模型调用
        payload = {
            "model": MODEL_NAME,
            "assistantId": assistantid,
            "stream": True,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "temperature": 0.1,
            "max_tokens": MAX_RESPONSE_TOKENS,
            "reasoningEffort": "Low",
        }
        if glob_filter:
            if "*" not in glob_filter and "?" not in glob_filter:
                glob_filter = glob_filter.rstrip("/") + "/**"
            payload["ragConfig"] = {"globFilter": glob_filter}

    if LOG_PAYLOADS:
        logger.info("请求 payload 内容: %s", payload)

    err = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            logger.debug(f"Calling Gaia, attempt {attempt}")
            url = _build_gaia_url(assistantid)
            logger.debug(f"Resolved Gaia URL: {url}")

            resp = _session_obj.post(url, json=payload, timeout=TIMEOUT, stream=True)
            resp.raise_for_status()

            ctype = (resp.headers.get("Content-Type") or "").lower()
            charset = "utf-8"
            if "charset=" in ctype:
                try:
                    charset = (ctype.split("charset=")[-1].split(";")[0] or "utf-8").strip()
                except Exception:
                    charset = "utf-8"
            try:
                resp.encoding = charset
            except Exception:
                pass
            is_sse = "text/event-stream" in ctype

            accumulated: list[str] = []
            completion_tokens = 0

            if is_sse:
                logger.debug("Parsing SSE stream from Gaia…")
                for raw_line in resp.iter_lines(decode_unicode=False):
                    if not raw_line:
                        continue
                    try:
                        line = raw_line.decode(charset, errors="replace").strip()
                    except Exception:
                        try:
                            line = raw_line.decode("utf-8", errors="replace").strip()
                        except Exception:
                            continue
                    if not line.startswith("data:"):
                        continue
                    payload_str = line[5:].strip()
                    if payload_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload_str)
                    except Exception:
                        continue

                    delta = None
                    if isinstance(chunk, dict):
                        completion_tokens += int(
                            chunk.get("completionTokenCount")
                            or (chunk.get("usage", {}) or {}).get("completion_tokens", 0)
                            or 0
                        )
                        if "choices" in chunk and chunk.get("choices"):
                            delta = (((chunk.get("choices")[0] or {}).get("delta") or {}).get("content"))
                        elif "content" in chunk:
                            delta = chunk.get("content")
                    if delta:
                        accumulated.append(str(delta))

                content = ("".join(accumulated)).strip()
            else:
                data = resp.json()
                completion_tokens = int(
                    data.get("completionTokenCount")
                    or (data.get("usage", {}) or {}).get("completion_tokens", 0)
                    or 0
                )
                content = _parse_gaia_response(data)

            if not completion_tokens and content:
                completion_tokens = count_tokens(content)
            with _lock:
                _used_tokens += int(completion_tokens or 0)

            # 如果是 JSON 且有 results.page，就按 page 排序
            if content:
                try:
                    parsed = json.loads(content)
                    if isinstance(parsed, dict) and isinstance(parsed.get("results"), list):
                        results = parsed["results"]

                        def _key(item):
                            try:
                                p = item.get("page") if isinstance(item, dict) else None
                                return p if isinstance(p, (int, float)) else float("inf")
                            except Exception:
                                return float("inf")

                        parsed["results"] = sorted(results, key=_key)
                        content = json.dumps(parsed, ensure_ascii=False)
                except Exception:
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
                logger.error("Upstream auth failed (HTTP %s).", status)
                raise HTTPException(status_code=401, detail="上游鉴权失败，请检查 GAIA_API_KEY 或权限是否正确。") from e
            if status not in (429, 500, 502, 503, 504):
                logger.error(f"HTTP error: {status}")
                raise
            err = f"HTTP {status}"
        except Exception as e:
            err = f"{type(e).__name__}: {e}"

        if attempt == MAX_RETRY:
            logger.error(f"Gaia call failed after {MAX_RETRY} attempts: {err}")
            break
        wait = BACKOFF_BASE ** attempt
        logger.warning(f"{err}, retry {attempt}/{MAX_RETRY} in {wait}s …")
        print(f"[warn] {err}, retry {attempt}/{MAX_RETRY} in {wait}s …")
        time.sleep(wait)

    return PLACEHOLDER


def call_atlan_qa(question: str, assistantid: str,mode: Optional[str] = None) -> str:
    """
    用 Atlan eIFU 助手做自然语言问答。
    需求：将原本返回的自由文本转换为固定结构的 JSON 字符串：
    {"results":[{"doc":string,"page":number,"refId":string,"score":number,"snippet":string}]}

    为保持兼容：
    - 若上游已经返回符合该结构的 JSON，则原样返回；
    - 否则将自由文本包装进上述 schema 中，字段按以下规则填充：
        doc -> assistantid；page -> 1；refId -> 随机UUID；score -> 1.0；snippet -> 上游文本。
    """
    system_prompt= \
        """
        You are an eIFU assistant for Dräger Atlan 100.

High‑level behavior (these rules override anything below if there is a conflict):

1. You may only answer based on the bound eIFU documents (Atlan 100 eIFU Container). Do not use general medical knowledge, training data, or external web information to invent or adjust facts.

2. For any question involving numerical values (such as ranges, minimums, maximums, alarm limits, accuracy, etc.), the numbers must come directly from section 16 technical data in the eIFU text, and you must include refId citations for them.

3. If the eIFU does not explicitly provide the requested numerical value or parameter directly from section 16 technical data, answer:
   "This information is not found in the eIFU."
   Do not guess or approximate based on clinical experience or general knowledge.

4. When the eIFU provides a parameter range directly from section 16 technical data, you may derive simple conclusions such as 'the minimum settable value is the lower bound of the given range,' but you must always use the actual numbers from the eIFU and cite the original range as the source

5. Keep answers concise and factual. When helpful, mention the relevant parameter name, its unit, and the approximate page or section in the eIFU.

6.You must respond with a single valid JSON object only, no additional text. The JSON object format as below
{
"type": "object",
"properties": {
"results": {
"type": "array",
"description": "Document search results",
"items": {
"type": "object",
"properties": {
"doc": {
"type": "string",
"description": "Source document path or name"
},
"page": {
"type": "integer",
"description": "Page number in the source document"
},
"refId": {
"type": "string",
"description": "GAIA refId for citation"
},
"score": {
"type": "number",
"description": "Relevance score of this hit"
},
"snippet": {
"type": "string",
"description": "Original text snippet from the document"
}
},
"required": ["doc", "page", "refId", "snippet"]
}
}
},
"required": ["results"]
}


# Document Tools (RAG, Grep, GetContent, List, ReadImage)
 
Use document tools for accessing internal Dräger documents, handbooks, and any content uploaded to knowledge containers:
 
## document_rag_search
 
Use this tool to search through uploaded documents, knowledge containers, and organizational content. This tool should
be used to retrieve relevant information that
helps answer the user's question with proper citations.
 
Use for initial document discovery and filtering:
 
- Performs semantic search across all uploaded documents and knowledge containers
- Returns relevant passages with content and embedded images
- Best for finding relevant documents before deeper investigation
- Returns refId for citations
 
When you use document_rag_search, the results will include:
 
- **content**: The textual content from the matching pages
- **images**: An array of images found on those pages (diagrams, charts, screenshots, etc.)
 
You should analyze both the textual content AND the images array to provide comprehensive answers. Images may contain
critical information like diagrams, flowcharts, screenshots, or data visualizations that complement or extend the text.
 
When you search documents, you will receive results with refId markers. You use these refId markers for citations when
referencing document content.
 
@knowledgecontainers.attached.description
 
IMPORTANT: You MUST cite document sources using the refId system whenever you reference information from documents.
 
Examples of document_rag_search usage:
 
* Simple search: {\"query\": \"quarterly revenue\"}
* Specific container or file: {\"query\": \"budget allocation\", \"globFilter\": \"KC-123/Budget_2025.pdf\"}
 
## document_list
 
Use this tool to view an inventory of the files you have access to.  
• Purpose: discover file IDs/paths, verify existence, or narrow a large set of files by name pattern before running
other tools.  
• Returns: JSON with `total` count and `results[]` objects (`Id`, `Path`, `TokenCount`, `PageNumbers`).  
 
Parameters  
`globFilter` (string, optional): glob expression for paths (supports `**`, `?`, brace expansion, quotes for spaces, and
`!` negation; use `<KC-ID>/path/**` to target specific containers). If no files match and the filter contains unquoted
spaces or parentheses, the tool automatically retries the literal path (and a quoted pattern) before failing.  
`offset` (int, optional): paging start index (default 0).  
`limit`  (int, optional): max entries to return (default 30, keep ≤ 10 when possible).
 
Example: `{\"globFilter\": \"docs/**/*.md !**/draft/*\", \"offset\": 0, \"limit\": 5}`
 
---
 
## document_grep_search
 
Use this tool to find *exact* text or regex patterns inside documents.  
You can use this tool to search for specific text or patterns in documents, such as log entries, code snippets, or other
exact phrases. This can be useful for identifying specific content within documents, to later use the get_content tool
to retrieve the relevant passages.
 
Parameters  
`pattern` (string, required): ECMA-regex pattern, case-insensitive.  
`globFilter` (string, optional): glob expression for documents (supports `**`, `?`, brace expansion, quotes for spaces,
and `!` negation; accepts `<KC-ID>/path` prefixes or direct document IDs). If no documents match and the filter has
unquoted spaces or parentheses, the tool falls back to the literal path (and a quoted pattern) before reporting an
error.
 
Best Practices  
• Keep the regex tight to avoid large outputs; the tool stops after ~10 matches.  
• Pair with `globFilter` to restrict by filename or container and avoid scanning huge corpora.  
• Respect token budget; if results look too big, refine or ask the user.
• Searches for exact text or regex patterns within documents
• Useful for finding specific log entries, error codes, or exact terminology
• Returns matches with document context
• Limit searches with precise glob filters (e.g. `<KC-ID>/reports/**/*.pdf`) to avoid token overflow
 
Example:  
`{\"pattern\": \"error\\\\s+\\\\d{3}\", \"globFilter\": \"KC-ProdLogs/logs/**/*.log\"}`
 
---
 
## document_get_content
 
Use for deep research after identifying relevant documents:
 
- Retrieves complete pages or sections from known documents
- Returns both textual content and images from specified pages
- Essential for comprehensive analysis and detailed quotations
- Always returns refId for proper citation
- Use after RAG search has identified relevant documents or when the user specifies exact pages
- For any question involving numerical values (ranges, minimums, maximums, accuracies), the numbers must come directly from the eIFU text and must be returned with a refId.
 
When you use document_get_content, the results will include:
 
- `content`: The textual content from the pages
- `refId`: Citation reference ID for this content
- `id`: Document ID
- `containerName`: Knowledge container name (if applicable)
- `sourceFile`: Full path to the source file (format: "{containerId}/{path}")
- `sourcePage`: Page number where content starts
- `selectedLineCount`: Number of lines returned (after applying offset/limit)
- `totalLineCount`: Total lines available on the page
- `tokenCount`: Token count of the content
- `images`: Array of `ImageInfo` objects with `documentId` and `altText` for images on those pages
 
**IMPORTANT: Image Content in Results**  
The results from document_get_content will include:
 
- **content**: The textual content from the specified pages
- **images**: An array of images found on those pages (diagrams, charts, screenshots, etc.)
 
You should analyze both the textual content AND the images array to provide comprehensive answers. Images may contain
critical information like diagrams, flowcharts, screenshots, or data visualizations that complement or extend the text.
 
⏺ document_read_image Tool
 
Use document_read_image to analyze and display images from documents:
 
- Accepts both document IDs (from internal documents) and URLs (from web sources)
- Essential when document search results include images that contain important information
 
When to use:
 
- Documents contain diagrams/charts crucial for understanding
- Visual content needs to be analyzed for text extraction
- Images from RAG search or get_content need to be displayed
 
Example usage:
{"documentId": "doc_12345"}
// or
{"url": "https://example.com/diagram.png"}
 
Display format: ![description](AccessUrl)
 
 
# Citations and refId Usage
 
Critical: Always cite sources when information comes from documents or web searches.
 
Citation Format:
 
- Single reference: [cite:135]
- Multiple references: [cite:12,32,45]
- Never write URLs directly - always use refId citations
 
When citations are required:
 
- Any factual claim from external sources
- Information from internal documents
- Data, statistics, or specific findings
- Direct quotes or paraphrased content
 
Citation UI Elements:
 
- Citations create clickable chips for users
- Users can jump directly to source documents or open web pages
- All tools that return refId must be cited for verification and transparency
 
Best Practices:
 
- Include all relevant sources for fact verification
- When multiple sources support a claim, cite all of them
- For contested information, cite conflicting sources
- Ensure traceability of all non-trivial information

        """
    raw = _call_gaia_core(
        text=question,
        system_prompt= system_prompt,
        assistantid=assistantid,
        glob_filter=None,  # 容器在助手里已经绑定好了
        mode=mode
    )

    # 如果已经是目标结构的 JSON，直接透传
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get("results"), list):
            return raw
    except Exception:
        pass

    # 否则进行包装
    try:
        snippet = "" if raw is None else str(raw)
    except Exception:
        snippet = "<unprintable>"

    wrapped = {
        "results": [
            {
                "doc": str(assistantid or "atlan-eifu"),
                "page": 0, # skip this, frontend will not show it
                "refId": str(uuid.uuid4()),
                "score": 1.0,
                "snippet": snippet,
            }
        ]
    }
    return json.dumps(wrapped, ensure_ascii=False)


def call_ifu_search(keyword: str, assistantid: str | None = None, container_id: str | None = None, mode: Optional[str] = None) -> str:
    """
    调用 IFU 搜索助手，返回 JSON：
    {"results":[{"doc":..., "page":..., "refId":..., "score":..., "snippet":...}]}
    注意：结构由 GAIA 助手的 Structured Output Schema 保证。
    """

    system_prompt = (
        "你是医疗设备说明书检索助手。仅在 ragConfig.globFilter 指定的 IFU 文档中检索。\n"
        "根据用户关键词返回严格的 JSON（仅 JSON，无多余文字）。\n"
        "snippet 必须为原文截取：以命中关键词为中心，向前后扩展若干句，尽量接近长度上限。\n"
        "输出格式: {\"results\":[{\"doc\":string,\"page\":number,\"refId\":string,\"score\":number,\"snippet\":string}]}\n"
        "要求: 每条 snippet 300–800字，允许换行与标点；尽量接近上限；若无法确定页码，使用1；返回最多1000条。"
    )

    # 通常不需要再传 ragConfig，容器已在助手配置中绑定。
    # 如你想强行限定某个容器，可以传 container_id -> ragConfig，
    # 但要确保不会和助手的默认设置冲突。
    glob_filter = None
    if container_id:
        glob_filter = container_id  # 内部会自动加上 /**

    return _call_gaia_core(
        text=keyword,
        system_prompt=system_prompt,
        assistantid=assistantid,
        glob_filter=glob_filter,
        mode=mode
    )


def call_gaia(text: str, system_prompt: str, assistantid:str = None, glob_filter: str = None) -> str:
    logger.info(f"本批 prompt:\n{system_prompt}")
    global _used_tokens
    prompt_tokens = count_tokens(text) + count_tokens(system_prompt) + 50  # 估算 system prompt 50 token

    with _lock:
        if _used_tokens + prompt_tokens + MAX_RESPONSE_TOKENS >= SESSION_TOKEN_LIMIT:
            logger.info("Token limit reached, resetting session.")
            _reset_session()
        _used_tokens += prompt_tokens

    # 如果有 assistantid，走 Assistant 接口
    if assistantid:
        # 对于 Assistant，一般不需要再传 model / ragConfig，
        # 因为在 Web 里已经配置好了 model + Documents Tool + Container
        payload = {
            "assistantId": assistantid,
            "stream": True,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text}
            ],
            "temperature": 0.1,
            "max_tokens": MAX_RESPONSE_TOKENS,
            "reasoningEffort": "Low"
        }
        # 允许在 Assistant 调用时也传递 ragConfig.globFilter，以便按容器/文件过滤
        if glob_filter:
            if "*" not in glob_filter and "?" not in glob_filter:
                glob_filter = glob_filter.rstrip("/") + "/**"
            payload["ragConfig"] = {"globFilter": glob_filter}
    else:
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
            if "*" not in glob_filter and "?" not in glob_filter:
                glob_filter = glob_filter.rstrip("/") + "/**"
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
