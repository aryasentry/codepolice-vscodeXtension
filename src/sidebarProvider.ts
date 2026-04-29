import * as vscode from 'vscode';
import { SnapshotStore } from './snapshotStore';
import { StatusBarManager, AlignmentState } from './statusBar';
import { DebouncedBatchProcessor } from './batchProcessor';

// ─── Message types (Extension ↔ Webview) ─────────────────────────────────────

interface WebviewMessage {
  command: string;
  payload?: unknown;
}

export interface SidebarState {
    task: { id: string; description: string } | null;
    alignmentState: AlignmentState;
    alignmentScore: number | null;
    recentChanges: Array<{ file: string; changeCount: number; lastAt: string; lastDiff?: string }>;
    recentSummaries: string[];
    isPaused: boolean;
    debounceSeconds: number;
    serverUrl: string;
}

/**
 * WebviewViewProvider — renders the CodePolice sidebar panel.
 * Receives messages from the HTML UI and forwards them to extension commands.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly snapshotStore: SnapshotStore,
    private readonly statusBar: StatusBarManager,
    private readonly batchProcessor: DebouncedBatchProcessor,
    private readonly context: vscode.ExtensionContext
  ) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handleMessage(msg);
    });

    // Push initial state once panel is ready
    setTimeout(() => this.pushState(), 300);
  }

  /** Called externally to refresh the sidebar with latest state */
  refresh(alignmentState?: AlignmentState, score?: number): void {
    this.pushState(alignmentState, score);
  }

  private pushState(alignmentState?: AlignmentState, score?: number): void {
    if (!this._view) return;

    const task = this.snapshotStore.getActiveTask();
    const storeState = this.snapshotStore.getFullState();
    const cfg = vscode.workspace.getConfiguration('codepolice');

    const recentChanges = Object.entries(storeState.files)
      .map(([file, snap]) => ({
        file: file.split(/[\/\\]/).slice(-2).join('/'),
        changeCount: snap.changeCount,
        lastAt: snap.lastProcessedAt,
        lastDiff: snap.lastDiff,
      }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .slice(0, 8);

        const state: SidebarState = {
            task,
            alignmentState: alignmentState ?? (task ? 'idle' : 'no-task'),
            alignmentScore: score ?? null,
            recentChanges,
            recentSummaries: storeState.recentChangeSummaries,
            isPaused: this.batchProcessor.paused,
            debounceSeconds: cfg.get('debounceSeconds') ?? 30,
            serverUrl: cfg.get('serverUrl') ?? 'http://localhost:3141',
        };

    this._view.webview.postMessage({ command: 'setState', payload: state });
  }

  private handleMessage(msg: WebviewMessage): void {
    switch (msg.command) {
      case 'ready':
        this.pushState();
        break;
      case 'selectTask':
        vscode.commands.executeCommand('codepolice.selectTask');
        break;
      case 'switchTask':
        vscode.commands.executeCommand('codepolice.switchTask');
        break;
      case 'viewReport':
        vscode.commands.executeCommand('codepolice.viewReport');
        break;
      case 'pause':
        this.batchProcessor.pause();
        this.pushState('paused');
        break;
      case 'resume':
        this.batchProcessor.resume();
        this.pushState(this.snapshotStore.getActiveTask() ? 'idle' : 'no-task');
        break;
      case 'refresh':
        this.pushState();
        break;
      case 'syncNow':
        this.handleSyncNow();
        break;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'codepolice');
        break;
    }
  }

  private async handleSyncNow(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('codepolice');
    const serverUrl: string = cfg.get('serverUrl') ?? 'http://localhost:3141';
    const faissUrl = serverUrl.replace('3141', '3142');

    this._view?.webview.postMessage({ command: 'syncStatus', payload: 'flushing' });
    try {
      // 1. Flush open chunks on the Node server
      const flushResp = await fetch(`${serverUrl}/flush`, { method: 'POST' });
      if (!flushResp.ok) {
        throw new Error(`Flush failed: ${flushResp.status}`);
      }
      // 2. Trigger FAISS sync
      const syncResp = await fetch(`${faissUrl}/sync`, { method: 'POST' });
      const syncData = (syncResp.ok ? await syncResp.json() : {}) as { synced?: number };
      const synced = syncData.synced ?? 0;
      this._view?.webview.postMessage({ command: 'syncStatus', payload: `done:${synced}` });
      vscode.window.showInformationMessage(
        `🚔 CodePolice: Sync complete — ${synced} chunk(s) embedded.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ command: 'syncStatus', payload: 'error' });
      vscode.window.showWarningMessage(`CodePolice sync failed: ${msg}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://localhost:3141 https://* http://* vscode-webview:;">
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CodePolice</title>
<style>
  /* ── Reset & base ────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:           var(--vscode-sideBar-background, #0d1117);
    --bg2:          var(--vscode-editor-background, #161b22);
    --bg3:          var(--vscode-input-background, #1c2128);
    --bg-hover:     rgba(255,255,255,0.06);
    --bg-alt:       rgba(255,255,255,0.04);
    --bg-input:     var(--vscode-input-background, #1c2128);
    --border:       var(--vscode-panel-border, #30363d);
    --fg:           var(--vscode-foreground, #e6edf3);
    --fg2:          var(--vscode-descriptionForeground, #8b949e);
    --accent:       #58a6ff;
    --accent-hover: #79b8ff;
    --green:        #3fb950;
    --amber:        #d29922;
    --red:          #f85149;
    --purple:       #bc8cff;
    --btn-bg:       var(--vscode-button-background, #238636);
    --btn-fg:       var(--vscode-button-foreground, #fff);
    --btn-hover:    var(--vscode-button-hoverBackground, #2ea043);
    --radius:       8px;
    --radius-sm:    5px;
    --font:         var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    --font-mono:    var(--vscode-editor-font-family, 'Cascadia Code', monospace);
    --transition:   0.18s ease;
  }

  body {
    font-family: var(--font);
    font-size: 12px;
    color: var(--fg);
    background: var(--bg);
    overflow-x: hidden;
    padding-bottom: 16px;
  }

  /* ── Header ──────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }
  .header-icon { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; }
  .header-icon svg { width: 22px; height: 22px; }
  .header-title { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; flex: 1; color: var(--fg); }
  .header-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 10px;
    background: var(--bg3); color: var(--fg2); border: 1px solid var(--border); letter-spacing: 0.04em; }

  /* ── Section ─────────────────────────────── */
  .section { padding: 10px 12px 6px; border-bottom: 1px solid var(--border); }
  .section:last-child { border-bottom: none; }
  .section-label {
    font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--fg2); margin-bottom: 8px; display: flex; align-items: center; gap: 5px;
  }
  .section-label .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }

  /* ── Alignment card ──────────────────────── */
  .align-card {
    background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 12px; display: flex; flex-direction: column; gap: 10px; position: relative; overflow: hidden;
  }
  .align-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    background: var(--state-color, var(--accent)); transition: background var(--transition);
  }
  .align-row { display: flex; align-items: center; justify-content: space-between; }
  .align-status { display: flex; align-items: center; gap: 6px; }
  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--state-color, var(--accent));
    flex-shrink: 0; box-shadow: 0 0 6px var(--state-color, var(--accent)); animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%, 100% { opacity:1; } 50% { opacity:0.5; } }
  .status-dot.static { animation: none; }
  .status-text { font-size: 12px; font-weight: 600; color: var(--fg); }
  .score-ring { position: relative; width: 48px; height: 48px; flex-shrink: 0; }
  .ring-bg { fill: none; stroke: var(--bg3); stroke-width: 3; }
  .ring-fill {
    fill: none; stroke: var(--accent); stroke-width: 3; stroke-dasharray: 100.53;
    stroke-dashoffset: 100.53; stroke-linecap: round;
    transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset 0.6s ease;
  }
  .ring-text {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; color: var(--fg);
  }

  /* ── Task card ───────────────────────────── */
  .task-card {
    background: var(--bg3); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 8px 10px; display: flex; flex-direction: column; gap: 3px;
  }
  .task-card-id { font-size: 10px; font-weight: 700; color: var(--accent); font-family: var(--font-mono); }
  .task-card-desc { font-size: 11px; color: var(--fg); }
  .task-card-meta { font-size: 10px; color: var(--fg2); }
  .no-task { text-align: center; padding: 10px 0; color: var(--fg2); font-size: 11px; }
  .no-task-icon { display: block; font-size: 24px; margin-bottom: 6px; }

  /* ── Buttons ─────────────────────────────── */
  .btn-group { display: flex; flex-direction: column; gap: 5px; }
  .btn-row { display: flex; gap: 5px; }
  .btn-half { flex: 1; }
  .btn-primary, .btn-secondary, .btn-warn, .btn-success, .btn-chat {
    display: flex; align-items: center; justify-content: center; gap: 5px;
    border: none; border-radius: var(--radius-sm); padding: 7px 10px;
    font-size: 11px; font-weight: 600; cursor: pointer; transition: all var(--transition);
    font-family: var(--font); width: 100%;
  }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-primary:hover { background: var(--btn-hover); }
  .btn-secondary { background: var(--bg3); color: var(--fg); border: 1px solid var(--border); }
  .btn-secondary:hover { background: var(--bg-hover); border-color: var(--fg2); }
  .btn-warn { background: rgba(248,81,73,0.15); color: var(--red); border: 1px solid rgba(248,81,73,0.3); }
  .btn-warn:hover { background: rgba(248,81,73,0.25); }
  .btn-success { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid rgba(63,185,80,0.3); }
  .btn-success:hover { background: rgba(63,185,80,0.25); }
  .btn-chat { background: rgba(88,166,255,0.12); color: var(--accent); border: 1px solid rgba(88,166,255,0.3); }
  .btn-chat:hover { background: rgba(88,166,255,0.22); }
  .btn-icon { font-size: 13px; }

  /* ── Change list ─────────────────────────── */
  .change-list { display: flex; flex-direction: column; gap: 4px; }
  .change-item { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px;
    background: var(--bg2); border-radius: var(--radius-sm); border: 1px solid var(--border); }
  .change-file-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
  .change-file-info { flex: 1; min-width: 0; }
  .change-file-name { font-size: 11px; font-weight: 600; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .change-file-meta { font-size: 10px; color: var(--fg2); }
  .change-count { font-size: 10px; font-weight: 700; color: var(--purple); flex-shrink: 0; margin-top: 2px; }

  /* ── Summary list ────────────────────────── */
  .summary-list { display: flex; flex-direction: column; gap: 4px; }
  .summary-item { display: flex; align-items: flex-start; gap: 6px; font-size: 11px; padding: 4px 0; }
  .summary-bullet { color: var(--purple); font-size: 8px; margin-top: 3px; flex-shrink: 0; }

  /* ── Settings rows ───────────────────────── */
  .settings-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; }
  .settings-key { font-size: 11px; color: var(--fg2); }
  .settings-val { font-size: 11px; font-weight: 600; color: var(--fg); font-family: var(--font-mono); }

  /* ── Empty state ─────────────────────────── */
  .empty { text-align: center; color: var(--fg2); font-size: 11px; padding: 10px 0; }

  /* ── Paused strip ────────────────────────── */
  .paused-strip { background: rgba(210,153,34,0.08); border: 1px solid rgba(210,153,34,0.25);
    border-radius: var(--radius-sm); padding: 6px 10px; font-size: 11px; color: var(--amber);
    display: flex; align-items: center; gap: 6px; }

  /* ── Diff preview ────────────────────────── */
  details { margin-top: 2px; }
  summary { cursor: pointer; font-size: 10px; color: var(--fg2); list-style: none;
    display: flex; align-items: center; gap: 4px; padding: 3px 0; user-select: none; }
  summary:hover { color: var(--fg); }
  summary::marker { display: none; }
  .chevron { font-size: 9px; transition: transform var(--transition); display: inline-block; }
  details[open] .chevron { transform: rotate(90deg); }
  .diff-preview { font-family: var(--font-mono); font-size: 10px; background: var(--bg);
    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px;
    margin-top: 4px; overflow-x: auto; white-space: pre; max-height: 120px; overflow-y: auto; line-height: 1.5; }
  .diff-add { color: var(--green); }
  .diff-remove { color: var(--red); }
  .diff-meta { color: var(--fg2); }

  /* ─────────────────────────────────────────────────────────────
     ── CHAT PAGE ─────────────────────────────────────────────── */
  #chat-page {
    display: none;
    flex-direction: column;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--bg);
    z-index: 100;
  }

  .chat-header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-bottom: 1px solid var(--border);
    background: var(--bg); flex-shrink: 0;
  }
  .back-btn {
    background: none; border: 1px solid var(--border); color: var(--fg2);
    cursor: pointer; font-size: 11px; padding: 4px 8px;
    border-radius: var(--radius-sm); display: flex; align-items: center; gap: 4px;
    transition: all var(--transition); font-family: var(--font);
  }
  .back-btn:hover { background: var(--bg-hover); color: var(--fg); border-color: var(--fg2); }
  .chat-title { font-weight: 700; font-size: 13px; color: var(--fg); flex: 1; }
  .chat-indexed { font-size: 10px; color: var(--fg2); white-space: nowrap; }

  .chat-messages {
    flex: 1; overflow-y: auto; padding: 10px 10px 4px;
    display: flex; flex-direction: column; gap: 8px;
  }

  .chat-welcome {
    margin: auto; text-align: center; padding: 20px 12px; color: var(--fg2); font-size: 12px;
  }
  .chat-welcome-icon { font-size: 36px; margin-bottom: 10px; }
  .chat-welcome-title { font-size: 15px; font-weight: 700; color: var(--fg); margin-bottom: 6px; }
  .chat-welcome-sub { line-height: 1.7; color: var(--fg2); }
  .chat-welcome-sub em { color: var(--accent); font-style: normal; }

  .chat-input-area {
    flex-shrink: 0; padding: 8px 10px; border-top: 1px solid var(--border); background: var(--bg);
  }
  .chat-input-row { display: flex; gap: 6px; }
  .chat-input {
    flex: 1; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--bg-input); color: var(--fg); font-size: 12px; outline: none;
    font-family: var(--font); transition: border-color var(--transition);
  }
  .chat-input:focus { border-color: var(--accent); }
  .chat-input::placeholder { color: var(--fg2); }
  .chat-send {
    background: var(--accent); color: #0d1117; border: none; border-radius: var(--radius-sm);
    padding: 8px 14px; font-size: 15px; font-weight: 700; cursor: pointer; transition: all var(--transition);
  }
  .chat-send:hover:not(:disabled) { background: var(--accent-hover); transform: scale(1.05); }
  .chat-send:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

  .chat-bubble {
    max-width: 82%; padding: 8px 11px; border-radius: var(--radius-sm);
    font-size: 12px; line-height: 1.45; word-break: break-word;
  }
  .chat-bubble-user {
    background: rgba(88,166,255,0.12); border: 1px solid rgba(88,166,255,0.25);
    align-self: flex-end; color: var(--fg); border-radius: var(--radius-sm) var(--radius-sm) 2px var(--radius-sm);
  }
  .chat-bubble-bot {
    background: var(--bg2); border: 1px solid var(--border);
    align-self: flex-start; color: var(--fg); border-radius: 2px var(--radius-sm) var(--radius-sm) var(--radius-sm);
  }
  .chat-typing { color: var(--fg2); font-style: italic; }

  .chat-result {
    background: var(--bg2); border-radius: var(--radius-sm); padding: 10px 11px;
    border: 1px solid var(--border); transition: border-color var(--transition);
  }
  .chat-result:first-child { border-color: var(--accent); }
  .chat-result-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  .chat-score { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; }
  .chat-time { font-size: 10px; color: var(--fg2); }
  .chat-result-summary { font-size: 11px; color: var(--fg); margin-bottom: 7px; line-height: 1.5; }
  .chat-files { display: flex; flex-wrap: wrap; gap: 4px; }
  .chat-file-chip {
    background: var(--bg3); color: var(--fg2); font-size: 9px;
    padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono);
    border: 1px solid var(--border);
  }

  /* ── Scrollbars ──────────────────────────── */
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--fg2); }
</style>
</head>
<body>

<!-- ── HEADER ──────────────────────────────────────────────────────── -->
<div class="header">
  <div class="header-icon">
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L4 6v6c0 5.25 3.5 10.15 8 11.35C16.5 22.15 20 17.25 20 12V6L12 2z"
        fill="#58a6ff" opacity="0.2"/>
      <path d="M12 2L4 6v6c0 5.25 3.5 10.15 8 11.35C16.5 22.15 20 17.25 20 12V6L12 2z"
        stroke="#58a6ff" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M9 12l2 2 4-4" stroke="#58a6ff" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <span class="header-title">CodePolice</span>
  <span class="header-badge" id="version-badge">v0.1</span>
</div>

<!-- ── ALIGNMENT STATUS ─────────────────────────────────────────────── -->
<div class="section" id="section-alignment">
  <div class="section-label">
    <span class="dot" id="status-dot-label"></span>
    Alignment Status
  </div>
  <div class="align-card" id="align-card">
    <div class="align-row">
      <div class="align-status">
        <div class="status-dot" id="status-dot"></div>
        <span class="status-text" id="status-text">Loading…</span>
      </div>
      <div class="score-ring">
        <svg width="48" height="48" viewBox="0 0 36 36">
          <circle class="ring-bg" cx="18" cy="18" r="16"/>
          <circle class="ring-fill" id="ring-fill" cx="18" cy="18" r="16"/>
        </svg>
        <div class="ring-text" id="ring-text">—</div>
      </div>
    </div>

    <!-- Paused banner -->
    <div class="paused-strip" id="paused-strip" style="display:none">
      ⏸ Tracking is paused
    </div>

    <!-- Active task card / No-task placeholder -->
    <div id="task-area"></div>
  </div>
</div>

<!-- ── QUICK ACTIONS ────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">
    <span class="dot" style="background:var(--purple)"></span>
    Quick Actions
  </div>
  <div class="btn-group">
    <button class="btn-primary" id="btn-select-task">
      <span class="btn-icon">＋</span> Set Active Task
    </button>
    <div class="btn-row">
      <button class="btn-secondary btn-half" id="btn-switch-task">
        <span class="btn-icon">⇄</span> Switch Task
      </button>
      <button class="btn-secondary btn-half" id="btn-view-report">
        <span class="btn-icon">📊</span> Report
      </button>
    </div>
    <div class="btn-row" id="pause-resume-row">
      <button class="btn-warn btn-half" id="btn-pause" style="display:none">
        <span class="btn-icon">⏸</span> Pause
      </button>
      <button class="btn-success btn-half" id="btn-resume" style="display:none">
        <span class="btn-icon">▶</span> Resume
      </button>
    </div>
    <div class="btn-row">
      <button class="btn-secondary btn-half" id="btn-refresh">
        <span class="btn-icon">↻</span> Refresh
      </button>
      <button class="btn-secondary btn-half" id="btn-open-settings">
        <span class="btn-icon">⚙</span> Settings
      </button>
    </div>
    <!-- Sync: force-seal chunks and embed immediately -->
    <button class="btn-success" id="btn-sync-now">
      <span class="btn-icon">⚡</span> Sync Now
    </button>
    <!-- Chat with history button -->
    <button class="btn-chat" id="btn-chat">
      <span class="btn-icon">💬</span> Chat with History
    </button>
  </div>
</div>

<!-- ── RECENT CHANGES ───────────────────────────────────────────────── -->
<div class="section" id="section-changes">
  <div class="section-label">
    <span class="dot" style="background:var(--green)"></span>
    Recent Changes
    <span id="changes-count" style="color:var(--accent);font-size:10px;margin-left:auto"></span>
  </div>
  <div class="change-list" id="change-list">
    <div class="empty">No changes tracked yet.</div>
  </div>
</div>

<!-- ── CHANGE SUMMARIES ─────────────────────────────────────────────── -->
<div class="section" id="section-summaries">
  <div class="section-label">
    <span class="dot" style="background:var(--purple)"></span>
    Change Summaries
    <span style="color:var(--fg2);font-size:9px;margin-left:auto;font-weight:400">(LLM)</span>
  </div>
  <div class="summary-list" id="summary-list">
    <div class="empty">Summaries appear after first batch run.</div>
  </div>
</div>

<!-- ── CONFIG ───────────────────────────────────────────────────────── -->
<div class="section">
  <div class="section-label">
    <span class="dot" style="background:var(--amber)"></span>
    Configuration
  </div>
  <div id="config-rows"></div>
  <button class="btn-secondary" id="btn-open-settings-2" style="margin-top:8px;width:100%">
    <span class="btn-icon">⚙</span> Open Settings
  </button>
</div>

<!-- ════════════════════════════════════════════════════════════════════
     CHAT PAGE — slides over the main view (fixed overlay)
     ════════════════════════════════════════════════════════════════════ -->
<div id="chat-page">
  <!-- Chat header with back arrow -->
  <div class="chat-header">
    <button class="back-btn" id="btn-chat-back" title="Back to main view">
      ← Back
    </button>
    <span class="chat-title">💬 History Search</span>
    <span class="chat-indexed" id="chat-indexed">— indexed</span>
  </div>

  <!-- Messages area -->
  <div class="chat-messages" id="chat-messages">
    <div class="chat-welcome">
      <div class="chat-welcome-icon">🔍</div>
      <div class="chat-welcome-title">Search your coding history</div>
      <div class="chat-welcome-sub">
        Ask anything about recent changes, e.g.<br>
        <em>"added authentication middleware"</em><br>
        <em>"fixed the batch processor bug"</em><br>
        <em>"refactored the chunking logic"</em>
      </div>
    </div>
  </div>

  <!-- Input area -->
  <div class="chat-input-area">
    <div class="chat-input-row">
      <input id="chat-input" class="chat-input" type="text"
        placeholder="Search coding history…" />
      <button class="chat-send" id="chat-send-btn">↑</button>
    </div>
  </div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let SERVER = 'http://localhost:3141';

  function send(command, payload) {
    vscode.postMessage({ command, payload });
  }

  // ── State renderer ────────────────────────────────────────────────
  const STATE_META = {
    'idle':       { color: '#58a6ff', label: 'Watching' },
    'processing': { color: '#d29922', label: 'Processing…' },
    'aligned':    { color: '#3fb950', label: 'Aligned' },
    'mild-drift': { color: '#d29922', label: 'Mild Drift' },
    'drift':      { color: '#f85149', label: 'Off-Task!' },
    'paused':     { color: '#8b949e', label: 'Paused' },
    'no-task':    { color: '#8b949e', label: 'No Task Set' },
  };

  function renderState(state) {
    SERVER = state.serverUrl || SERVER;
    const meta = STATE_META[state.alignmentState] || STATE_META['idle'];

    document.documentElement.style.setProperty('--state-color', meta.color);
    document.getElementById('status-text').textContent = meta.label;
    document.getElementById('status-dot').classList.toggle(
      'static',
      state.alignmentState === 'paused' || state.alignmentState === 'no-task'
    );

    const score = state.alignmentScore;
    const scoreEl = document.getElementById('ring-fill');
    const textEl  = document.getElementById('ring-text');
    const circumference = 100.53;
    if (score !== null) {
      scoreEl.style.strokeDashoffset = (circumference * (1 - score)).toFixed(2);
      textEl.textContent = Math.round(score * 100) + '%';
    } else {
      scoreEl.style.strokeDashoffset = circumference;
      textEl.textContent = '—';
    }
    scoreEl.style.stroke = meta.color;

    document.getElementById('paused-strip').style.display = state.isPaused ? 'flex' : 'none';

    const pauseBtn  = document.getElementById('btn-pause');
    const resumeBtn = document.getElementById('btn-resume');
    if (state.isPaused) {
      pauseBtn.style.display  = 'none';
      resumeBtn.style.display = 'flex';
    } else {
      pauseBtn.style.display  = state.task ? 'flex' : 'none';
      resumeBtn.style.display = 'none';
    }

    const taskArea = document.getElementById('task-area');
    if (state.task) {
      const lastChange = state.recentChanges[0];
      const metaText = lastChange ? 'Last change ' + formatRelative(lastChange.lastAt) : 'No changes yet';
      taskArea.innerHTML = \`
        <div class="task-card">
          <div class="task-card-id">\${esc(state.task.id)}</div>
          <div class="task-card-desc">\${esc(state.task.description)}</div>
          <div class="task-card-meta">\${esc(metaText)}</div>
        </div>\`;
    } else {
      taskArea.innerHTML = \`
        <div class="no-task">
          <span class="no-task-icon">🚔</span>
          No active task set.<br>Click <b>Set Active Task</b> to begin.
        </div>\`;
    }

    const changeList  = document.getElementById('change-list');
    const countBadge  = document.getElementById('changes-count');
    if (state.recentChanges.length > 0) {
      countBadge.textContent = state.recentChanges.length + ' files';
      changeList.innerHTML = state.recentChanges.map(c => {
        const ext = c.file.split('.').pop() || '';
        const icon = fileIcon(ext);
        const hasDiff = c.lastDiff && c.lastDiff.trim().length > 0;
        const diffHtml = hasDiff ? \`<details>
          <summary><span class="chevron">▶</span> View diff</summary>
          <div class="diff-preview">\${formatDiff(c.lastDiff)}</div>
        </details>\` : '';
        return \`<div class="change-item">
          <span class="change-file-icon">\${icon}</span>
          <div class="change-file-info">
            <div class="change-file-name">\${esc(c.file)}</div>
            <div class="change-file-meta">\${formatRelative(c.lastAt)}</div>
            \${diffHtml}
          </div>
          <span class="change-count">\${c.changeCount}×</span>
        </div>\`;
      }).join('');
    } else {
      countBadge.textContent = '';
      changeList.innerHTML = '<div class="empty">No changes tracked yet.</div>';
    }

    const summaryList = document.getElementById('summary-list');
    if (state.recentSummaries.length > 0) {
      summaryList.innerHTML = state.recentSummaries.map(s =>
        \`<div class="summary-item"><span class="summary-bullet">◆</span><span>\${esc(s)}</span></div>\`
      ).join('');
    } else {
      summaryList.innerHTML = '<div class="empty">Summaries appear after first batch run.</div>';
    }

    const configRows = document.getElementById('config-rows');
    configRows.innerHTML = [
      { k: 'Debounce', v: state.debounceSeconds + 's' },
      { k: 'Server',   v: 'checking…', id: 'server-status' },
    ].map(r => \`<div class="settings-row">
      <span class="settings-key">\${esc(r.k)}</span>
      <span class="settings-val" \${r.id ? \`id="\${r.id}"\` : ''}>\${esc(r.v)}</span>
    </div>\`).join('');

    updateServerStatus();
  }

  // ── Chat page logic ────────────────────────────────────────────────
  function showChat() {
    const page = document.getElementById('chat-page');
    page.style.display = 'flex';
    document.getElementById('chat-input').focus();
    updateIndexedCount();
  }

  function hideChat() {
    document.getElementById('chat-page').style.display = 'none';
  }

  async function updateIndexedCount() {
    try {
      const r = await fetch(SERVER + '/health', { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const d = await r.json();
        document.getElementById('chat-indexed').textContent =
          d.faiss_total !== undefined ? d.faiss_total + ' chunks indexed' : 'connected';
      }
    } catch {
      document.getElementById('chat-indexed').textContent = 'server offline';
    }
  }

  async function updateServerStatus() {
    const el = document.getElementById('server-status');
    if (!el) return;
    el.textContent = 'checking…';
    el.style.color = 'var(--fg2)';
    try {
      const r = await fetch(SERVER + '/health', { signal: AbortSignal.timeout(3000) });
      if (!r.ok) {
        el.textContent = 'error ' + r.status;
        el.style.color = 'var(--amber)';
        return;
      }
      const d = await r.json().catch(() => ({}));
      const chunks = d.faiss_total ?? d.supabase_total ?? null;
      el.textContent = chunks !== null ? \`online (\${chunks} chunks)\` : 'online';
      el.style.color = 'var(--green)';
    } catch {
      el.textContent = 'offline';
      el.style.color = 'var(--red)';
    }
  }

  async function doSearch() {
    const input   = document.getElementById('chat-input');
    const query   = input.value.trim();
    if (!query) return;

    const messages = document.getElementById('chat-messages');
    const sendBtn  = document.getElementById('chat-send-btn');

    // Remove welcome screen on first search
    const welcome = messages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    messages.innerHTML += \`<div class="chat-bubble chat-bubble-user">\${esc(query)}</div>\`;
    input.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = '…';
    messages.scrollTop = messages.scrollHeight;

    const loadId = 'load-' + Date.now();
    messages.innerHTML += \`<div class="chat-bubble chat-bubble-bot" id="\${loadId}">
      <span class="chat-typing">⟳ Searching chunk history…</span>
    </div>\`;
    messages.scrollTop = messages.scrollHeight;

    try {
      const resp = await fetch(SERVER + '/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query, topK: 6 }),
        signal:  AbortSignal.timeout(30000),
      });

      const loader = document.getElementById(loadId);
      if (!resp.ok) {
        loader.innerHTML = \`<span style="color:var(--red)">Server error \${resp.status}</span>\`;
      } else {
        const data = await resp.json();
        if (data.warning) {
          loader.innerHTML = \`<span style="color:var(--amber)">⚠ \${esc(data.warning)}</span>\`;
        } else if (!data.results || data.results.length === 0) {
          loader.innerHTML = \`<span style="color:var(--fg2)">No matching history yet — keep coding and let chunks accumulate!</span>\`;
        } else {
          loader.className = '';
          loader.style.background = 'none';
          loader.style.border = 'none';
          loader.style.padding = '0';
          loader.style.alignSelf = 'stretch';
          loader.innerHTML = renderResults(data.results);
          document.getElementById('chat-indexed').textContent =
            (data.total_indexed ?? '?') + ' chunks indexed';
        }
      }
    } catch(err) {
      const loader = document.getElementById(loadId);
      if (loader) loader.innerHTML = \`<span style="color:var(--red)">Could not reach server — is it running on port 3141?</span>\`;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = '↑';
      messages.scrollTop = messages.scrollHeight;
    }
  }

  function renderResults(results) {
    return results.map((r, i) => {
      const score = Math.round((r.score ?? 0) * 100);
      const scoreColor = score >= 75 ? 'var(--green)' : score >= 50 ? 'var(--amber)' : 'var(--fg2)';
      const files = (r.file_paths || []).slice(0, 4).map(f =>
        '<span class="chat-file-chip">' + esc(f.split('/').pop() || f) + '</span>'
      ).join('');
      const time = r.start_time ? formatRelative(r.start_time) : '';
      return \`<div class="chat-result">
        <div class="chat-result-header">
          <span class="chat-score" style="background:\${scoreColor}22;color:\${scoreColor}">\${score}% match</span>
          <span class="chat-time">\${esc(time)}</span>
        </div>
        <div class="chat-result-summary">\${esc(r.summary)}</div>
        <div class="chat-files">\${files}</div>
      </div>\`;
    }).join('');
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatRelative(isoStr) {
    if (!isoStr) return '';
    try {
      const diff = (Date.now() - new Date(isoStr).getTime()) / 1000;
      if (diff < 60)    return 'just now';
      if (diff < 3600)  return Math.floor(diff/60) + 'm ago';
      if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
      return Math.floor(diff/86400) + 'd ago';
    } catch { return isoStr; }
  }

  function fileIcon(ext) {
    const map = {
      ts:'🟦', js:'🟨', py:'🐍', md:'📝', json:'📋',
      css:'🎨', html:'🌐', sh:'⚙', rs:'🦀', go:'🐹',
      java:'☕', rb:'💎', php:'🐘', vue:'💚', svelte:'🔶'
    };
    return map[ext] || '📄';
  }

  function formatDiff(diff) {
    if (!diff) return '';
    return diff.split('\\n').slice(0, 40).map(line => {
      if (line.startsWith('+') && !line.startsWith('+++'))
        return '<span class="diff-add">' + esc(line) + '</span>';
      if (line.startsWith('-') && !line.startsWith('---'))
        return '<span class="diff-remove">' + esc(line) + '</span>';
      return '<span class="diff-meta">' + esc(line) + '</span>';
    }).join('\\n');
  }

  // ── Message handler ────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'setState') {
      renderState(msg.payload);    } else if (msg.command === 'syncStatus') {
      const btn = document.getElementById('btn-sync-now');
      if (!btn) return;
      const status = msg.payload;
      if (status === 'flushing') {
        btn.textContent = '⏳ Syncing…';
        btn.disabled = true;
      } else if (status && status.startsWith('done:')) {
        const n = status.split(':')[1];
        btn.textContent = '✅ Synced (' + n + ' chunk' + (n === '1' ? '' : 's') + ')';
        btn.disabled = false;
        setTimeout(() => {
          btn.innerHTML = '<span class="btn-icon">⚡</span> Sync Now';
        }, 3000);
        updateIndexedCount();
      } else {
        btn.innerHTML = '<span class="btn-icon">⚠</span> Sync failed';
        btn.disabled = false;
        setTimeout(() => {
          btn.innerHTML = '<span class="btn-icon">⚡</span> Sync Now';
        }, 3000);
      }    }
  });

    // Signal ready
  send('ready');

  // Ensure handlers are wired even if inline handlers are blocked.
  const bind = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  };

  bind('btn-select-task', () => send('selectTask'));
  bind('btn-switch-task', () => send('switchTask'));
  bind('btn-view-report', () => send('viewReport'));
  bind('btn-pause', () => send('pause'));
  bind('btn-resume', () => send('resume'));
  bind('btn-refresh', () => send('refresh'));
  bind('btn-sync-now', () => send('syncNow'));
  bind('btn-open-settings', () => send('openSettings'));
  bind('btn-open-settings-2', () => send('openSettings'));
  bind('btn-chat', showChat);
  bind('btn-chat-back', hideChat);
  bind('chat-send-btn', doSearch);

  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSearch();
      }
    });
  }
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}






