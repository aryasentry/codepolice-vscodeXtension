"""
main.py — CodePolice FAISS Service (FastAPI)

Endpoints:
  POST /embed          — embed a chunk summary + store in FAISS immediately
  POST /search         — semantic similarity search
  POST /sync           — manual trigger of Supabase sync
  GET  /health         — liveness probe
"""
import os
import asyncio
from contextlib import asynccontextmanager
from dotenv import load_dotenv

load_dotenv()

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from ollama_client import embed_text, close as close_ollama
from faiss_store import store
from supabase_sync import background_sync_loop, sync_once

# ── Lifespan (startup / shutdown) ─────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: run an initial sync, then start background loop
    print("[main] Running initial Supabase sync...")
    try:
        n = await sync_once()
        print(f"[main] Initial sync complete — {n} chunks embedded. FAISS total: {store.total}")
    except Exception as e:
        print(f"[main] Initial sync failed (continuing): {e}")

    # Background sync task
    sync_task = asyncio.create_task(background_sync_loop())

    yield

    # Shutdown
    sync_task.cancel()
    await close_ollama()
    print("[main] Shutdown complete.")


app = FastAPI(
    title="CodePolice FAISS Service",
    description="Manages vector embeddings for code change summaries.",
    version="1.0.0",
    lifespan=lifespan,
)

# ── Schemas ────────────────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    chunk_id:     str
    workspace_id: str
    task_id:      Optional[str] = None
    summary:      str
    file_paths:   List[str] = []
    start_time:   Optional[str] = None
    end_time:     Optional[str] = None

class SearchRequest(BaseModel):
    query:        str                   # Free-text query — will be embedded
    workspace_id: Optional[str] = None  # Filter by workspace
    task_id:      Optional[str] = None  # Filter by task
    top_k:        int = 10

class SearchResult(BaseModel):
    chunk_id:     str
    workspace_id: Optional[str]
    task_id:      Optional[str]
    summary:      str
    score:        float
    file_paths:   List[str]
    start_time:   Optional[str]
    end_time:     Optional[str]

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":       "ok",
        "service":      "codepolice-faiss",
        "embed_model":  os.getenv("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b"),
        "faiss_total":  store.total,
    }


@app.post("/embed", status_code=201)
async def embed_chunk(req: EmbedRequest):
    """
    Immediately embed a chunk summary and add it to the FAISS index.
    Called by the Node.js describe server when a chunk is sealed.
    """
    if not req.summary.strip():
        raise HTTPException(status_code=400, detail="summary cannot be empty")

    try:
        vector = await embed_text(req.summary)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama embedding failed: {e}")

    faiss_id = store.add(vector, meta={
        "chunk_id":     req.chunk_id,
        "workspace_id": req.workspace_id,
        "task_id":      req.task_id,
        "summary":      req.summary,
        "file_paths":   req.file_paths,
        "start_time":   req.start_time,
        "end_time":     req.end_time,
    })

    return {
        "chunk_id": req.chunk_id,
        "faiss_id": faiss_id,
        "dim":      len(vector),
        "total":    store.total,
    }


@app.post("/search")
async def search(req: SearchRequest):
    """
    Embed the query string and return the top-k most similar chunks.
    """
    if store.total == 0:
        return {"results": [], "total_indexed": 0}

    try:
        query_vector = await embed_text(req.query)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ollama embedding failed: {e}")

    raw = store.search(
        query_vector,
        top_k=req.top_k,
        workspace_id=req.workspace_id,
        task_id=req.task_id,
    )

    results = [
        SearchResult(
            chunk_id=     r.get("chunk_id", ""),
            workspace_id= r.get("workspace_id"),
            task_id=      r.get("task_id"),
            summary=      r.get("summary", ""),
            score=        r["score"],
            file_paths=   r.get("file_paths", []),
            start_time=   r.get("start_time"),
            end_time=     r.get("end_time"),
        )
        for r in raw
    ]

    return {"results": results, "total_indexed": store.total}


@app.post("/sync")
async def manual_sync():
    """Manual trigger of the Supabase → FAISS sync."""
    try:
        n = await sync_once()
        return {"synced": n, "total_indexed": store.total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    port = int(os.getenv("PORT", "3142"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
