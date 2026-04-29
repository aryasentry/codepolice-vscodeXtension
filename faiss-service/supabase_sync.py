"""
supabase_sync.py — Background task that periodically pulls unindexed chunks
from Supabase and feeds them into the FAISS store.

Runs every SYNC_INTERVAL_SECONDS (default: 5 min).
"""
import os
import asyncio
from supabase import create_client, Client
from ollama_client import embed_text
from faiss_store import store

SYNC_INTERVAL = int(os.getenv("SYNC_INTERVAL_SECONDS", "30"))

_sb: Client = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_KEY"],
)


async def sync_once() -> int:
    """
    Pull all chunks where is_embedded=false, embed them, add to FAISS,
    then mark them as embedded in Supabase.
    Returns the number of chunks processed.
    """
    resp = (
        _sb.table("chunks_pending_embedding")
        .select("*")
        .execute()
    )
    chunks = resp.data or []
    if not chunks:
        return 0

    count = 0
    for chunk in chunks:
        chunk_id     = chunk["chunk_id"]
        summary      = chunk.get("summary", "")
        workspace_id = chunk.get("workspace_id")
        task_id      = chunk.get("task_id")
        file_paths   = chunk.get("file_paths", [])
        start_time   = chunk.get("start_time")
        end_time     = chunk.get("end_time")

        # Embed the chunk summary
        try:
            vector = await embed_text(summary)
        except Exception as e:
            print(f"[sync] Embedding failed for chunk {chunk_id}: {e}")
            continue

        # Add to FAISS
        store.add(vector, meta={
            "chunk_id":    chunk_id,
            "workspace_id": workspace_id,
            "task_id":     task_id,
            "summary":     summary,
            "file_paths":  file_paths,
            "start_time":  start_time,
            "end_time":    end_time,
        })

        # Mark as embedded in Supabase
        _sb.table("change_chunks") \
            .update({"is_embedded": True}) \
            .eq("id", chunk_id) \
            .execute()

        count += 1
        print(f"[sync] Embedded chunk {chunk_id[:8]}... ({len(file_paths)} files)")

    return count


async def background_sync_loop():
    """Infinite loop — runs sync_once every SYNC_INTERVAL seconds."""
    print(f"[sync] Background sync starting — interval: {SYNC_INTERVAL}s")
    while True:
        try:
            n = await sync_once()
            if n:
                print(f"[sync] Synced {n} chunks. FAISS total: {store.total}")
        except Exception as e:
            print(f"[sync] Error during sync: {e}")
        await asyncio.sleep(SYNC_INTERVAL)
