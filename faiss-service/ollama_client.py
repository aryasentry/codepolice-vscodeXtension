"""
ollama_client.py — Thin wrapper for Ollama embedding + generation APIs.
"""
import os
import httpx
from typing import List

OLLAMA_BASE  = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
EMBED_MODEL  = os.getenv("OLLAMA_EMBED_MODEL", "qwen3-embedding:0.6b")

# Timeout is generous — embedding can take a few seconds on CPU
_client = httpx.AsyncClient(base_url=OLLAMA_BASE, timeout=120.0)


async def embed_text(text: str) -> List[float]:
    """
    Call Ollama /api/embeddings and return the float vector.
    qwen3-embedding:0.6b produces 1024-dim vectors.
    """
    resp = await _client.post("/api/embeddings", json={
        "model": EMBED_MODEL,
        "prompt": text,
    })
    resp.raise_for_status()
    data = resp.json()
    return data["embedding"]  # list[float]


async def close():
    await _client.aclose()
