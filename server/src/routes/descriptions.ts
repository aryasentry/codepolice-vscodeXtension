import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

export const descriptionsRouter = Router();

/**
 * GET /descriptions?workspacePath=...&limit=20&offset=0
 *
 * Returns recent change descriptions for a workspace, newest first.
 */
descriptionsRouter.get('/', async (req: Request, res: Response) => {
    const { workspacePath, limit = '20', offset = '0' } = req.query as Record<string, string>;

    if (!workspacePath) {
        res.status(400).json({ error: 'workspacePath query parameter is required.' });
        return;
    }

    const normPath = workspacePath.replace(/\\/g, '/').toLowerCase();

    try {
        // Resolve workspace
        const { data: ws, error: wsErr } = await supabase
            .from('workspaces')
            .select('id')
            .eq('path', normPath)
            .maybeSingle();

        if (wsErr) { throw new Error(wsErr.message); }
        if (!ws) { res.json({ descriptions: [], total: 0 }); return; }

        // Fetch from view
        const { data, error, count } = await supabase
            .from('recent_descriptions')
            .select('*', { count: 'exact' })
            .eq('workspace_id', ws.id)
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        if (error) { throw new Error(error.message); }

        res.json({ descriptions: data ?? [], total: count ?? 0 });

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[descriptions] Error:', message);
        res.status(500).json({ error: message });
    }
});


/**
 * GET /descriptions/alignment?workspacePath=...&limit=50
 *
 * Returns recent alignment snapshots for charting.
 */
descriptionsRouter.get('/alignment', async (req: Request, res: Response) => {
    const { workspacePath, limit = '50' } = req.query as Record<string, string>;

    if (!workspacePath) {
        res.status(400).json({ error: 'workspacePath query parameter is required.' });
        return;
    }

    const normPath = workspacePath.replace(/\\/g, '/').toLowerCase();

    try {
        const { data: ws } = await supabase
            .from('workspaces')
            .select('id')
            .eq('path', normPath)
            .maybeSingle();

        if (!ws) { res.json({ snapshots: [] }); return; }

        const { data, error } = await supabase
            .from('alignment_snapshots')
            .select('score, state, files_changed, computed_at')
            .eq('workspace_id', ws.id)
            .order('computed_at', { ascending: false })
            .limit(parseInt(limit));

        if (error) { throw new Error(error.message); }

        res.json({ snapshots: data ?? [] });

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});

/**
 * GET /descriptions/retrieval?workspacePath=...&limit=20
 *
 * Lightweight retrieval API for chat history/dashboard.
 * Returns recent sealed chunks + recent per-file descriptions.
 */
descriptionsRouter.get('/retrieval', async (req: Request, res: Response) => {
    const { workspacePath, limit = '20' } = req.query as Record<string, string>;

    if (!workspacePath) {
        res.status(400).json({ error: 'workspacePath query parameter is required.' });
        return;
    }

    const normPath = workspacePath.replace(/\\/g, '/').toLowerCase();
    const parsedLimit = Math.max(1, Math.min(100, parseInt(limit) || 20));

    try {
        const { data: ws } = await supabase
            .from('workspaces')
            .select('id, github_user')
            .eq('path', normPath)
            .maybeSingle();

        if (!ws) {
            res.json({ chunks: [], descriptions: [], total_chunks: 0, total_descriptions: 0 });
            return;
        }

        const [{ data: chunks, count: chunkCount, error: chunkErr }, { data: descriptions, count: descCount, error: descErr }] = await Promise.all([
            supabase
                .from('change_chunks')
                .select('id, summary, file_paths, start_time, end_time, github_user, task_id', { count: 'exact' })
                .eq('workspace_id', ws.id)
                .order('end_time', { ascending: false })
                .limit(parsedLimit),
            supabase
                .from('recent_descriptions')
                .select('*', { count: 'exact' })
                .eq('workspace_id', ws.id)
                .order('created_at', { ascending: false })
                .limit(parsedLimit),
        ]);

        if (chunkErr) throw new Error(chunkErr.message);
        if (descErr) throw new Error(descErr.message);

        res.json({
            workspace_path: normPath,
            github_user: ws.github_user,
            chunks: chunks ?? [],
            descriptions: descriptions ?? [],
            total_chunks: chunkCount ?? 0,
            total_descriptions: descCount ?? 0,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});

/**
 * GET /descriptions/progress?workspacePath=...
 *
 * Task progress + alignment snapshot summary for live dashboards.
 */
descriptionsRouter.get('/progress', async (req: Request, res: Response) => {
    const { workspacePath } = req.query as Record<string, string>;

    if (!workspacePath) {
        res.status(400).json({ error: 'workspacePath query parameter is required.' });
        return;
    }

    const normPath = workspacePath.replace(/\\/g, '/').toLowerCase();

    try {
        const { data: ws } = await supabase
            .from('workspaces')
            .select('id, github_user, path')
            .eq('path', normPath)
            .maybeSingle();

        if (!ws) {
            res.json({ workspace_path: normPath, task: null, progress: null });
            return;
        }

        const { data: activeTask } = await supabase
            .from('tasks')
            .select('id, task_key, description, github_user, created_at')
            .eq('workspace_id', ws.id)
            .eq('is_active', true)
            .maybeSingle();

        const { data: snapshots } = await supabase
            .from('alignment_snapshots')
            .select('score, state, computed_at')
            .eq('workspace_id', ws.id)
            .order('computed_at', { ascending: false })
            .limit(50);

        const { count: changeCount } = await supabase
            .from('file_changes')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', ws.id);

        const scores = (snapshots ?? []).map((s) => Number(s.score)).filter((n) => !Number.isNaN(n));
        const avgScore = scores.length > 0
            ? scores.reduce((acc, n) => acc + n, 0) / scores.length
            : null;

        res.json({
            workspace_path: ws.path,
            person: ws.github_user,
            task: activeTask
                ? {
                    id: activeTask.id,
                    key: activeTask.task_key,
                    description: activeTask.description,
                    assigned_to: activeTask.github_user,
                    original_assigned_at: activeTask.created_at,
                }
                : null,
            progress: {
                total_changes: changeCount ?? 0,
                latest_state: snapshots?.[0]?.state ?? (activeTask ? 'idle' : 'no-task'),
                latest_score: snapshots?.[0]?.score ?? null,
                average_score_50: avgScore,
                snapshot_count: snapshots?.length ?? 0,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
    }
});
