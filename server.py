"""
server.py — FastAPI backend for RAG Document Parser
====================================================

Replaces the Gradio app.py with a REST + SSE API backed by a
clean HTML/CSS/JS single-page app.

Start:
    python server.py
    # or
    uvicorn server:app --host 0.0.0.0 --port 7860 --reload
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator
from urllib.parse import urlparse

import uvicorn
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ── Paths ─────────────────────────────────────────────────────────────────────

ROOT       = Path(__file__).resolve().parent
KB_ROOT    = ROOT / "knowledge_bases"
MODELS_DIR = ROOT / "models"
STATIC_DIR = ROOT / "static"

KB_ROOT.mkdir(exist_ok=True)
MODELS_DIR.mkdir(exist_ok=True)

SUPPORTED_EXTS = {".pdf", ".docx", ".doc"}

MODELS_INFO: dict[str, dict] = {
    "lighton": {
        "id":    "lightonai/LightOnOCR-2-1B",
        "name":  "LightOnOCR-2-1B",
        "label": "LightOnOCR (all languages)",
        "local": MODELS_DIR / "LightOnOCR-2-1B",
        "size":  "~3 GB",
    },
}

# ── In-process event bus ──────────────────────────────────────────────────────

# job_id → {"events": [...], <latest state fields>}
_job_state: dict[str, dict] = {}
_job_queues: dict[str, list[asyncio.Queue]] = {}
_job_lock = threading.Lock()
_main_loop: asyncio.AbstractEventLoop | None = None
_executor = ThreadPoolExecutor(max_workers=2)
_cancelled_jobs: set[str] = set()


class _CancelledError(Exception):
    """Raised inside _run_parse when the user cancels a job."""


def _emit(job_id: str, data: dict) -> None:
    """Thread-safe: store event and push to all SSE subscribers."""
    with _job_lock:
        job = _job_state.setdefault(job_id, {"events": []})
        job.update(data)
        job["events"].append(data)

    if _main_loop and not _main_loop.is_closed():
        asyncio.run_coroutine_threadsafe(_push_event(job_id, data), _main_loop)


async def _push_event(job_id: str, data: dict) -> None:
    for q in _job_queues.get(job_id, []):
        await q.put(data)


# ── KB helpers ────────────────────────────────────────────────────────────────

def _safe_kb_path(kb: str) -> Path:
    p = (KB_ROOT / kb).resolve()
    if not str(p).startswith(str(KB_ROOT.resolve())):
        raise HTTPException(400, "Invalid KB name")
    return p


def _status_file(kb: str) -> Path:
    return _safe_kb_path(kb) / "status.json"


def _load_status(kb: str) -> dict:
    p = _status_file(kb)
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def _save_status(kb: str, status: dict) -> None:
    _status_file(kb).write_text(
        json.dumps(status, ensure_ascii=False, indent=2), "utf-8"
    )


def _files_dir(kb: str) -> Path:
    d = _safe_kb_path(kb) / "files"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load_url_sources(kb: str) -> list[dict]:
    p = _safe_kb_path(kb) / "sources" / "urls.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else []


def _save_url_sources(kb: str, sources: list[dict]) -> None:
    d = _safe_kb_path(kb) / "sources"
    d.mkdir(parents=True, exist_ok=True)
    (d / "urls.json").write_text(
        json.dumps(sources, ensure_ascii=False, indent=2), "utf-8"
    )


def _url_to_slug(url: str) -> str:
    parsed = urlparse(url)
    slug = (parsed.netloc + parsed.path).lstrip("/")
    slug = re.sub(r"[^a-zA-Z0-9_-]", "_", slug)
    slug = re.sub(r"_+", "_", slug).strip("_")
    if len(slug) > 80:
        h = hashlib.sha1(url.encode()).hexdigest()[:8]
        slug = slug[:71] + "_" + h
    return slug or hashlib.sha1(url.encode()).hexdigest()[:16]


def _list_kbs() -> list[dict]:
    result = []
    for p in sorted(KB_ROOT.iterdir()):
        if not p.is_dir():
            continue
        status: dict = {}
        sp = p / "status.json"
        if sp.exists():
            try:
                status = json.loads(sp.read_text("utf-8"))
            except Exception:
                pass
        files_dir = p / "files"
        files     = list(files_dir.glob("*")) if files_dir.exists() else []
        file_total = sum(1 for f in files if f.suffix.lower() in SUPPORTED_EXTS)
        urls_file  = p / "sources" / "urls.json"
        url_total  = 0
        if urls_file.exists():
            try:
                url_total = len(json.loads(urls_file.read_text("utf-8")))
            except Exception:
                pass
        total = file_total + url_total
        done  = sum(1 for v in status.values() if "✅" in str(v))
        result.append({
            "name":  p.name,
            "total": total,
            "done":  done,
        })
    return result


def _list_files(kb: str) -> list[dict]:
    status = _load_status(kb)
    files  = []
    d = _safe_kb_path(kb) / "files"
    if d.exists():
        for f in sorted(d.iterdir()):
            if f.suffix.lower() not in SUPPORTED_EXTS:
                continue
            key      = f.name
            st       = status.get(key, "pending")
            out_file = _safe_kb_path(kb) / "output" / (f.stem + ".md")
            files.append({
                "key":        key,
                "name":       f.name,
                "size":       f.stat().st_size,
                "status":     st,
                "has_output": out_file.exists(),
            })
    return files


# ── Parsing in background thread ──────────────────────────────────────────────

def _run_parse(job_id: str, kb: str, filename: str) -> None:
    key = filename
    try:
        if job_id in _cancelled_jobs:
            _cancelled_jobs.discard(job_id)
            _emit(job_id, {"type": "cancelled", "message": "Cancelled"})
            return
        _emit(job_id, {"type": "status", "message": "Preparing…"})

        from parsers.base_parser import convert_docx_to_pdf, pdf_to_images

        input_path = _files_dir(kb) / filename
        if not input_path.exists():
            raise FileNotFoundError(f"Input not found: {input_path}")

        if input_path.suffix.lower() in (".docx", ".doc"):
            _emit(job_id, {"type": "status", "message": "Converting DOCX → PDF…"})
            pdf_path = convert_docx_to_pdf(input_path)
        else:
            pdf_path = input_path

        _emit(job_id, {"type": "status", "message": "Rasterising pages…"})
        images = pdf_to_images(pdf_path)
        total  = len(images)
        _emit(job_id, {"type": "pages", "total": total,
                        "message": f"Found {total} page(s)"})

        def _progress(page: int, of: int) -> None:
            if job_id in _cancelled_jobs:
                raise _CancelledError("Cancelled by user")
            _emit(job_id, {"type": "progress", "page": page, "total": of,
                            "message": f"Page {page}/{of}"})

        def _token_cb(text: str) -> None:
            _emit(job_id, {"type": "token", "text": text})

        _emit(job_id, {"type": "status", "message": "Loading model…"})

        from parsers.lighton_parser import LightOnParser
        parser = LightOnParser()

        markdown = parser.parse_pages(images, progress_cb=_progress, token_cb=_token_cb)
        parser.unload()

        out_dir  = _safe_kb_path(kb) / "output"
        out_dir.mkdir(exist_ok=True)
        out_path = out_dir / (Path(filename).stem + ".md")
        out_path.write_text(markdown, encoding="utf-8")

        status      = _load_status(kb)
        status[key] = "✅ done"
        _save_status(kb, status)

        _emit(job_id, {"type": "done", "message": "Parsing complete!"})

    except _CancelledError:
        _cancelled_jobs.discard(job_id)
        _emit(job_id, {"type": "cancelled", "message": "Cancelled by user"})

    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
        try:
            status      = _load_status(kb)
            status[key] = f"❌ {err[:120]}"
            _save_status(kb, status)
        except Exception:
            pass
        _emit(job_id, {"type": "error", "message": err})


def _convert_for_preview(src: Path, dest: Path) -> None:
    """Convert a DOCX/DOC file to PDF and write it to *dest*."""
    from parsers.base_parser import convert_docx_to_pdf
    tmp_pdf = convert_docx_to_pdf(src)
    shutil.copy2(str(tmp_pdf), str(dest))
    tmp_pdf.unlink(missing_ok=True)
    try:
        tmp_pdf.parent.rmdir()
    except OSError:
        pass


def _run_url_fetch(job_id: str, kb: str, url: str, slug: str) -> None:
    key = f"url:{slug}"
    try:
        if job_id in _cancelled_jobs:
            _cancelled_jobs.discard(job_id)
            _emit(job_id, {"type": "cancelled", "message": "Cancelled"})
            return

        _emit(job_id, {"type": "status", "message": "Fetching page…"})

        import trafilatura
        downloaded = trafilatura.fetch_url(url)
        if not downloaded:
            raise RuntimeError("Could not download page content")

        _emit(job_id, {"type": "status", "message": "Extracting content…"})

        result = trafilatura.extract(
            downloaded,
            output_format="markdown",
            include_tables=True,
            include_links=True,
            url=url,
            favor_recall=True,
        )
        if not result:
            raise RuntimeError("No extractable content found at this URL")

        # Extract page title from metadata
        title = slug
        meta_json = trafilatura.extract(downloaded, output_format="json", with_metadata=True)
        if meta_json:
            try:
                meta_data = json.loads(meta_json)
                title = meta_data.get("title") or slug
            except Exception:
                pass

        out_dir  = _safe_kb_path(kb) / "output"
        out_dir.mkdir(exist_ok=True)
        out_path = out_dir / f"{slug}.md"
        out_path.write_text(result, encoding="utf-8")

        # Update stored title
        sources = _load_url_sources(kb)
        for src in sources:
            if src.get("slug") == slug:
                src["title"] = title
                break
        _save_url_sources(kb, sources)

        status      = _load_status(kb)
        status[key] = "✅ done"
        _save_status(kb, status)

        _emit(job_id, {"type": "done", "message": "Fetch complete!"})

    except _CancelledError:
        _cancelled_jobs.discard(job_id)
        _emit(job_id, {"type": "cancelled", "message": "Cancelled by user"})

    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
        try:
            status      = _load_status(kb)
            status[key] = f"❌ {err[:120]}"
            _save_status(kb, status)
        except Exception:
            pass
        _emit(job_id, {"type": "error", "message": err})


def _run_download(job_id: str, slug: str) -> None:
    info = MODELS_INFO[slug]
    try:
        _emit(job_id, {"type": "status", "message": f"Downloading {info['name']}…"})
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=info["id"], local_dir=str(info["local"]))
        _emit(job_id, {"type": "done", "message": "Download complete!"})
    except Exception as exc:
        _emit(job_id, {"type": "error", "message": str(exc)})


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="RAG Document Parser")


@app.on_event("startup")
async def _startup() -> None:
    global _main_loop
    _main_loop = asyncio.get_running_loop()


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# ── Knowledge Bases ───────────────────────────────────────────────────────────

@app.get("/api/knowledge-bases")
async def api_list_kbs():
    return _list_kbs()


@app.post("/api/knowledge-bases")
async def api_create_kb(req: Request):
    body = await req.json()
    name = body.get("name", "").strip()
    if not name or any(c in name for c in r'/\:*?"<>|'):
        raise HTTPException(400, "Invalid KB name")
    p = _safe_kb_path(name)
    if p.exists():
        raise HTTPException(409, "KB already exists")
    for sub in ("files", "output"):
        (p / sub).mkdir(parents=True)
    return {"name": name}


@app.delete("/api/knowledge-bases/{kb}")
async def api_delete_kb(kb: str):
    p = _safe_kb_path(kb)
    if not p.exists():
        raise HTTPException(404, "KB not found")
    shutil.rmtree(p)
    return {"ok": True}


@app.get("/api/knowledge-bases/{kb}/files")
async def api_list_files(kb: str):
    if not _safe_kb_path(kb).exists():
        raise HTTPException(404, "KB not found")
    return _list_files(kb)


@app.post("/api/knowledge-bases/{kb}/files")
async def api_upload_file(kb: str, file: UploadFile):
    if not _safe_kb_path(kb).exists():
        raise HTTPException(404, "KB not found")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in SUPPORTED_EXTS:
        raise HTTPException(400, f"Unsupported type: {suffix}")
    dest = _files_dir(kb) / file.filename
    dest.write_bytes(await file.read())
    return {"key": file.filename, "name": file.filename}


@app.delete("/api/knowledge-bases/{kb}/files")
async def api_delete_file(kb: str, filename: str):
    p = _files_dir(kb) / filename
    if not p.exists():
        raise HTTPException(404, "File not found")
    p.unlink()
    status = _load_status(kb)
    status.pop(filename, None)
    _save_status(kb, status)
    out = _safe_kb_path(kb) / "output" / (Path(filename).stem + ".md")
    if out.exists():
        out.unlink()
    prev = _safe_kb_path(kb) / "preview" / (Path(filename).stem + ".pdf")
    if prev.exists():
        prev.unlink()
    return {"ok": True}


@app.get("/api/knowledge-bases/{kb}/file")
async def api_get_file(kb: str, filename: str):
    p = _files_dir(kb) / filename
    if not p.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(str(p), filename=filename, content_disposition_type="inline")


@app.get("/api/knowledge-bases/{kb}/preview/{filename}")
async def api_preview_file(kb: str, filename: str):
    src = _files_dir(kb) / filename
    if not src.exists():
        raise HTTPException(404, "File not found")
    suffix = src.suffix.lower()
    if suffix == ".pdf":
        return FileResponse(str(src), media_type="application/pdf",
                            headers={"Content-Disposition": "inline"})
    if suffix in (".docx", ".doc"):
        preview_dir = _safe_kb_path(kb) / "preview"
        preview_dir.mkdir(exist_ok=True)
        cached = preview_dir / (src.stem + ".pdf")
        needs_conv = (
            not cached.exists()
            or src.stat().st_mtime > cached.stat().st_mtime
        )
        if needs_conv:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(_executor, _convert_for_preview, src, cached)
        return FileResponse(str(cached), media_type="application/pdf",
                            headers={"Content-Disposition": "inline"})
    raise HTTPException(415, "Preview not available for this file type")


# ── Parse + Output ────────────────────────────────────────────────────────────

@app.post("/api/knowledge-bases/{kb}/parse")
async def api_parse(kb: str, filename: str):
    if not _safe_kb_path(kb).exists():
        raise HTTPException(404, "KB not found")
    job_id = str(uuid.uuid4())
    with _job_lock:
        _job_state[job_id] = {"events": [], "type": "queued", "message": "Queued"}
    _executor.submit(_run_parse, job_id, kb, filename)
    return {"job_id": job_id}


@app.post("/api/knowledge-bases/{kb}/parse-all")
async def api_parse_all(kb: str):
    if not _safe_kb_path(kb).exists():
        raise HTTPException(404, "KB not found")
    files = _list_files(kb)
    jobs = []
    for f in files:
        job_id = str(uuid.uuid4())
        with _job_lock:
            _job_state[job_id] = {"events": [], "type": "queued", "message": "Queued"}
        _executor.submit(_run_parse, job_id, kb, f["name"])
        jobs.append({"job_id": job_id, "filename": f["name"]})
    return {"jobs": jobs}


@app.delete("/api/jobs/{job_id}")
async def api_cancel_job(job_id: str):
    _cancelled_jobs.add(job_id)
    return {"ok": True}


# ── URL Sources ───────────────────────────────────────────────────────────────

@app.get("/api/knowledge-bases/{kb}/urls")
async def api_list_urls(kb: str):
    if not _safe_kb_path(kb).exists():
        raise HTTPException(404, "KB not found")
    status  = _load_status(kb)
    sources = _load_url_sources(kb)
    result  = []
    for src in sources:
        slug     = src["slug"]
        key      = f"url:{slug}"
        st       = status.get(key, "pending")
        out_file = _safe_kb_path(kb) / "output" / f"{slug}.md"
        result.append({
            "slug":       slug,
            "url":        src["url"],
            "title":      src.get("title", slug),
            "added_at":   src.get("added_at", ""),
            "status":     st,
            "has_output": out_file.exists(),
        })
    return result


@app.post("/api/knowledge-bases/{kb}/urls")
async def api_add_urls(kb: str, req: Request):
    if not _safe_kb_path(kb).exists():
        raise HTTPException(404, "KB not found")
    body = await req.json()
    raw_urls = body.get("urls", [])
    if not raw_urls or not isinstance(raw_urls, list):
        raise HTTPException(400, "urls must be a non-empty list")

    sources      = _load_url_sources(kb)
    existing_urls = {s["url"] for s in sources}
    existing_slugs = {s["slug"] for s in sources}

    jobs = []
    for url in raw_urls:
        url = str(url).strip()
        if not url or not url.startswith(("http://", "https://")):
            continue
        if url in existing_urls:
            continue  # skip duplicates

        slug = _url_to_slug(url)
        base = slug
        n = 1
        while slug in existing_slugs:
            slug = f"{base}_{n}"
            n += 1

        sources.append({
            "url":      url,
            "slug":     slug,
            "title":    slug,
            "added_at": datetime.now(timezone.utc).isoformat(),
        })
        existing_urls.add(url)
        existing_slugs.add(slug)

        job_id = str(uuid.uuid4())
        with _job_lock:
            _job_state[job_id] = {"events": [], "type": "queued", "message": "Queued"}
        _executor.submit(_run_url_fetch, job_id, kb, url, slug)
        jobs.append({"job_id": job_id, "slug": slug, "url": url})

    _save_url_sources(kb, sources)
    return {"jobs": jobs}


@app.post("/api/knowledge-bases/{kb}/urls/{slug}/refetch")
async def api_refetch_url(kb: str, slug: str):
    sources = _load_url_sources(kb)
    src = next((s for s in sources if s["slug"] == slug), None)
    if not src:
        raise HTTPException(404, "URL source not found")
    job_id = str(uuid.uuid4())
    with _job_lock:
        _job_state[job_id] = {"events": [], "type": "queued", "message": "Queued"}
    _executor.submit(_run_url_fetch, job_id, kb, src["url"], slug)
    return {"job_id": job_id}


@app.delete("/api/knowledge-bases/{kb}/urls/{slug}")
async def api_delete_url(kb: str, slug: str):
    sources = _load_url_sources(kb)
    sources = [s for s in sources if s.get("slug") != slug]
    _save_url_sources(kb, sources)
    status = _load_status(kb)
    status.pop(f"url:{slug}", None)
    _save_status(kb, status)
    out = _safe_kb_path(kb) / "output" / f"{slug}.md"
    if out.exists():
        out.unlink()
    return {"ok": True}


def _output_stem(filename: str) -> str:
    """Return the output Markdown stem for a given source filename or URL slug.
    Document files (pdf/docx/doc) strip their extension; URL slugs have none."""
    if Path(filename).suffix.lower() in SUPPORTED_EXTS:
        return Path(filename).stem
    return filename


@app.get("/api/knowledge-bases/{kb}/output")
async def api_get_output(kb: str, filename: str):
    out = _safe_kb_path(kb) / "output" / (_output_stem(filename) + ".md")
    if not out.exists():
        raise HTTPException(404, "Output not found")
    return {"markdown": out.read_text(encoding="utf-8")}


@app.put("/api/knowledge-bases/{kb}/output")
async def api_save_output(kb: str, filename: str, req: Request):
    body = await req.json()
    markdown = body.get("markdown", "")
    out_dir  = _safe_kb_path(kb) / "output"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / (_output_stem(filename) + ".md")
    out_path.write_text(markdown, encoding="utf-8")
    return {"ok": True}


# ── SSE event stream ──────────────────────────────────────────────────────────

@app.get("/api/events/{job_id}")
async def api_events(job_id: str):
    q: asyncio.Queue = asyncio.Queue()
    _job_queues.setdefault(job_id, []).append(q)

    with _job_lock:
        past_events: list[dict] = list(
            (_job_state.get(job_id) or {}).get("events", [])
        )

    async def generate() -> AsyncGenerator[str, None]:
        try:
            for event in past_events:
                yield f"data: {json.dumps(event)}\n\n"
                if event.get("type") in ("done", "error"):
                    return
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get("type") in ("done", "error"):
                        return
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            queues = _job_queues.get(job_id, [])
            if q in queues:
                queues.remove(q)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Models ────────────────────────────────────────────────────────────────────

@app.get("/api/models")
async def api_models():
    return [
        {
            "slug":  slug,
            "name":  info["name"],
            "label": info["label"],
            "size":  info["size"],
            "local": (info["local"] / "config.json").exists(),
            "path":  str(info["local"]),
        }
        for slug, info in MODELS_INFO.items()
    ]


@app.post("/api/models/{slug}/download")
async def api_download_model(slug: str):
    if slug not in MODELS_INFO:
        raise HTTPException(404, "Unknown model")
    job_id = str(uuid.uuid4())
    with _job_lock:
        _job_state[job_id] = {"events": [], "type": "queued", "message": "Queued"}
    _executor.submit(_run_download, job_id, slug)
    return {"job_id": job_id}


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=7860, reload=False, log_level="info")
