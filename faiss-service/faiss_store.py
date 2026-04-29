"""
faiss_store.py — FAISS index management.

Wraps a flat L2 index with a parallel metadata list.
The index is persisted to disk on every write so it survives restarts.

Vector layout
─────────────
FAISS index  : IndexFlatIP (inner product on L2-normalised vectors = cosine similarity)
Metadata list: list[dict] — one entry per vector, same order as FAISS IDs

Thread safety: FastAPI runs in async; CPU-bound FAISS ops are synchronous but fast
enough for this use-case. A lock guards concurrent writes.
"""
import os
import json
import threading
import numpy as np
import faiss
from typing import List, Dict, Any, Optional

FAISS_INDEX_PATH = os.getenv("FAISS_INDEX_PATH", "./faiss_index.bin")
FAISS_META_PATH  = os.getenv("FAISS_META_PATH",  "./faiss_meta.json")

# qwen3-embedding:0.6b produces 1024-dim vectors
VECTOR_DIM = 1024


class FaissStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._index: faiss.IndexFlatIP = None   # type: ignore
        self._meta: List[Dict[str, Any]] = []
        self._load_or_create()

    # ── I/O ───────────────────────────────────────────────────────────────────

    def _load_or_create(self):
        if os.path.exists(FAISS_INDEX_PATH) and os.path.exists(FAISS_META_PATH):
            print(f"[FaissStore] Loading existing index from {FAISS_INDEX_PATH}")
            self._index = faiss.read_index(FAISS_INDEX_PATH)
            with open(FAISS_META_PATH, "r", encoding="utf-8") as f:
                self._meta = json.load(f)
            print(f"[FaissStore] Loaded {self._index.ntotal} vectors.")
        else:
            print("[FaissStore] Creating fresh IndexFlatIP index.")
            self._index = faiss.IndexFlatIP(VECTOR_DIM)
            self._meta = []

    def _persist(self):
        """Write index + metadata to disk. Call while holding self._lock."""
        faiss.write_index(self._index, FAISS_INDEX_PATH)
        with open(FAISS_META_PATH, "w", encoding="utf-8") as f:
            json.dump(self._meta, f, default=str)

    # ── Public API ─────────────────────────────────────────────────────────────

    def add(self, vector: List[float], meta: Dict[str, Any]) -> int:
        """
        L2-normalise the vector, add it to the index.
        Returns the FAISS internal ID (= position in index).
        """
        vec = np.array([vector], dtype=np.float32)
        faiss.normalize_L2(vec)          # cosine similarity via inner product

        with self._lock:
            idx = self._index.ntotal     # new ID = current size
            self._index.add(vec)
            self._meta.append({**meta, "_faiss_id": idx})
            self._persist()

        return idx

    def search(
        self,
        query_vector: List[float],
        top_k: int = 10,
        workspace_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Similarity search. Optionally filter by workspace_id / task_id.
        Returns top_k results with score and metadata.
        """
        if self._index.ntotal == 0:
            return []

        vec = np.array([query_vector], dtype=np.float32)
        faiss.normalize_L2(vec)

        # Over-fetch to allow post-filtering
        fetch_k = min(self._index.ntotal, top_k * 10)

        with self._lock:
            scores, ids = self._index.search(vec, fetch_k)

        results = []
        for score, faiss_id in zip(scores[0], ids[0]):
            if faiss_id < 0:
                continue
            meta = self._meta[faiss_id]

            # Optional filters
            if workspace_id and meta.get("workspace_id") != workspace_id:
                continue
            if task_id and meta.get("task_id") != task_id:
                continue

            results.append({"score": float(score), **meta})
            if len(results) >= top_k:
                break

        return results

    @property
    def total(self) -> int:
        return self._index.ntotal


# Module-level singleton
store = FaissStore()
