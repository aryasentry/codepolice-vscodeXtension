import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { callOllama, buildPrompt } from '../lib/ollama';
import { addFileToChunk } from '../lib/chunkManager';

export const describeRouter = Router();

interface DescribeBody {
    workspacePath: string;
    workspaceName?: string;
    taskKey?: string;
    taskDescription?: string;
    githubUser?: string;
    filePath: string;
    fileHash: string;
    diff: string;
    changeCycle?: number;
    isNewFile?: boolean;
}

interface ParsedDescription {
    summary: string;
    classification: string;
    on_task_score: number;
    alignment_dimensions?: {
        objective_match?: number;
        changed_surface_relevance?: number;
        implementation_intent?: number;
        contradiction_penalty?: number;
    };
    confidence?: number;
}

type AlignmentState = 'aligned' | 'mild-drift' | 'drift' | 'idle' | 'no-task';

const VALID_CLASSIFICATIONS = [
    'feature', 'bugfix', 'refactor', 'test', 'docs',
    'chore', 'style', 'perf', 'security', 'unknown',
] as const;

function normalizeDescription(text: string): ParsedDescription {
    let parsed: ParsedDescription;
    try {
        const jsonText = text
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        parsed = JSON.parse(jsonText) as ParsedDescription;
    } catch {
        console.warn('[describe] Ollama did not return valid JSON, using fallback.');
        parsed = {
            summary: text.slice(0, 500) || 'No description available.',
            classification: 'unknown',
            on_task_score: 0.5,
        };
    }

    const score = Math.max(0, Math.min(1, parsed.on_task_score ?? 0.5));
    const classification = VALID_CLASSIFICATIONS.includes(parsed.classification as (typeof VALID_CLASSIFICATIONS)[number])
        ? parsed.classification
        : 'unknown';

    return {
        summary: parsed.summary || 'No description available.',
        classification,
        on_task_score: score,
        alignment_dimensions: parsed.alignment_dimensions,
        confidence: typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : undefined,
    };
}

function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && !Number.isNaN(v) ? v : fallback;
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

function computeCalibratedAlignmentScore(parsed: ParsedDescription): { score: number; breakdown: Record<string, number> } {
    const base = clamp01(num(parsed.on_task_score, 0.5));
    const dims = parsed.alignment_dimensions;

    if (!dims) {
        return {
            score: base,
            breakdown: {
                base,
                rubric: base,
                confidence: num(parsed.confidence, 0.7),
            },
        };
    }

    const objective = clamp01(num(dims.objective_match, base));
    const surface = clamp01(num(dims.changed_surface_relevance, base));
    const intent = clamp01(num(dims.implementation_intent, base));
    const contradiction = clamp01(num(dims.contradiction_penalty, 0));

    const rubricRaw = (0.45 * objective) + (0.30 * surface) + (0.25 * intent) - (0.35 * contradiction);
    const rubric = clamp01(rubricRaw);

    // Blend model's direct score with rubric-derived score to reduce noise.
    const blended = clamp01((0.30 * base) + (0.70 * rubric));

    // Confidence calibration: low confidence pulls score toward neutral (0.5).
    const confidence = clamp01(num(parsed.confidence, 0.7));
    const calibrated = clamp01((blended * confidence) + (0.5 * (1 - confidence)));

    return {
        score: calibrated,
        breakdown: {
            base,
            objective,
            surface,
            intent,
            contradiction,
            rubric,
            confidence,
            calibrated,
        },
    };
}

function deriveAlignmentState(score: number | null, taskId: string | null): AlignmentState {
    if (!taskId) return 'no-task';
    if (score === null) return 'idle';
    const alignedThreshold = parseFloat(process.env.ALIGNED_THRESHOLD ?? '0.75');
    const mildDriftThreshold = parseFloat(process.env.MILD_DRIFT_THRESHOLD ?? '0.5');
    if (score >= alignedThreshold) return 'aligned';
    if (score >= mildDriftThreshold) return 'mild-drift';
    return 'drift';
}

async function forwardDashboardEvent(payload: Record<string, unknown>): Promise<void> {
    const url = process.env.DASHBOARD_WEBHOOK_URL;
    if (!url) return;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.warn(`[describe] Dashboard webhook failed ${resp.status}: ${body}`);
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn('[describe] Dashboard webhook unreachable:', message);
    }
}

/**
 * POST /describe
 *
 * Body: DescribeBody (JSON)
 *
 * Flow:
 *   1. Upsert workspace row
 *   2. Resolve / create active task
 *   3. Insert file_change row
 *   4. Insert placeholder change_description row immediately (fast response)
 *   5. Return to caller immediately
 *   6. In background: call Ollama, update change_description row
 *   7. In background: add file to rolling chunk (chunking + embedding happen later)
 */
describeRouter.post('/', async (req: Request, res: Response) => {
    const body = req.body as DescribeBody;

    // ── Validate required fields ──────────────────────────────────────────────
    if (!body.workspacePath || !body.filePath || !body.diff || !body.fileHash) {
        res.status(400).json({ error: 'workspacePath, filePath, diff, fileHash are required.' });
        return;
    }

    const normPath = body.workspacePath.replace(/\\/g, '/').toLowerCase();
    const wsName = body.workspaceName ?? normPath.split('/').filter(Boolean).pop() ?? 'workspace';
    const taskKey = body.taskKey ?? 'NO-TASK';
    const taskDesc = body.taskDescription ?? '(no task description)';
    const githubUser = body.githubUser ?? 'aryasentry';

    try {
        // ── 1. Upsert workspace ───────────────────────────────────────────────
        const { data: ws, error: wsErr } = await supabase
            .from('workspaces')
            .upsert({ path: normPath, name: wsName, github_user: githubUser, last_seen_at: new Date().toISOString() },
                { onConflict: 'path' })
            .select('id')
            .single();

        if (wsErr || !ws) {
            throw new Error(`Workspace upsert failed: ${wsErr?.message}`);
        }
        const workspaceId = ws.id as string;

        // ── 2. Resolve active task (if any) ──────────────────────────────────
        let taskId: string | null = null;
        if (taskKey !== 'NO-TASK') {
            const { data: existingTask } = await supabase
                .from('tasks')
                .select('id')
                .eq('workspace_id', workspaceId)
                .eq('task_key', taskKey)
                .eq('is_active', true)
                .maybeSingle();

            if (existingTask) {
                taskId = existingTask.id as string;
            } else {
                // Deactivate old tasks, insert new one
                await supabase
                    .from('tasks')
                    .update({ is_active: false, deactivated_at: new Date().toISOString() })
                    .eq('workspace_id', workspaceId)
                    .eq('is_active', true);

                const { data: newTask, error: taskErr } = await supabase
                    .from('tasks')
                    .insert({
                        workspace_id: workspaceId,
                        task_key: taskKey,
                        description: taskDesc,
                        github_user: githubUser,
                        is_active: true,
                    })
                    .select('id')
                    .single();

                if (taskErr || !newTask) {
                    throw new Error(`Task insert failed: ${taskErr?.message}`);
                }
                taskId = newTask.id as string;
            }
        }

        // ── 3. Insert file_change ─────────────────────────────────────────────
        const { data: fc, error: fcErr } = await supabase
            .from('file_changes')
            .insert({
                workspace_id: workspaceId,
                task_id: taskId,
                github_user: githubUser,
                file_path: body.filePath,
                file_hash: body.fileHash,
                diff_content: body.diff,
                change_cycle: body.changeCycle ?? 1,
                is_new_file: body.isNewFile ?? false,
                processed_at: new Date().toISOString(),
            })
            .select('id')
            .single();

        if (fcErr || !fc) {
            throw new Error(`file_change insert failed: ${fcErr?.message}`);
        }
        const fileChangeId = fc.id as string;

        // ── 4. Insert placeholder change_description immediately ─────────────
        const { data: cd, error: cdErr } = await supabase
            .from('change_descriptions')
            .insert({
                file_change_id: fileChangeId,
                workspace_id: workspaceId,
                task_id: taskId,
                github_user: githubUser,
                model: process.env.OLLAMA_MODEL ?? 'qwen3-vl:235b-cloud',
                summary: '[queued] Description is being generated…',
                classification: 'unknown',
                on_task_score: 0.5,
                raw_response: { status: 'queued' },
                latency_ms: null,
            })
            .select()
            .single();

        if (cdErr || !cd) {
            throw new Error(`change_description insert failed: ${cdErr?.message}`);
        }

        // ── 5. Return immediately (fast path) ─────────────────────────────────
        res.json({
            id: cd.id,
            summary: cd.summary,
            classification: cd.classification,
            on_task_score: cd.on_task_score,
            model: cd.model,
            latency_ms: cd.latency_ms,
            file_change_id: fileChangeId,
            queued: true,
        });

        // ── 6/7. Background processing: LLM then chunking ────────────────────
        void (async () => {
            try {
                const prompt = buildPrompt({
                    filePath: body.filePath,
                    diff: body.diff,
                    taskKey,
                    taskDescription: taskDesc,
                    isNewFile: body.isNewFile ?? false,
                });

                const ollamaResult = await callOllama(prompt);
                const parsed = normalizeDescription(ollamaResult.text);
                const calibrated = computeCalibratedAlignmentScore(parsed);

                const { error: updateErr } = await supabase
                    .from('change_descriptions')
                    .update({
                        model: ollamaResult.model,
                        summary: parsed.summary,
                        classification: parsed.classification,
                        on_task_score: calibrated.score,
                        raw_response: {
                            ollama: ollamaResult.raw,
                            alignment_breakdown: calibrated.breakdown,
                            alignment_dimensions: parsed.alignment_dimensions ?? null,
                        },
                        latency_ms: ollamaResult.latencyMs,
                    })
                    .eq('id', cd.id);

                if (updateErr) {
                    console.error('[describe] Failed to update queued description:', updateErr.message);
                    return;
                }

                const alignmentState = deriveAlignmentState(calibrated.score, taskId);
                await supabase
                    .from('alignment_snapshots')
                    .insert({
                        workspace_id: workspaceId,
                        task_id: taskId,
                        github_user: githubUser,
                        score: calibrated.score,
                        state: alignmentState,
                        files_changed: 1,
                        computed_at: new Date().toISOString(),
                    });

                await addFileToChunk({
                    workspaceId,
                    taskId,
                    githubUser,
                    fileChangeId,
                    filePath: body.filePath,
                    summary: parsed.summary,
                });

                await forwardDashboardEvent({
                    event: 'code_change_processed',
                    github_user: githubUser,
                    workspace_id: workspaceId,
                    workspace_path: normPath,
                    task: {
                        id: taskId,
                        key: taskKey,
                        description: taskDesc,
                    },
                    file_change: {
                        id: fileChangeId,
                        file_path: body.filePath,
                        change_cycle: body.changeCycle ?? 1,
                        is_new_file: body.isNewFile ?? false,
                    },
                    description: {
                        id: cd.id,
                        summary: parsed.summary,
                        classification: parsed.classification,
                        on_task_score: calibrated.score,
                    },
                    alignment: {
                        state: alignmentState,
                        score: calibrated.score,
                        breakdown: calibrated.breakdown,
                    },
                    ts: new Date().toISOString(),
                });
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                console.error('[describe] Background processing failed:', message);

                await supabase
                    .from('change_descriptions')
                    .update({
                        summary: '[failed] Description generation failed. Retrying on next change.',
                        classification: 'unknown',
                        on_task_score: 0.5,
                        raw_response: { error: message },
                    })
                    .eq('id', cd.id);
            }
        })();

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[describe] Error:', message);
        res.status(500).json({ error: message });
    }
});
