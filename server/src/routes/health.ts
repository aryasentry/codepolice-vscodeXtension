import { Router, Request, Response } from 'express';

export const healthRouter = Router();

const FAISS_URL = process.env.FAISS_SERVICE_URL ?? 'http://localhost:3142';

healthRouter.get('/', async (_req: Request, res: Response) => {
    // Try to also get FAISS status
    let faissTotal: number | undefined;
    try {
        const r = await fetch(`${FAISS_URL}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
            const d = await r.json() as { faiss_total?: number };
            faissTotal = d.faiss_total;
        }
    } catch { /* FAISS offline — just omit */ }

    res.json({
        status: 'ok',
        service: 'codepolice-server',
        model: process.env.OLLAMA_MODEL ?? 'qwen3-vl:235b-cloud',
        time: new Date().toISOString(),
        faiss_total: faissTotal,
        faiss_online: faissTotal !== undefined,
    });
});
