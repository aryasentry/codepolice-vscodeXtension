import * as vscode from 'vscode';
import { ChangeBuffer } from './changeBuffer';
import { DebouncedBatchProcessor } from './batchProcessor';

/**
 * Resolves the absolute paths of all workspace roots.
 * Returns undefined if no workspace folder is open.
 */
export function getWorkspaceRoots(): string[] | undefined {
    return vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath);
}

/**
 * Subscribes to VS Code workspace events and feeds the ChangeBuffer.
 * Only tracks files INSIDE the current workspace folder — multi-window safe.
 * No heavy processing happens here — just capture and queue.
 */
export class EventListener {
    private readonly workspaceRoots: string[] | undefined;

    constructor(
        private readonly changeBuffer: ChangeBuffer,
        private readonly batchProcessor: DebouncedBatchProcessor,
        private readonly context: vscode.ExtensionContext
    ) {
        this.workspaceRoots = getWorkspaceRoots();
        if (this.workspaceRoots && this.workspaceRoots.length > 0) {
            console.log(`[CodePolice] Workspace roots (scoped): ${this.workspaceRoots.join(', ')}`);
        } else {
            console.warn('[CodePolice] No workspace folder — tracking ALL files (no scoping).');
        }
    }

    register(): void {

        const cfg = vscode.workspace.getConfiguration('codepolice');
        const excludedDirs: string[] = cfg.get('excludedDirs') ?? [
            'node_modules', 'dist', 'build', '.git', 'coverage', 'out',
        ];
        const debug: boolean = cfg.get('debug') ?? false;

        const guard = (filePath: string): boolean =>
            this.isInsideWorkspace(filePath) && !this.isExcluded(filePath, excludedDirs);

        // On save
        this.context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (!guard(doc.uri.fsPath)) {
                    if (debug) {
                        console.log(`[CodePolice][debug] Ignored save: ${doc.uri.fsPath}`);
                    }
                    return;
                }
                if (debug) {
                    console.log(`[CodePolice][debug] Saved: ${doc.uri.fsPath}`);
                }
                this.changeBuffer.add(doc.uri.fsPath);
                this.batchProcessor.schedule();
            })
        );

        // FileSystemWatcher (captures external/tool-driven changes too)
        const watcherRoots = vscode.workspace.workspaceFolders ?? [];
        for (const root of watcherRoots) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(root, '**/*')
            );

            this.context.subscriptions.push(
                watcher.onDidCreate((uri) => {
                    if (guard(uri.fsPath)) {
                        if (debug) {
                            console.log(`[CodePolice][debug] FS created: ${uri.fsPath}`);
                        }
                        this.changeBuffer.add(uri.fsPath);
                        this.batchProcessor.schedule();
                    }
                })
            );

            this.context.subscriptions.push(
                watcher.onDidChange((uri) => {
                    if (guard(uri.fsPath)) {
                        if (debug) {
                            console.log(`[CodePolice][debug] FS changed: ${uri.fsPath}`);
                        }
                        this.changeBuffer.add(uri.fsPath);
                        this.batchProcessor.schedule();
                    }
                })
            );

            this.context.subscriptions.push(
                watcher.onDidDelete((uri) => {
                    if (this.isInsideWorkspace(uri.fsPath)) {
                        if (debug) {
                            console.log(`[CodePolice][debug] FS deleted: ${uri.fsPath}`);
                        }
                        this.changeBuffer.remove(uri.fsPath);
                    }
                })
            );

            this.context.subscriptions.push(watcher);
        }

        // On file create
        this.context.subscriptions.push(
            vscode.workspace.onDidCreateFiles((e) => {
                for (const file of e.files) {
                    if (guard(file.fsPath)) {
                        if (debug) {
                            console.log(`[CodePolice][debug] Created: ${file.fsPath}`);
                        }
                        this.changeBuffer.add(file.fsPath);
                    } else if (debug) {
                        console.log(`[CodePolice][debug] Ignored create: ${file.fsPath}`);
                    }
                }
                this.batchProcessor.schedule();
            })
        );

        // On file delete
        this.context.subscriptions.push(
            vscode.workspace.onDidDeleteFiles((e) => {
                for (const file of e.files) {
                    if (this.isInsideWorkspace(file.fsPath)) {
                        if (debug) {
                            console.log(`[CodePolice][debug] Deleted: ${file.fsPath}`);
                        }
                        this.changeBuffer.remove(file.fsPath);
                    } else if (debug) {
                        console.log(`[CodePolice][debug] Ignored delete: ${file.fsPath}`);
                    }
                }
            })
        );

        // On file rename
        this.context.subscriptions.push(
            vscode.workspace.onDidRenameFiles((e) => {
                for (const { oldUri, newUri } of e.files) {
                    if (this.isInsideWorkspace(oldUri.fsPath)) {
                        if (debug) {
                            console.log(`[CodePolice][debug] Renamed (old): ${oldUri.fsPath}`);
                        }
                        this.changeBuffer.remove(oldUri.fsPath);
                    }
                    if (guard(newUri.fsPath)) {
                        if (debug) {
                            console.log(`[CodePolice][debug] Renamed (new): ${newUri.fsPath}`);
                        }
                        this.changeBuffer.add(newUri.fsPath);
                    } else if (debug) {
                        console.log(`[CodePolice][debug] Ignored rename target: ${newUri.fsPath}`);
                    }
                }
                this.batchProcessor.schedule();
            })
        );

        console.log('[CodePolice] EventListener registered.');
    }

    /**
     * Returns true if filePath is inside any workspace root.
     * When no workspace roots are known, returns TRUE (no scoping — allow all files).
     */
    private isInsideWorkspace(filePath: string): boolean {
        const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
        if (!this.workspaceRoots || this.workspaceRoots.length === 0) { return true; }
        return this.workspaceRoots.some((root) => {
            const rootNorm = norm(root);
            const fileNorm = norm(filePath);
            return fileNorm.startsWith(rootNorm + '/') || fileNorm === rootNorm;
        });
    }

    private isExcluded(filePath: string, excludedDirs: string[]): boolean {
        const normalized = filePath.replace(/\\/g, '/');
        return excludedDirs.some((dir) => normalized.includes(`/${dir}/`));
    }
}
