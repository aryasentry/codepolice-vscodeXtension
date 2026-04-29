import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { ChangeBuffer } from './changeBuffer';
import { SnapshotStore } from './snapshotStore';
import { StatusBarManager, AlignmentState } from './statusBar';
import { extractDiff } from './diffExtractor';


type StateChangeCallback = (state: AlignmentState, score?: number) => void;

/**
 * Debounced batch processor — waits for N seconds of inactivity,
 * then processes all accumulated changed files.
 */
export class DebouncedBatchProcessor {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
    private isRunning: boolean = false;
    private isPaused: boolean = false;
    private pendingRun: boolean = false;
    private stateChangeCallbacks: StateChangeCallback[] = [];

    constructor(
        private readonly changeBuffer: ChangeBuffer,
        private readonly snapshotStore: SnapshotStore,
        private readonly statusBar: StatusBarManager,
        private readonly context: vscode.ExtensionContext
    ) { }

    /** Subscribe to state transitions (e.g. to refresh the sidebar). */
    onStateChange(cb: StateChangeCallback): void {
        this.stateChangeCallbacks.push(cb);
    }

    private emit(state: AlignmentState, score?: number): void {
        this.statusBar.update(state, score);
        for (const cb of this.stateChangeCallbacks) {
            cb(state, score);
        }
    }

    private stateFromScore(score: number | null): AlignmentState {
        if (!this.snapshotStore.getActiveTask()) {
            return 'no-task';
        }
        if (score === null) {
            return 'idle';
        }
        const cfg = vscode.workspace.getConfiguration('codepolice');
        const alignedThreshold: number = cfg.get('alignedThreshold') ?? 0.75;
        const mildDriftThreshold: number = cfg.get('mildDriftThreshold') ?? 0.5;
        if (score >= alignedThreshold) return 'aligned';
        if (score >= mildDriftThreshold) return 'mild-drift';
        return 'drift';
    }

    schedule(): void {
        if (this.isPaused) return;
        if (this.isRunning) {
            this.pendingRun = true;
            return;
        }
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        const debounceMs = this.getDebounceMs();
        this.debounceTimer = setTimeout(() => this.process(), debounceMs);

        const maxWaitMs = this.getMaxDebounceMs();
        if (!this.maxWaitTimer && maxWaitMs > 0) {
            this.maxWaitTimer = setTimeout(() => this.process(), maxWaitMs);
        }
    }

    pause(): void {
        this.isPaused = true;
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
        if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }
        this.emit('paused');
        console.log('[CodePolice] Tracking paused.');
    }

    resume(): void {
        this.isPaused = false;
        this.emit(this.snapshotStore.getActiveTask() ? 'idle' : 'no-task');
        console.log('[CodePolice] Tracking resumed.');
    }

    get paused(): boolean { return this.isPaused; }

    private async process(): Promise<void> {
        if (this.isRunning) {
            this.pendingRun = true;
            return;
        }
        if (this.changeBuffer.isEmpty()) return;

        const debug: boolean = vscode.workspace.getConfiguration('codepolice').get('debug') ?? false;

        this.isRunning = true;
        if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
        if (this.maxWaitTimer) { clearTimeout(this.maxWaitTimer); this.maxWaitTimer = null; }
        this.emit('processing');

        const files = this.changeBuffer.drain();
        console.log(`[CodePolice] Processing ${files.length} changed file(s).`);

        const changeSummaries: string[] = [];
        const taskScores: number[] = [];

        for (const filePath of files) {
            try {
                const newHash = await this.hashFile(filePath);
                const stored = this.snapshotStore.getFileSnapshot(filePath);

                if (stored && stored.lastHash === newHash) {
                    if (debug) {
                        console.log(`[CodePolice][debug] Skipped (hash same): ${filePath}`);
                    }
                    continue;
                }

                const diff = await extractDiff(filePath, stored?.lastContent);
                if (diff.trim().length === 0) {
                    if (debug) {
                        console.log(`[CodePolice][debug] Skipped (empty diff): ${filePath}`);
                    }
                    continue;
                }

                const changeCount = (stored?.changeCount ?? 0) + 1;
                this.snapshotStore.updateFileSnapshot(filePath, {
                    lastHash: newHash,
                    lastProcessedAt: new Date().toISOString(),
                    changeCount,
                    lastDiff: diff,
                    lastContent: this.safeReadFile(filePath),
                });

                const describe = await this.callDescribeServer({
                    filePath,
                    fileHash: newHash,
                    diff,
                    isNewFile: !stored,
                    changeCount,
                });
                changeSummaries.push(describe.text);
                if (typeof describe.onTaskScore === 'number') {
                    taskScores.push(describe.onTaskScore);
                }

                console.log(`[CodePolice] Processed: ${filePath}`);
            } catch (err) {
                console.error(`[CodePolice] Error processing ${filePath}:`, err);
            }
        }

        if (changeSummaries.length > 0) {
            this.snapshotStore.appendChangeSummaries(changeSummaries);
            const score = taskScores.length > 0
                ? taskScores.reduce((sum, s) => sum + s, 0) / taskScores.length
                : null;
            const state = this.stateFromScore(score);
            this.emit(state, score ?? undefined);
        } else {
            this.emit(this.snapshotStore.getActiveTask() ? 'idle' : 'no-task');
        }

        this.isRunning = false;

        if (this.pendingRun || !this.changeBuffer.isEmpty()) {
            this.pendingRun = false;
            await this.process();
        }
    }

    private async hashFile(filePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (d) => hash.update(d));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    private safeReadFile(filePath: string): string {
        try { return fs.readFileSync(filePath, 'utf-8'); }
        catch { return ''; }
    }

    private getDebounceMs(): number {
        const cfg = vscode.workspace.getConfiguration('codepolice');
        const seconds: number = cfg.get('debounceSeconds') ?? 30;
        return seconds * 1000;
    }

    private getMaxDebounceMs(): number {
        const cfg = vscode.workspace.getConfiguration('codepolice');
        const seconds: number = cfg.get('maxDebounceSeconds') ?? 120;
        return seconds * 1000;
    }

    /**
     * POST /describe to the local description server.
     * Returns text summary + on_task_score (null if server unavailable).
     * Never throws — falls back to a local stub so the extension stays functional
     * even when the server is not running.
     */
    private async callDescribeServer(opts: {
        filePath: string;
        fileHash: string;
        diff: string;
        isNewFile: boolean;
        changeCount: number;
    }): Promise<{ text: string; onTaskScore: number | null }> {
        const cfg = vscode.workspace.getConfiguration('codepolice');
        const serverUrl: string = cfg.get('serverUrl') ?? 'http://localhost:3141';

        const task = this.snapshotStore.getActiveTask();
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(opts.filePath));
        const wsRoot = folder?.uri.fsPath ?? '';
        const wsName = folder?.name ?? (wsRoot ? wsRoot.split(/[\\/]/).pop() : undefined);

        // Make filePath relative to workspace root for cleaner storage
        const relPath = wsRoot && opts.filePath.startsWith(wsRoot)
            ? opts.filePath.slice(wsRoot.length).replace(/\\/g, '/').replace(/^\//, '')
            : opts.filePath;

        const body = {
            workspacePath: wsRoot || opts.filePath,
            workspaceName: wsName,
            taskKey: task?.id,
            taskDescription: task?.description,
            githubUser: cfg.get<string>('githubUser') ?? 'aryasentry',
            filePath: relPath,
            fileHash: opts.fileHash,
            diff: opts.diff,
            changeCycle: opts.changeCount,
            isNewFile: opts.isNewFile,
        };

        try {
            const resp = await fetch(`${serverUrl}/describe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(12_000), // fast path: server queues LLM work and returns quickly
            });

            if (!resp.ok) {
                const errText = await resp.text().catch(() => resp.status.toString());
                console.warn(`[CodePolice] Describe server returned ${resp.status}: ${errText}`);
                return { text: `Changed: ${relPath}`, onTaskScore: null };
            }

            const data = await resp.json() as {
                summary: string;
                on_task_score: number;
                classification: string;
                queued?: boolean;
            };

            if (data.queued) {
                return {
                    text: `[queued] ${relPath}`,
                    onTaskScore: null,
                };
            }

            return {
                text: `[${data.classification ?? 'change'}] ${data.summary ?? relPath}`,
                onTaskScore: typeof data.on_task_score === 'number' ? data.on_task_score : null,
            };

        } catch (err) {
            // Server offline or timed out — fall back silently
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[CodePolice] Describe server unreachable (${msg}). Using local stub.`);
            const fileName = opts.filePath.split(/[\\/]/).pop() ?? opts.filePath;
            return { text: `Changed: ${fileName}`, onTaskScore: null };
        }
    }
}
