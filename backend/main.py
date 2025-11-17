from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field
import os
import logging
import json

from backend.gaia_client import call_gaia

logger = logging.getLogger("api")
LOG_PAYLOADS = os.getenv("GAIA_LOG_PAYLOADS", "true").lower() in ("1", "true", "yes", "on")
MAX_LOG_CHARS = int(os.getenv("GAIA_MAX_LOG_CHARS", "2000"))

def _clip_for_log(s) -> str:
    try:
        t = "" if s is None else str(s)
    except Exception:
        t = "<unprintable>"
    if len(t) <= MAX_LOG_CHARS:
        return t
    return f"{t[:MAX_LOG_CHARS]}... [truncated {len(t) - MAX_LOG_CHARS} chars]"

app = FastAPI(title="Gaia Proxy API", version="0.2.0")

# CORS for local dev and miniprogram cloud envs
origins = os.getenv("CORS_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in origins.split(",") if o.strip()] if origins else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

DEFAULT_SYSTEM_PROMPT = os.getenv("DEFAULT_SYSTEM_PROMPT", "你是一个有帮助的助手，请用简洁中文回答。")


class GaiaRequest(BaseModel):
    text: str = Field(..., description="用户输入的文本")
    system_prompt: str | None = Field(None, description="系统提示词，可选")


class GaiaResponse(BaseModel):
    content: str


@app.get("/health")
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def root():
    # Simple landing page to avoid 404 and help users discover endpoints
    return (
        "<html><head><title>Gaia Proxy API</title></head>"
        "<body style='font-family:system-ui,Segoe UI,Arial,sans-serif;padding:24px;'>"
        "<h2>Gaia Proxy API</h2>"
        "<p>Service is running. Useful links:</p>"
        "<ul>"
        "<li><a href='/health'>/health</a></li>"
        "<li><a href='/docs'>/docs</a> (Swagger UI)</li>"
        "</ul>"
        "</body></html>"
    )


@app.get("/favicon.ico")
def favicon():
    # Return empty 204 to suppress 404 logs for browsers requesting favicon
    return Response(status_code=204)


@app.post("/api/gaia", response_model=GaiaResponse)
def api_gaia(req: GaiaRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    """ system_prompt = (req.system_prompt or DEFAULT_SYSTEM_PROMPT).strip() """
    system_prompt = """
                    If the user asks for anything similar to "Vista" , "Vista 120" ," Vista 300" , "Imprivata", "Epic" ,you must always look up in "knowledge and information about the Vista patient monitor" containers Citable tools allow you to cite external tool sources in your text.
                     To cite a source, follow these steps:
                    Append a footnote marker that you should never escape [^refId] (for example [^1]).
                    - immediately following the relevant information. You find the refId in the search result you are referring to.
                     At the end of the text, include the footnote details corresponding to each marker.
                     Ensure these footnotes are also formatted correctly in Markdown, using the syntax [^refId]: refSummary (e.g., [^1]: source summary) .
                     Replace refSummary with a very short summary (about less than 8 words, do not multline!) of the information source within the search result. An example format:

                    Lorem ipsum dolores[^1].

                    [^1]: source summary


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
                    """.strip()

    if LOG_PAYLOADS:
        logger.info("API 收到请求: 用户输入=%s | 系统提示词=%s", _clip_for_log(text), _clip_for_log(system_prompt))
    try:
        content = call_gaia(text=text, system_prompt=system_prompt, glob_filter="41f4f2b3-4ae1-42f3-b824-b7430ffb45c5")
        if LOG_PAYLOADS:
            logger.info("API 返回给前端的内容: %s", _clip_for_log(content))
        return GaiaResponse(content=content)
    except HTTPException as e:
        # Pass through but also log
        logger.warning("API 转发异常: %s", getattr(e, "detail", e))
        raise
    except Exception as e:
        logger.exception("API 内部错误: %s", e)
        # hide internal detail from client
        raise HTTPException(status_code=502, detail="上游服务异常，请稍后再试。") from e


# Run (Windows recommended): python -m uvicorn backend.main:app --reload --port 9000
# Alt: py -m uvicorn backend.main:app --reload --port 9000
# If uvicorn is on PATH: uvicorn backend.main:app --reload --port 9000

# =============================
# IFU endpoints for mini-program
# =============================
from typing import Optional
from urllib.parse import unquote

# Simple in-memory IFU mapping and mock data
_IFU_MAP = {
    "Vista 300": {"assistantid":"fab9226e-cb6b-4ced-9310-e3560804e675","containerid":"41f4f2b3-4ae1-42f3-b824-b7430ffb45c5"},
    "Vista 120": {"assistantid":"fab9226e-cb6b-4ced-9310-e3560804e675","containerid":"41f4f2b3-4ae1-42f3-b824-b7430ffb45c5"},
    "Atlan 100": {"assistantid":"45bcc1e2-79f6-46bf-94fc-3e5c94168ee7","containerid":"e05d7522-891a-416a-8bed-cbefc0c64209"},
    "Epic": {"assistantid":"fab9226e-cb6b-4ced-9310-e3560804e675","containerid":"41f4f2b3-4ae1-42f3-b824-b7430ffb45c5"}
}


@app.get("/get_ifu")
@app.get("/api/get_ifu")
def get_ifu(model: str):
    model = (model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model 不能为空")
    # 支持宽松匹配：完全匹配优先，其次大小写不敏感包含
    if model in _IFU_MAP:
        result = _IFU_MAP[model]
    else:
        low = model.lower()
        for k, v in _IFU_MAP.items():
            if low in k.lower():
                result = v
                break
    if not result:
        return {"assistantid": "", "containerid": ""}
    return {"assistantid": result["assistantid"], "containerid": result["containerid"]}


@app.get("/search_ifu")
@app.get("/api/search_ifu")
def search_ifu(keyword: str, assistantid: Optional[str] = None, containerid: Optional[str] = None):
    keyword = (keyword or "").strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="keyword 不能为空")
    localassistantid = (assistantid or "").strip()
    if not localassistantid:
        raise HTTPException(status_code=400, detail="必须提供 assistantid 才能检索")

    # Use GAIA restricted search only; no local mock fallback
    assistantID = unquote(localassistantid)
    try:
        system_prompt = (
            "你是医疗设备说明书检索助手。仅在 ragConfig.globFilter 指定的 IFU 文档中检索。\n"
            "根据用户关键词返回严格的 JSON（仅 JSON，无多余文字）。\n"
            "snippet 必须为原文截取：以命中关键词为中心，向前后扩展若干句，尽量接近长度上限。\n"
            "输出格式: {\"results\":[{\"doc\":string,\"page\":number,\"refId\":string,\"score\":number,\"snippet\":string}]}\n"
            "要求: 每条 snippet 300–800字，允许换行与标点；尽量接近上限；若无法确定页码，使用1；返回最多1000条。"
        )
        content = call_gaia(text=f"keyword: {keyword}", system_prompt=system_prompt, assistantid=assistantID, glob_filter=containerid)
        if content:
            try:
                data = json.loads(content)
                results = data.get("results", []) if isinstance(data, dict) else []
                # Basic validation of result items
                valid = []
                for it in results:
                    doc = str(it.get("doc", assistantID)).strip() if isinstance(it, dict) else ""
                    page = int(it.get("page", 1)) if isinstance(it, dict) else 1
                    snippet = str(it.get("snippet", "")).strip() if isinstance(it, dict) else ""
                    if doc:
                        valid.append({
                            "doc": doc,
                            "page": max(1, page),
                            "snippet": snippet[:3000]
                        })
                return {"results": valid}
            except Exception:
                # If GAIA returns non-JSON, surface empty results
                return {"results": []}
        return {"results": []}
    except HTTPException:
        # bubble up GAIA auth errors, etc.
        raise
    except Exception:
        # On any failure, return empty results without using local mocks
        return {"results": []}


@app.get("/get_content")
@app.get("/api/get_content")
def get_content(doc_path: str, page: int = 1):
    # Local mock content has been removed; this endpoint is no longer supported.
    raise HTTPException(status_code=501, detail="本地模拟内容已移除：/get_content 不再提供服务，请改用 GAIA 检索与内容获取。")
