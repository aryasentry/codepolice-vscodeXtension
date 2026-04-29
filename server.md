# CodePolice Server Guide

This document explains the CodePolice backend APIs, how data flows from extension → DB → retrieval, and how to connect a live dashboard.

## 1) Architecture Overview

CodePolice currently uses two backend services:

- **Node server** (`server/src`, default `http://localhost:3141`)
  - Accepts code changes from VS Code extension
  - Writes to Supabase tables
  - Queues/updates LLM descriptions
  - Manages chunk flush/seal
  - Exposes retrieval/progress endpoints
- **FAISS service** (`faiss-service`, default `http://localhost:3142`)
  - Embeds chunk summaries
  - Stores vectors in FAISS
  - Runs semantic search
  - Periodically syncs pending chunks from Supabase

### Fast-path processing behavior

`POST /describe` is optimized for low-latency writes:

1. Insert `file_changes`
2. Insert placeholder `change_descriptions` (`[queued] ...`)
3. Return response immediately
4. In background:
   - run Ollama
   - update `change_descriptions` with final summary/classification/score
   - insert `alignment_snapshots`
   - add to chunk manager

So DB rows appear immediately, while expensive LLM/chunk steps complete asynchronously.

---

## 2) Connectivity and Environment

### Node server env (`server/.env`)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_SUMMARY_MODEL`
- `FAISS_SERVICE_URL` (default `http://localhost:3142`)
- `FAISS_PUSH_ENABLED` (`true` recommended)
- `CHUNK_WINDOW_MS` (default 90s)
- `CHUNK_MAX_MS` (default 10m)
- `ALIGNED_THRESHOLD` (default `0.75`)
- `MILD_DRIFT_THRESHOLD` (default `0.5`)
- `DASHBOARD_WEBHOOK_URL` (optional; forwards processed events)
- `PORT` (default `3141`)

### FAISS service env (`faiss-service/.env`)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_EMBED_MODEL`
- `SYNC_INTERVAL_SECONDS` (default 30)
- `PORT` (default `3142`)

### Extension settings (`package.json` contributes)

- `codepolice.serverUrl`
- `codepolice.githubUser`
- `codepolice.debounceSeconds` (default 3)
- `codepolice.maxDebounceSeconds` (default 15)
- `codepolice.alignedThreshold`
- `codepolice.mildDriftThreshold`

---

## 3) Node API Reference (3141)

## `GET /health`
Health/liveness endpoint.

**Response**
```json
{ "status": "ok" }
```

## `POST /describe`
Ingest a code change from the extension.

**Request body**
```json
{
  "workspacePath": "c:/users/me/project",
  "workspaceName": "project",
  "taskKey": "TASK-123",
  "taskDescription": "Implement auth middleware",
  "githubUser": "aryasentry",
  "filePath": "src/auth.ts",
  "fileHash": "sha256...",
  "diff": "...unified diff...",
  "changeCycle": 7,
  "isNewFile": false
}
```

**Fast response (queued)**
```json
{
  "id": "change_description_id",
  "summary": "[queued] Description is being generated…",
  "classification": "unknown",
  "on_task_score": 0.5,
  "model": "qwen...",
  "latency_ms": null,
  "file_change_id": "file_change_id",
  "queued": true
}
```

## `GET /descriptions?workspacePath=...&limit=20&offset=0`
Returns rows from `recent_descriptions` for one workspace.

## `GET /descriptions/alignment?workspacePath=...&limit=50`
Returns recent rows from `alignment_snapshots`.

## `GET /descriptions/retrieval?workspacePath=...&limit=20`
Returns retrieval-ready content:
- recent `change_chunks`
- recent per-file descriptions
- includes workspace/user context

Useful for chat history panels and timeline sidebars.

## `GET /descriptions/progress?workspacePath=...`
Returns dashboard-ready task progress summary:
- `person`
- active task (`key`, `description`, `assigned_to`, `original_assigned_at`)
- totals + latest/average alignment scores

## `POST /search`
Proxy to FAISS `/search`.

**Body**
```json
{ "query": "where did we add auth", "topK": 10 }
```

## `POST /flush`
Force-seals all open chunks immediately (for instant sync behavior).

---

## 4) FAISS API Reference (3142)

## `GET /health`
Returns service health + `faiss_total`.

## `POST /embed`
Embeds a single chunk summary and inserts it into FAISS.

## `POST /search`
Semantic search over embedded chunks.

**Body**
```json
{ "query": "jwt middleware", "workspace_id": "...", "task_id": null, "top_k": 10 }
```

## `POST /sync`
Manual sync of pending chunks from Supabase view `chunks_pending_embedding`.

---

## 5) Retrieval and Chat History Strategy

For best UX in your dashboard chat:

1. Use `GET /descriptions/retrieval` for near-real-time recent context
2. Use `POST /search` for semantic retrieval across chunked history
3. Merge both in UI:
   - newest timeline items (retrieval)
   - relevance-ranked results (search)

Recommended fallback behavior:
- If FAISS unavailable, still show `retrieval` data from Supabase
- If `queued` summaries exist, render “processing…” state and refresh

---

## 6) Alignment Accuracy

Current alignment score source:
- `on_task_score` returned by Ollama in `/describe`
- persisted in `change_descriptions`
- mapped to state using thresholds:
  - `score >= ALIGNED_THRESHOLD` → `aligned`
  - `score >= MILD_DRIFT_THRESHOLD` → `mild-drift`
  - otherwise → `drift`

`alignment_snapshots` are inserted after final description generation.

### Notes
- This is no longer a fixed fake score path.
- Accuracy now depends on prompt quality + model behavior.
- Tune thresholds in env/settings for your team’s tolerance.

---

## 7) Live Dashboard Connectivity

Two integration modes are supported:

### A) Pull mode (dashboard polls APIs)
- Poll `GET /descriptions/progress` every 2–5s
- Poll `GET /descriptions/retrieval` every 2–5s
- Use `POST /search` for user queries

### B) Push mode (webhook events)
Set `DASHBOARD_WEBHOOK_URL` and receive server-sent events per processed change.

Example payload shape:
```json
{
  "event": "code_change_processed",
  "github_user": "aryasentry",
  "workspace_id": "...",
  "workspace_path": "c:/users/.../codepolice",
  "task": {
    "id": "...",
    "key": "TASK-123",
    "description": "Implement auth middleware"
  },
  "file_change": {
    "id": "...",
    "file_path": "src/auth.ts",
    "change_cycle": 7,
    "is_new_file": false
  },
  "description": {
    "id": "...",
    "summary": "Added JWT validation middleware...",
    "classification": "feature",
    "on_task_score": 0.88
  },
  "alignment": {
    "state": "aligned",
    "score": 0.88
  },
  "ts": "2026-02-21T12:34:56.000Z"
}
```

---

## 8) Person + Original Task Attribution

For dashboard cards showing “who did what on which task”:

- `github_user` (person):
  - stored in `workspaces`, `tasks`, `file_changes`, `change_descriptions`, `alignment_snapshots`, `change_chunks`
- original assigned task:
  - `tasks.task_key`
  - `tasks.description`
  - `tasks.created_at` (as original assigned time)

Use `GET /descriptions/progress` as canonical source for this summary.

---

## 9) Example Flow (End-to-End)

1. Dev saves file in VS Code
2. Extension sends `/describe`
3. Server immediately writes queued records and returns
4. Background LLM finalizes summary + score
5. Server writes alignment snapshot
6. Server pushes webhook (optional)
7. Chunk seals later (or `/flush`), then embedded in FAISS
8. Dashboard reads:
   - `/descriptions/progress` (live task/alignment)
   - `/descriptions/retrieval` (history list)
   - `/search` (semantic retrieval)

---

## 10) Operational Tips

- For instant visibility during demos:
  - call `/flush`
  - then call FAISS `/sync`
- Keep `debounceSeconds` low (`3`) for responsiveness
- If DB rows appear but search is empty, embedding likely pending
- If webhook delivery fails, polling endpoints still work

---

## 11) Quick Test Commands

### Health
```bash
curl http://localhost:3141/health
curl http://localhost:3142/health
```

### Progress
```bash
curl "http://localhost:3141/descriptions/progress?workspacePath=c:/users/kalid/onedrive/documents/codepolice"
```

### Retrieval
```bash
curl "http://localhost:3141/descriptions/retrieval?workspacePath=c:/users/kalid/onedrive/documents/codepolice&limit=20"
```

### Flush + Sync
```bash
curl -X POST http://localhost:3141/flush
curl -X POST http://localhost:3142/sync
```

---

If you want, next step is adding OpenAPI (`/openapi.json`) generation so your dashboard frontend can autogenerate typed API clients.