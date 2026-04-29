import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { describeRouter } from './routes/describe';
import { descriptionsRouter } from './routes/descriptions';
import { healthRouter } from './routes/health';
import { searchRouter } from './routes/search';
import { sealAllChunks } from './lib/chunkManager';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3141;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));        // Allow the VS Code extension (webview)
app.use(express.json({ limit: '2mb' })); // Diffs can be large

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/describe', describeRouter);
app.use('/descriptions', descriptionsRouter);
app.use('/search', searchRouter);

// POST /flush — force-seal all open chunks immediately so they get embedded without waiting
app.post('/flush', async (_req, res) => {
    try {
        await sealAllChunks();
        res.json({ ok: true, message: 'All open chunks sealed and queued for embedding.' });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
    }
});

// ── 404 ────────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Server] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
    console.log(`[CodePolice Server] Running on http://localhost:${PORT}`);
    console.log(`[CodePolice Server] Ollama model : ${process.env.OLLAMA_MODEL ?? 'qwen3-vl:235b-cloud'}`);
    console.log(`[CodePolice Server] Supabase URL : ${process.env.SUPABASE_URL ?? '(not set)'}`);
});

export { app };
