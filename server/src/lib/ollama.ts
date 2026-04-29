/**
 * Thin wrapper around the Ollama HTTP API.
 * Calls the /api/generate endpoint (non-streaming, single response).
 */

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:1.5b';
const SUMMARY_MODEL = process.env.OLLAMA_SUMMARY_MODEL ?? 'qwen2.5:1.5b';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? 'qwen3-embedding:0.6b';

export interface OllamaResult {
    text: string;
    model: string;
    latencyMs: number;
    raw: Record<string, unknown>;
}

/**
 * Call Ollama /api/generate.
 * @param prompt  The prompt to send.
 * @param model   Optional — defaults to OLLAMA_MODEL env var. Pass SUMMARY_MODEL for chunk summaries.
 */
export async function callOllama(prompt: string, model?: string): Promise<OllamaResult> {
    const resolvedModel = model ?? DEFAULT_MODEL;
    const start = Date.now();

    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: resolvedModel,
            prompt,
            stream: false,
            options: {
                temperature: 0.2,   // Low temp for deterministic code analysis
                top_p: 0.9,
                num_predict: 512,
            },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${body}`);
    }

    const raw = (await res.json()) as Record<string, unknown>;
    const text = (raw.response as string | undefined)?.trim() ?? '';
    const latencyMs = Date.now() - start;

    return { text, model: resolvedModel, latencyMs, raw };
}

export { SUMMARY_MODEL };

export async function callOllamaEmbed(text: string): Promise<{ embedding: number[]; model: string; latencyMs: number }> {
    const start = Date.now();
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: EMBED_MODEL,
            prompt: text,
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${body}`);
    }

    const raw = (await res.json()) as { embedding?: number[] };
    const latencyMs = Date.now() - start;

    return {
        embedding: raw.embedding ?? [],
        model: EMBED_MODEL,
        latencyMs,
    };
}

/**
 * Builds the structured prompt for code change analysis.
 * Asks the model to return JSON so we can parse classification + score.
 */
export function buildPrompt(opts: {
    filePath: string;
    diff: string;
    taskKey: string;
    taskDescription: string;
    isNewFile: boolean;
}): string {
    const { filePath, diff, taskKey, taskDescription, isNewFile } = opts;

    const diffSection = isNewFile
        ? `[NEW FILE CREATED]\n${diff.slice(0, 1500)}`
        : diff.slice(0, 1500);  // Trim very large diffs — model has a context limit

        return `You are a senior staff engineer reviewing whether a code change aligns with an active task.
Use strict evidence from the diff only. Do not hallucinate hidden intent.
Respond with ONLY valid JSON.

ACTIVE TASK: [${taskKey}] ${taskDescription}

FILE: ${filePath}
CHANGE:
\`\`\`diff
${diffSection}
\`\`\`

Respond with exactly this JSON structure (no markdown, no explanation outside JSON):
{
  "summary": "<1-3 sentences describing what changed and why>",
  "classification": "<one of: feature, bugfix, refactor, test, docs, chore, style, perf, security, unknown>",
    "on_task_score": <float 0.0-1.0 overall relevance to active task>,
    "alignment_dimensions": {
        "objective_match": <float 0.0-1.0 how directly the change serves the task objective>,
        "changed_surface_relevance": <float 0.0-1.0 whether touched files/code areas are relevant>,
        "implementation_intent": <float 0.0-1.0 whether implementation direction supports task>,
        "contradiction_penalty": <float 0.0-1.0 where higher means stronger evidence of contradiction>
    },
    "confidence": <float 0.0-1.0 confidence in this judgement>
}`;
}

export function buildChunkPrompt(items: Array<{ filePath: string; summary: string }>): string {
    const lines = items.map((i) => `- ${i.filePath}: ${i.summary}`).join('\n');
    return `Summarize the following coding changes as a single technical update.
Be concise and broad. Mention key files and themes. Return plain text only.

CHANGES:
${lines}`;
}
