import { Router, Request, Response } from 'express';

export const searchRouter = Router();

const FAISS_URL = process.env.FAISS_SERVICE_URL ?? 'http://localhost:3142';

/**
 * POST /search
 * Body: { query: string, workspacePath?: string, taskId?: string, topK?: number }
 *
 * Proxies to the Python FAISS service, enriching with workspace_id if needed.
 */
searchRouter.post('/', async (req: Request, res: Response) => {
    const { query, workspacePath, taskId, topK = 10 } = req.body as {
        query: string;
        workspacePath?: string;
        taskId?: string;
        topK?: number;
    };

    if (!query?.trim()) {
        res.status(400).json({ error: 'query is required.' });
        return;
    }

    try {
        const resp = await fetch(`${FAISS_URL}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                top_k: topK,
                // workspace_id filter — pass through if provided
                workspace_id: workspacePath ?? undefined,
                task_id: taskId ?? undefined,
            }),
            signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`FAISS service error ${resp.status}: ${body}`);
        }

        const data = await resp.json() as {
            results: Array<{
                chunk_id: string;
                summary: string;
                score: number;
                file_paths: string[];
                start_time: string;
                end_time: string;
                task_id: string | null;
            }>;
            total_indexed: number;
        };

        res.json({
            results: data.results ?? [],
            total_indexed: data.total_indexed ?? 0,
            query,
        });

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[search] Error:', message);

        // If FAISS is offline, return a helpful empty response
        if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
            res.json({
                results: [],
                total_indexed: 0,
                query,
                warning: 'FAISS service is not running. Start it with: .venv/Scripts/python.exe -m uvicorn main:app --port 3142',
            });
        } else {
            res.status(500).json({ error: message });
        }
    }
});
