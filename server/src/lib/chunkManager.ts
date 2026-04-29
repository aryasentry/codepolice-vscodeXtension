/**
 * chunkManager.ts — Time-based chunk management.
 *
 * Strategy
 * - A new chunk opens when the first file is processed for a workspace.
 * - The chunk seals when either:
 *   a) CHUNK_WINDOW_MS has elapsed since the first file in the chunk, OR
 *   b) CHUNK_MAX_MS has elapsed (force-seal even during continuous activity)
 * - On seal: generate a chunk-level summary with Ollama and store in Supabase.
 * - Optional: push to FAISS /embed (disabled by default; FAISS can pull from Supabase).
 */

import { supabase } from './supabase';
import { callOllama } from './ollama';

const CHUNK_WINDOW_MS = parseInt(process.env.CHUNK_WINDOW_MS ?? '', 10) || 90 * 1000;  // 90s default (env overrides)
const CHUNK_MAX_MS = parseInt(process.env.CHUNK_MAX_MS ?? '', 10) || 10 * 60 * 1000;  // 10 min hard cap
const FAISS_URL = process.env.FAISS_SERVICE_URL ?? 'http://localhost:3142';
const FAISS_PUSH_ENABLED = (process.env.FAISS_PUSH_ENABLED ?? 'true').toLowerCase() !== 'false';

interface PendingFile {
    fileChangeId: string;
    filePath: string;
    summary: string;
    timestamp: Date;
}

interface ActiveChunk {
    workspaceId: string;
    taskId: string | null;
    githubUser: string;
    startTime: Date;
    files: PendingFile[];
    sealTimer: ReturnType<typeof setTimeout>;
}

const activeChunks = new Map<string, ActiveChunk>();

export async function addFileToChunk(opts: {
    workspaceId: string;
    taskId: string | null;
    githubUser: string;
    fileChangeId: string;
    filePath: string;
    summary: string;
}): Promise<void> {
    const { workspaceId, taskId, githubUser, fileChangeId, filePath, summary } = opts;

    let chunk = activeChunks.get(workspaceId);

    if (!chunk) {
        const sealTimer = setTimeout(() => {
            sealChunk(workspaceId, 'max-time');
        }, CHUNK_MAX_MS);

        const windowTimer = setTimeout(() => {
            sealChunk(workspaceId, 'window');
        }, CHUNK_WINDOW_MS);

        chunk = {
            workspaceId,
            taskId,
            githubUser,
            startTime: new Date(),
            files: [],
            sealTimer,
        };

        (chunk as any)._windowTimer = windowTimer;
        activeChunks.set(workspaceId, chunk);
        console.log(`[ChunkManager] Opened new chunk for workspace ${workspaceId.slice(0, 8)}...`);
    }

    chunk.files.push({ fileChangeId, filePath, summary, timestamp: new Date() });
    console.log(`[ChunkManager] Chunk now has ${chunk.files.length} file(s).`);
}

async function sealChunk(workspaceId: string, reason: string): Promise<void> {
    const chunk = activeChunks.get(workspaceId);
    if (!chunk || chunk.files.length === 0) {
        activeChunks.delete(workspaceId);
        return;
    }

    clearTimeout(chunk.sealTimer);
    clearTimeout((chunk as any)._windowTimer);
    activeChunks.delete(workspaceId);

    console.log(`[ChunkManager] Sealing chunk (${reason}) — ${chunk.files.length} file(s)`);

    const fileSummaries = chunk.files
        .map(f => `• ${f.filePath}: ${f.summary}`)
        .join('\n');

    const chunkPrompt =
        `You are a senior engineer summarising a coding session. ` +
        `Below are brief summaries of individual file changes made in the last session.\n\n` +
        `${fileSummaries}\n\n` +
        `Write a concise technical summary (2–4 sentences) of the overall session: ` +
        `what was built or changed, key themes, and any notable patterns. ` +
        `Be specific and use technical terms. Do NOT return JSON.`;

    let chunkSummary = 'No summary available.';
    try {
        const result = await callOllama(chunkPrompt, process.env.OLLAMA_SUMMARY_MODEL ?? 'qwen2.5:1.5b');
        chunkSummary = result.text.slice(0, 1000) || chunkSummary;
    } catch (e) {
        console.error('[ChunkManager] Chunk summary generation failed:', e);
    }

    const endTime = new Date();
    const filePaths = chunk.files.map(f => f.filePath);

    const { data: chunkRow, error: chunkErr } = await supabase
        .from('change_chunks')
        .insert({
            workspace_id: workspaceId,
            task_id: chunk.taskId,
            github_user: chunk.githubUser,
            start_time: chunk.startTime.toISOString(),
            end_time: endTime.toISOString(),
            summary: chunkSummary,
            file_count: chunk.files.length,
            file_paths: filePaths,
            is_embedded: false,
        })
        .select('id')
        .single();

    if (chunkErr || !chunkRow) {
        console.error('[ChunkManager] Failed to insert change_chunk:', chunkErr?.message);
        return;
    }
    const chunkId = chunkRow.id as string;

    const fileChangeIds = chunk.files.map(f => f.fileChangeId);
    await supabase
        .from('file_changes')
        .update({ chunk_id: chunkId })
        .in('id', fileChangeIds);

    if (FAISS_PUSH_ENABLED) {
        try {
            const resp = await fetch(`${FAISS_URL}/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chunk_id: chunkId,
                    workspace_id: workspaceId,
                    task_id: chunk.taskId,
                    summary: chunkSummary,
                    file_paths: filePaths,
                    start_time: chunk.startTime.toISOString(),
                    end_time: endTime.toISOString(),
                }),
            });

            if (resp.ok) {
                await supabase
                    .from('change_chunks')
                    .update({ is_embedded: true })
                    .eq('id', chunkId);
                console.log(`[ChunkManager] Chunk ${chunkId.slice(0, 8)}... embedded in FAISS.`);
            } else {
                const body = await resp.text();
                console.warn(`[ChunkManager] FAISS embed failed ${resp.status}: ${body}`);
            }
        } catch (e) {
            console.warn('[ChunkManager] FAISS service unreachable — will sync later via background job.', e);
        }
    }

    console.log(`[ChunkManager] Chunk sealed. ID: ${chunkId.slice(0, 8)}...`);
}

export async function sealAllChunks(): Promise<void> {
    const workspaceIds = Array.from(activeChunks.keys());
    await Promise.allSettled(workspaceIds.map(id => sealChunk(id, 'shutdown')));
}
