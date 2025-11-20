from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field
import os
import logging
import json
import threading
from pathlib import Path

from .gaia_client import call_gaia, call_ifu_search, call_atlan_qa

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
    assistantId: str | None = Field(None, description="GAIA 助手/Agent ID；如果提供，将走 Assistant 路线（推荐）")


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


# =============================
# Documents Tool 专用端点
# =============================
from typing import Optional, Any


class DocSearchResultItem(BaseModel):
    doc: str
    page: int
    refId: str
    snippet: str


class DocSearchRequest(BaseModel):
    query: str = Field(..., description="用户输入的检索关键词或问题")
    globFilter: Optional[str] = Field(None, description="限定的 GAIA 知识容器或文件，如 '<KC-ID>/**'")
    assistantId: Optional[str] = Field(None, description="GAIA 助手 ID（已绑定容器时可传），可与 globFilter 同时使用")


class DocSearchResponse(BaseModel):
    results: list[DocSearchResultItem]


@app.post("/api/doc_search", response_model=DocSearchResponse)
def doc_search(req: DocSearchRequest):
    q = (req.query or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="query 不能为空")

    # 系统提示：显式要求使用 Documents 搜索，并严格输出 JSON（仅结构，不要其它文字）
    system_prompt = (
        "你是文档检索与结构化助手。\n"
        "必须使用 GAIA 的 Documents 搜索工具（document_rag_search 或后端已集成的 RAG 能力），\n"
        "仅在 ragConfig.globFilter 指定的容器/文档范围内检索（若提供）。\n"
        "严格返回 JSON，且只返回如下结构，不要任何多余文字：\n"
        "{\"results\":[{\"doc\":string,\"page\":number,\"refId\":string,\"snippet\":string}]}\n"
        "要求：\n"
        "- doc: 使用来源的 sourceFile 或文档可辨识名称；\n"
        "- page: 使用命中内容的页码；\n"
        "- refId: 使用检索结果中的 refId；\n"
        "- snippet: 直接使用命中文本片段，不要改写与翻译，可包含换行；\n"
        "- 只返回与问题强相关的若干条记录。\n"
    )

    try:
        content = call_gaia(
            text=q,
            system_prompt=system_prompt,
            assistantid=(req.assistantId or os.getenv("GAIA_ASSISTANT_ID")),
            glob_filter=req.globFilter,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("doc_search 上游错误: %s", e)
        raise HTTPException(status_code=502, detail="上游服务异常，请稍后再试。") from e

    # 解析 JSON；若非 JSON，返回空数组以保证前端稳定
    results: list[DocSearchResultItem] = []
    if content:
        try:
            data = json.loads(content)
            if isinstance(data, dict):
                arr = data.get("results", [])
            elif isinstance(data, list):
                arr = data
            else:
                arr = []

            for it in arr or []:
                if not isinstance(it, dict):
                    continue
                # 灵活兜底字段名，保证 doc/page/refId/snippet 存在
                doc = (
                    it.get("doc")
                    or it.get("sourceFile")
                    or it.get("id")
                    or ""
                )
                page = (
                    it.get("page")
                    or it.get("sourcePage")
                    or 1
                )
                ref_id = it.get("refId") or it.get("refID") or ""
                snippet = it.get("snippet") if it.get("snippet") is not None else it.get("content")
                # 严格不修改 snippet 内容
                if not isinstance(snippet, str):
                    continue
                try:
                    page_int = int(page)
                except Exception:
                    page_int = 1
                if not isinstance(doc, str):
                    doc = str(doc)
                if not isinstance(ref_id, str):
                    ref_id = str(ref_id)
                results.append(DocSearchResultItem(doc=doc, page=page_int, refId=ref_id, snippet=snippet))
        except Exception as e:
            logger.warning("doc_search 返回非 JSON 或解析失败: %s", e)

    return DocSearchResponse(results=results)


class FormatSnippetsRequest(BaseModel):
    items: list[dict] = Field(default_factory=list, description="包含 doc/page/refId/snippet 字段的列表")


@app.post("/api/format_snippets", response_model=DocSearchResponse)
def format_snippets(req: FormatSnippetsRequest):
    # 不修改 snippet 文本，仅按目标结构组织
    results: list[DocSearchResultItem] = []
    for it in req.items:
        if not isinstance(it, dict):
            continue
        doc = it.get("doc") or it.get("sourceFile") or it.get("id") or ""
        page = it.get("page") or it.get("sourcePage") or 1
        ref_id = it.get("refId") or it.get("refID") or ""
        snippet = it.get("snippet") if it.get("snippet") is not None else it.get("content")
        if not isinstance(snippet, str):
            continue
        try:
            page_int = int(page)
        except Exception:
            page_int = 1
        if not isinstance(doc, str):
            doc = str(doc)
        if not isinstance(ref_id, str):
            ref_id = str(ref_id)
        results.append(DocSearchResultItem(doc=doc, page=page_int, refId=ref_id, snippet=snippet))
    return DocSearchResponse(results=results)


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
def search_ifu(keyword: str, assistantid: Optional[str] = None, containerid: Optional[str] = None, mode: Optional[str] = None):
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
        # 根据前端传入的 mode 决定调用后端能力：
        # - mode=="ask" 走问答：call_atlan_qa(question=keyword, assistantid=assistantID)
        # - 其它（含未提供）走搜索：call_ifu_search(keyword=f"keyword: {keyword}", assistantid=assistantID, container_id=containerid)
        call_mode = (mode or "").strip().lower()
        if call_mode == "ask":
            content = call_atlan_qa(question=keyword, assistantid=assistantID, mode=mode)
        else:
            content = call_ifu_search(keyword=keyword, assistantid=assistantID, container_id=containerid, mode=mode)
        if content:
            try:
                data = json.loads(content)
                results = data.get("results", []) if isinstance(data, dict) else []
                # Basic validation of result items
                valid = []
                for it in results:
                    doc = str(it.get("doc", assistantID)).strip() if isinstance(it, dict) else ""
                    page = int(it.get("page", 0)) if isinstance(it, dict) else 0
                    snippet = str(it.get("snippet", "")).strip() if isinstance(it, dict) else ""
                    if doc:
                        valid.append({
                            "doc": doc,
                            "page": max(0, page),
                            "snippet": snippet[:3000]
                        })
                return {"results": valid}
            except Exception:
                # If upstream returns non-JSON, 为了兼容前端，包装为一条记录（使用 assistantID 作为 doc，page=0）
                snippet = str(content) if content is not None else ""
                return {"results": [{"doc": assistantID, "page": 0, "snippet": snippet[:3000]}]}
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


# =============================
# Simple file-based voting
# =============================
class VoteRequest(BaseModel):
    type: str = Field(..., description="投票类型：up 或 down")

class VoteCounts(BaseModel):
    up: int = 0
    down: int = 0

_votes_lock = threading.Lock()
_votes_file = Path(__file__).with_name("votes.json")


def _read_votes() -> VoteCounts:
    try:
        if not _votes_file.exists():
            return VoteCounts(up=0, down=0)
        data = json.loads(_votes_file.read_text(encoding="utf-8"))
        up = int(data.get("up", 0))
        down = int(data.get("down", 0))
        return VoteCounts(up=up, down=down)
    except Exception:
        # If file corrupted, reset
        return VoteCounts(up=0, down=0)


def _write_votes(vc: VoteCounts):
    tmp = _votes_file.with_suffix(".json.tmp")
    data = {"up": int(vc.up), "down": int(vc.down)}
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_votes_file)


@app.get("/api/vote", response_model=VoteCounts)
@app.get("/vote", response_model=VoteCounts)
def get_votes():
    with _votes_lock:
        return _read_votes()


@app.post("/api/vote", response_model=VoteCounts)
@app.post("/vote", response_model=VoteCounts)
def post_vote(req: VoteRequest):
    t = (req.type or "").strip().lower()
    if t not in ("up", "down"):
        raise HTTPException(status_code=400, detail="type 必须为 up 或 down")
    with _votes_lock:
        vc = _read_votes()
        if t == "up":
            vc.up += 1
        else:
            vc.down += 1
        _write_votes(vc)
        return vc
