# 🚔 CodePolice — Project Status

> **Current Version:** v0.1.0 — Phase 1 + 2 Complete  
> **Last Updated:** 2026-02-20  
> **Stack:** TypeScript · VS Code Extension API · Node.js

---

## What CodePolice Can Do Right Now

### ✅ 1. Event-Driven File Watching
- Listens to **four VS Code workspace events** without polling:
  - `onDidSaveTextDocument` — detects every file save
  - `onDidCreateFiles` — detects new files
  - `onDidDeleteFiles` — removes deleted files from buffer
  - `onDidRenameFiles` — updates paths on rename
- **Excluded directories** are respected automatically: `node_modules`, `dist`, `build`, `.git`, `coverage`, `out`
- All filtering happens in `src/eventListener.ts`

---

### ✅ 2. Deduplicated Change Buffer
- All changed file paths are held in a `Set<string>` — rapid saves to the same file **never create duplicates**
- The buffer is **drained atomically** before each processing cycle, preventing race conditions
- Implemented in `src/changeBuffer.ts`

---

### ✅ 3. Debounced Batch Processing
- A **30-second inactivity debounce** (configurable) before processing runs � no unnecessary CPU usage during active typing
- Every time a file is saved, the debounce timer resets
- A **max-wait failsafe** forces a batch run even during continuous saves (prevents starvation)
- Processing only runs when the buffer is non-empty
- Implemented in src/batchProcessor.ts`r
---

### ✅ 4. Hash-Based Change Detection
- Each file is **SHA-256 hashed** on save
- The new hash is compared against the stored hash in the snapshot store
- If the hash **hasn't changed**, the file is silently skipped — no wasted work
- Works correctly even for: touch saves, auto-formatters, minor whitespace changes

---

### ✅ 5. Diff Extraction (Dual Strategy)
- **Strategy 1 (preferred):** Runs `git diff HEAD -- <filePath>` via a child process — accurate, fast, handles renames  
- **Strategy 2 (fallback):** If Git is unavailable or the file isn't tracked, a line-based in-process diff is computed between the previously stored content and the new content
- New files get a `[NEW FILE]` marker with first 2KB of content
- Implemented in `src/diffExtractor.ts`

---

### ✅ 6. Snapshot Store (Persistent State)
- Persists across VS Code restarts using `context.workspaceState`
- Stores **per-file metadata** (never full file content permanently):
  ```json
  {
    "src/auth.ts": {
      "lastHash": "abc123...",
      "lastProcessedAt": "2026-02-20T08:30:00.000Z",
      "changeCount": 7,
      "lastDiff": "--- a/auth.ts\n+++..."
    }
  }
  ```
- Stores **active task** (ID + description)
- Stores **rolling change summaries** (up to 10, most recent first)
- Stores **embedding arrays** (ready for Phase 3 LLM integration)
- Implemented in `src/snapshotStore.ts`

---

### ✅ 7. Seven-State Status Bar
- A persistent item in the VS Code **bottom-left status bar** that reflects the current state at all times:

| State | Icon | Color | Meaning |
|---|---|---|---|
| `idle` | 🛡 | Blue | Watching, waiting for changes |
| `processing` | ⟳ | Amber | Hashing + diffing files now |
| `aligned` | ✅ | Green | Changes match the active task |
| `mild-drift` | ⚠️ | Amber | Some mismatch — worth checking |
| `drift` | ❌ | Red | Significant off-task activity |
| `paused` | ⏸ | Grey | User paused tracking |
| `no-task` | 🚔 | Grey | No task selected yet |

- Clicking the status bar opens the Alignment Report
- Implemented in `src/statusBar.ts`

---

### ✅ 8. GitHub Copilot-Style Sidebar Panel
A fully interactive **WebView panel** registered in the VS Code Activity Bar:

#### Sections:
- **Alignment Status** — live score ring (circular progress), colored state dot, pulsing animation, task card with ID + description
- **Quick Actions** — one-click buttons:
  - Set Active Task
  - Switch Task
  - View Report (markdown)
  - Pause / Resume tracking (toggle)
  - Refresh panel
  - Open Settings
- **Recent Changes** — shows last 8 modified files with:
  - File icon (by extension: `.ts` 🟦, `.py` 🐍, `.md` 📝, etc.)
  - Relative timestamp ("3m ago")
  - Number of change cycles (`×3`)
  - Collapsible **diff preview** with syntax-colored lines (`+` green, `-` red)
- **Change Summaries** — placeholder for Phase 3 LLM output
- **Configuration** — live view of debounce time, alignment thresholds

#### Design:
- Dark theme that adapts to VS Code's active color theme via CSS variables
- Smooth animated score ring with color transitions
- Pulsing state dot
- Sticky header
- Custom scrollbar

- Implemented in `src/sidebarProvider.ts`

---

### ✅ 9. Five Registered Commands (Command Palette)

| Command | Description |
|---|---|
| `CodePolice: Select Active Task` | Opens input box to set task ID + description |
| `CodePolice: Switch Task` | Same picker — replaces active task and resets summaries |
| `CodePolice: View Alignment Report` | Opens a markdown doc with all tracked files + summaries |
| `CodePolice: Pause Tracking` | Stops all processing + updates sidebar + status bar |
| `CodePolice: Resume Tracking` | Restarts tracking from current state |

Plus a **Refresh** button in the sidebar title bar that re-syncs the panel.

---

### ✅ 10. Extension Configuration (settings.json)

| Setting | Default | Description |
|---|---|---|
| codepolice.maxDebounceSeconds | 120 | Max wait before forcing a batch run |
| `codepolice.excludedDirs` | `[node_modules, dist, ...]` | Directories to ignore |
| `codepolice.alignedThreshold` | `0.75` | Cosine similarity → Aligned |
| `codepolice.mildDriftThreshold` | `0.5` | Cosine similarity → Mild Drift |
| `codepolice.ollamaUrl` | `http://localhost:11434` | Ollama base URL (Phase 3) |
| `codepolice.summaryModel` | `codellama` | Model for summarization (Phase 3) |
| `codepolice.embeddingModel` | `nomic-embed-text` | Model for embeddings (Phase 3) |

---

## What CodePolice Cannot Do Yet (Upcoming Phases)

| Phase | Feature | Status |
|---|---|---|
| 3 | **Ollama LLM Summarization** — send diff to local model, get natural language summary + change classification (Feature/Bugfix/Refactor/etc.) | 🔜 Next |
| 3 | **Local Embedding Generation** — embed task description + change summaries via `nomic-embed-text` | 🔜 Next |
| 4 | **Cosine Similarity Engine** — compare task embedding vs rolling change embedding | 🔜 |
| 4 | **Real Alignment Score** — actual 0–1 score shown in the ring, not a stub | 🔜 |
| 4 | **Drift Notifications** — non-blocking VS Code toast when drift crosses a threshold | 🔜 |
| 4 | **Rolling Weighted Aggregation** — recent changes weighted higher than older ones | 🔜 |
| 5 | **Branch Switch Detection** — pause + reset baseline on `git checkout` | 🔜 |
| 5 | **Large Refactor Handling** — batch + downweight mass file changes | 🔜 |
| 5 | **Rich WebView Report** — interactive timeline of changes vs task alignment over time | 🔜 |

---

## File Map

```
CodePolice/
├── src/
│   ├── extension.ts        Wire-up of all modules + activation
│   ├── eventListener.ts    VS Code event subscriptions (save/create/delete/rename)
│   ├── changeBuffer.ts     Deduplicated Set<string> change queue
│   ├── batchProcessor.ts   Debounced orchestrator: hash → diff → store → notify
│   ├── diffExtractor.ts    git diff HEAD + line-diff fallback
│   ├── snapshotStore.ts    workspaceState persistence (hashes, task, summaries)
│   ├── statusBar.ts        7-state status bar item manager
│   ├── sidebarProvider.ts  WebviewViewProvider with full sidebar HTML/CSS/JS
│   └── commands.ts         All 5 command registrations + task picker + report
├── resources/
│   ├── icon.png            Extension marketplace icon
│   └── sidebar-icon.svg    Activity bar shield icon
├── .vscode/
│   ├── launch.json         F5 → Extension Development Host
│   └── tasks.json          Default build: tsc --watch
├── out/                    Compiled JS (auto-generated)
├── package.json            Manifest: commands, views, config, activation
├── tsconfig.json           TypeScript: ES2020, strict mode
├── plan.md                 Original architecture plan
├── project.md              ← This file
└── README.md               Quick-start guide
```

---

## How to Run

```bash
# Terminal: keep this running for auto-recompile
npm run watch

# VS Code: press F5  (or use the already-opened dev window)
# → Opens Extension Development Host with CodePolice loaded
```

**Quick test (reduce wait time):**
```jsonc
// .vscode/settings.json in the dev host window
{
  "codepolice.debounceSeconds": 3
}
```

---

## Architecture Decisions Made

| Decision | Rationale |
|---|---|
| Event-driven, not polling | Zero idle CPU, scales with changes not project size |
| `Set<string>` buffer | O(1) dedup, atomic drain prevents double-processing |
| SHA-256 hash before diff | Skip unchanged files even when save fires |
| `git diff HEAD` preferred | Handles renames, binary detection, is already accurate |
| `workspaceState` for persistence | Survives restarts, scoped to workspace, no filesystem writes |
| WebviewView (not TreeView) | Full HTML/CSS control, live two-way messaging |
| CSS variable theming | Sidebar adapts to any VS Code color theme automatically |
| Retaining webview context | `retainContextWhenHidden: true` keeps sidebar state without re-render |



