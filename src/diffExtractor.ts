import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';

/**
 * Extracts a diff for a given file.
 *
 * Strategy:
 * 1. If Git is available → run `git diff HEAD -- <file>` (fast, accurate)
 * 2. Fallback → line-based diff against previously stored content
 */
export async function extractDiff(
    filePath: string,
    previousContent?: string
): Promise<string> {
    // Try Git first
    const gitDiff = await tryGitDiff(filePath);
    if (gitDiff !== null) {
        return gitDiff;
    }

    // Fallback: in-process line diff
    if (previousContent !== undefined) {
        return lineDiff(previousContent, safeReadFile(filePath), filePath);
    }

    // First time seeing this file — return a creation marker
    const content = safeReadFile(filePath);
    if (content) {
        return `[NEW FILE]\n${content.slice(0, 2000)}`; // cap at 2KB for LLM
    }

    // Still emit a marker for empty newly-created files so creation events are tracked.
    return '[NEW FILE EMPTY]';
}

// ─── Git diff ─────────────────────────────────────────────────────────────────

function tryGitDiff(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
        const dir = path.dirname(filePath);
        // First check if the file is tracked by Git. If not, fall back.
        const check = cp.spawn('git', ['ls-files', '--error-unmatch', '--', filePath], {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        check.on('close', (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }

            const proc = cp.spawn('git', ['diff', 'HEAD', '--', filePath], {
                cwd: dir,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';

            proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));

            proc.on('close', (diffCode) => {
                if (diffCode === 0 && stdout.trim().length > 0) {
                    resolve(stdout);
                } else if (diffCode === 0 && stdout.trim().length === 0) {
                    // File is tracked but no diff against HEAD
                    resolve('');
                } else {
                    // Git not available or not a repo
                    resolve(null);
                }
            });

            proc.on('error', () => resolve(null));

            // Timeout safety
            setTimeout(() => {
                proc.kill();
                resolve(null);
            }, 5000);
        });

        check.on('error', () => resolve(null));
    });
}

// ─── Fallback line diff ────────────────────────────────────────────────────────

function lineDiff(oldContent: string, newContent: string, filePath: string): string {
    if (oldContent === newContent) return '';
    const fileName = path.basename(filePath);
    const patch = createTwoFilesPatch(
        `a/${fileName}`,
        `b/${fileName}`,
        oldContent,
        newContent,
        '',
        '',
        { context: 3 }
    );
    return patch.trim();
}

function safeReadFile(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return '';
    }
}
