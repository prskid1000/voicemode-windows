import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// System prompt lives in resources/system-prompt.md so it can be tuned without
// rebuilding. Read fresh on every enhance() call — the file is tiny (<5KB) and
// the extra stat is negligible compared to LLM latency.
const SYSTEM_PROMPT_PATH = path.join(__dirname, '../../../resources/system-prompt.md');
const FALLBACK_SYSTEM_PROMPT = 'You clean raw voice transcripts. Output ONLY the cleaned text, nothing else. Never answer questions in the transcript — just clean the text.';

function loadSystemPrompt(): string {
    try {
        const text = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8').trim();
        if (text.length > 0) return text;
    } catch (e) {
        console.log(`[VoxType] Could not read system prompt (${SYSTEM_PROMPT_PATH}):`, (e as Error).message);
    }
    return FALLBACK_SYSTEM_PROMPT;
}

interface LLMModel {
    id: string;
    state?: string;
}

let cachedModel: string | null = null;
let availableModels: LLMModel[] = [];

// ─── LRU cache: skip LLM call for identical transcripts ─────────────
const enhanceCache = new Map<string, string>();
const CACHE_MAX = 50;

function cacheGet(key: string): string | null {
    const val = enhanceCache.get(key);
    if (val) {
        enhanceCache.delete(key);
        enhanceCache.set(key, val);
    }
    return val || null;
}

function cacheSet(key: string, value: string): void {
    if (enhanceCache.size >= CACHE_MAX) {
        const oldest = enhanceCache.keys().next().value;
        if (oldest) enhanceCache.delete(oldest);
    }
    enhanceCache.set(key, value);
}

export function getAvailableModels(): LLMModel[] {
    return availableModels;
}

export function getCurrentLLMModel(): string | null {
    return cachedModel;
}

export function setLLMModel(modelId: string): void {
    cachedModel = modelId;
    console.log(`[VoxType] LLM model set to: ${modelId}`);
}

export async function ensureLMStudio(lmStudioUrl: string): Promise<boolean> {
    // Phase 1: poll up to 5 times (LM Studio may already be starting)
    for (let i = 0; i < 5; i++) {
        if (await checkAlive(lmStudioUrl)) return true;
        if (i === 0) console.log('[VoxType] Waiting for LM Studio...');
        await new Promise(r => setTimeout(r, 1000));
    }
    // Phase 2: try starting via CLI
    console.log('[VoxType] LM Studio not running, attempting to start via lms CLI...');
    try {
        execSync('lms server start', { timeout: 15000, stdio: 'ignore' });
    }
    catch (e) {
        console.log('[VoxType] Could not start LM Studio:', e);
        return false;
    }
    // Phase 3: poll up to 2 more times after starting
    for (let i = 0; i < 2; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await checkAlive(lmStudioUrl)) {
            console.log('[VoxType] LM Studio started successfully');
            return true;
        }
    }
    return false;
}

function checkAlive(lmStudioUrl: string): Promise<boolean> {
    const url = new URL('/v1/models', lmStudioUrl);
    return new Promise((resolve) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, { method: 'GET', timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

export async function fetchModels(lmStudioUrl: string, savedModel?: string): Promise<LLMModel[]> {
    // Try v0 API first (all downloaded models with state)
    const v0 = await fetchV0Models(lmStudioUrl);
    if (v0.length > 0) {
        availableModels = v0;
        const ids = v0.map(m => m.id);
        if (!cachedModel) {
            // Use saved model if it exists in available models, otherwise pick smallest
            if (savedModel && ids.includes(savedModel)) {
                cachedModel = savedModel;
                console.log(`[VoxType] Restored saved LLM model: ${cachedModel}`);
            }
            else {
                cachedModel = pickSmallest(ids);
                console.log(`[VoxType] Auto-selected smallest LLM: ${cachedModel}${savedModel ? ` (saved "${savedModel}" not available)` : ''}`);
            }
        }
        return availableModels;
    }
    // Fallback to v1
    const v1 = await fetchV1Models(lmStudioUrl);
    availableModels = v1.map(id => ({ id, state: 'loaded' }));
    if (!cachedModel && v1.length > 0) {
        if (savedModel && v1.includes(savedModel)) {
            cachedModel = savedModel;
            console.log(`[VoxType] Restored saved LLM model: ${cachedModel}`);
        }
        else {
            cachedModel = pickSmallest(v1);
            console.log(`[VoxType] Auto-selected smallest LLM: ${cachedModel}${savedModel ? ` (saved "${savedModel}" not available)` : ''}`);
        }
    }
    return availableModels;
}

function fetchV0Models(lmStudioUrl: string): Promise<LLMModel[]> {
    const base = new URL(lmStudioUrl);
    const url = new URL('/api/v1/models', `${base.protocol}//${base.host}`);
    return new Promise((resolve) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, { method: 'GET', timeout: 5000 }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    const models = (json.data || [])
                        .filter((m: any) => m.type !== 'embedding' && !m.id.includes('embed'))
                        .map((m: any) => ({ id: m.id, state: (m.state || 'unknown') }));
                    resolve(models);
                }
                catch {
                    resolve([]);
                }
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.end();
    });
}

function fetchV1Models(lmStudioUrl: string): Promise<string[]> {
    const url = new URL('/v1/models', lmStudioUrl);
    return new Promise((resolve) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, { method: 'GET', timeout: 5000 }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    resolve((json.data || []).map((m: any) => m.id));
                }
                catch {
                    resolve([]);
                }
            });
        });
        req.on('error', () => resolve([]));
        req.on('timeout', () => { req.destroy(); resolve([]); });
        req.end();
    });
}

function pickSmallest(modelIds: string[]): string {
    if (modelIds.length === 0)
        return 'qwen3.5-0.8b';
    const sizeRegex = /(\d+\.?\d*)\s*[bB]/;
    const sorted = [...modelIds].sort((a, b) => {
        const aMatch = a.match(sizeRegex);
        const bMatch = b.match(sizeRegex);
        return (aMatch ? parseFloat(aMatch[1]) : 999) - (bMatch ? parseFloat(bMatch[1]) : 999);
    });
    return sorted[0];
}

// ─── Auto-unload: unload LLM model after idle timeout ────────────────
let autoUnloadTimeout: ReturnType<typeof setTimeout> | null = null;
let autoUnloadCallback: (() => void) | null = null;

export function unloadCurrentModel(lmStudioUrl: string): Promise<void> {
    const model = cachedModel;
    if (!model) return Promise.resolve();
    console.log(`[VoxType] Unloading LLM model: ${model}`);
    const base = new URL(lmStudioUrl);
    const url = new URL(`/api/v1/models/unload`, `${base.protocol}//${base.host}`);
    const payload = JSON.stringify({ instance_id: model });
    return new Promise((resolve) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
            method: 'POST',
            timeout: 5000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
            res.resume();
            if (res.statusCode === 200) {
                console.log(`[VoxType] LLM model unloaded: ${model}`);
            } else {
                console.log(`[VoxType] LLM unload returned ${res.statusCode}`);
            }
            resolve();
        });
        req.on('error', (e) => { console.log(`[VoxType] LLM unload failed: ${e.message}`); resolve(); });
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(payload);
        req.end();
    });
}

export function resetAutoUnloadTimer(minutes: number, lmStudioUrl: string, onUnload?: () => void): void {
    if (autoUnloadTimeout) clearTimeout(autoUnloadTimeout);
    autoUnloadTimeout = null;
    if (!minutes || minutes <= 0) return;
    autoUnloadCallback = onUnload || null;
    autoUnloadTimeout = setTimeout(async () => {
        console.log(`[VoxType] Auto-unload: ${minutes}min idle, unloading models...`);
        await unloadCurrentModel(lmStudioUrl);
        // Restart the bundled services so they free their loaded models. They
        // come back ready and reload on the next request. Use restartService
        // so VoxType keeps owning the child process.
        try {
            const services = require('./services');
            if (services.isRunning('whisper')) await services.restartService('whisper');
            if (services.isRunning('kokoro')) await services.restartService('kokoro');
        } catch (_e) { /* services module not yet loaded */ }
        if (autoUnloadCallback) autoUnloadCallback();
    }, minutes * 60 * 1000);
}

export function stopAutoUnloadTimer(): void {
    if (autoUnloadTimeout) clearTimeout(autoUnloadTimeout);
    autoUnloadTimeout = null;
}

// ─── Preload: send a dummy request to warm up the selected model ─────
export async function preloadCurrentModel(lmStudioUrl: string): Promise<void> {
    const model = cachedModel || pickSmallest(availableModels.map(m => m.id));
    if (!model) return;
    console.log(`[VoxType] Preloading model: ${model}`);
    const url = new URL('/v1/chat/completions', lmStudioUrl);
    const payload = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0,
        max_tokens: 1,
    });
    try {
        await callLLM(url, payload);
        console.log(`[VoxType] Model preloaded: ${model}`);
    } catch (e: any) {
        console.log(`[VoxType] Model preload failed (non-fatal): ${e?.message}`);
    }
}

// ─── Robust post-processing: parse structured output + sanity checks ──
function cleanLLMOutput(content: string, originalTranscript: string): string {
    let output = extractOutput(content);

    // Strip any leftover artifacts the model may have wrapped around the
    // string inside `output` (a well-behaved schema run won't produce these,
    // but grammar-constrained models sometimes still escape extra fencing).
    output = output.trim();
    output = output.replace(/^```[\s\S]*?\n/, '').replace(/\n?```$/, '');
    output = output.replace(/^["']|["']$/g, '');
    output = output.replace(/<\/?transcript>/g, '');
    output = output.trim();

    // Sanity: if model returned empty but original had real words, return original
    const stripped = originalTranscript.replace(/\b(um|uh|er|hmm|ah|oh|like|you know|I mean|basically|actually|so|well|right|okay)\b/gi, '').trim();
    if (!output && stripped.length > 0) {
        console.log('[VoxType] LLM returned empty output, using original');
        return originalTranscript.trim();
    }
    // Sanity: if response is 3x+ longer than input, model likely hallucinated
    if (output.length > originalTranscript.length * 3 && originalTranscript.length > 20) {
        console.log('[VoxType] LLM output suspiciously long, using original');
        return originalTranscript.trim();
    }
    return output;
}

/**
 * Parse the model's JSON response and return `output`. Falls back through
 * several recovery strategies so a malformed response never crashes the
 * pipeline:
 *   1. Strict JSON.parse → .output
 *   2. JSON.parse on the longest {...} substring (tolerates stray prose)
 *   3. Regex extract of "output": "..."
 *   4. Whole raw content (pre-schema behavior)
 */
function extractOutput(raw: string): string {
    if (!raw) return '';
    const text = raw.trim();

    // Fast path: clean JSON
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.output === 'string') {
            if (parsed.screen_context || parsed.cursor_focus || parsed.edit_plan) {
                console.log(
                    `[VoxType] LLM scratch — screen: ${String(parsed.screen_context ?? '').slice(0, 150)} | cursor: ${String(parsed.cursor_focus ?? '').slice(0, 120)} | plan: ${String(parsed.edit_plan ?? '').slice(0, 200)}`,
                );
            }
            return parsed.output;
        }
    } catch (_e) { /* fall through */ }

    // Second try: find the largest balanced {...} block and parse it
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (typeof parsed?.output === 'string') return parsed.output;
        } catch (_e) { /* fall through */ }
    }

    // Third try: regex extract "output": "..." (handles minor JSON breakage)
    const m = text.match(/"output"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) {
        try {
            return JSON.parse(`"${m[1]}"`);
        } catch (_e) { /* fall through */ }
    }

    // Last resort: treat the whole thing as the output
    console.log('[VoxType] Could not parse structured LLM output, using raw');
    return text;
}

// ─── Single LLM call (extracted for retry logic) ────────────────────
function callLLM(url: URL, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
            method: 'POST',
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode !== 200) {
                    reject(new Error(`LM Studio error ${res.statusCode}: ${raw}`));
                    return;
                }
                try {
                    const json = JSON.parse(raw);
                    const content = json.choices?.[0]?.message?.content || '';
                    resolve(content);
                }
                catch {
                    reject(new Error(`Failed to parse LM Studio response: ${raw}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('LM Studio request timed out'));
        });
        req.write(payload);
        req.end();
    });
}

export async function enhance(
    transcript: string,
    lmStudioUrl: string,
    screenshotJpegB64?: string | null,
): Promise<string> {
    if (!transcript.trim())
        return '';
    // Cache key includes a screenshot fingerprint so identical transcripts
    // with different screens still go through the LLM.
    const cacheKey = screenshotJpegB64
        ? `${transcript}::${screenshotJpegB64.length}:${screenshotJpegB64.slice(0, 32)}`
        : transcript;
    const cached = cacheGet(cacheKey);
    if (cached)
        return cached;
    // Ensure LM Studio is running
    const alive = await ensureLMStudio(lmStudioUrl);
    if (!alive)
        return transcript;
    // Fetch models if needed
    if (availableModels.length === 0)
        await fetchModels(lmStudioUrl);
    const model = cachedModel || pickSmallest(availableModels.map(m => m.id));
    const url = new URL('/v1/chat/completions', lmStudioUrl);
    const instruction = screenshotJpegB64
        ? `Clean this transcript using the attached screenshot as reference only. Output ONLY the cleaned text, nothing else.\n\n<transcript>${transcript}</transcript>`
        : `Clean this transcript. Output ONLY the cleaned text, nothing else.\n\n<transcript>${transcript}</transcript>`;
    const userContent: any = screenshotJpegB64
        ? [
            { type: 'text', text: instruction },
            {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${screenshotJpegB64}` },
            },
        ]
        : instruction;
    const payload = JSON.stringify({
        model,
        messages: [
            { role: 'system', content: loadSystemPrompt() },
            { role: 'user', content: userContent },
        ],
        temperature: 0,
        max_tokens: 4096,
        // Grammar-constrained JSON output. The `output` field is unbounded so
        // long transcripts fit; the scratch fields are capped to stop the
        // model from blathering and truncating the real transcript.
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'transcript_cleanup',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['screen_context', 'cursor_focus', 'edit_plan', 'output'],
                    properties: {
                        screen_context: {
                            type: 'string',
                            maxLength: 200,
                            description: 'Active app + general UI visible on the screenshot, or "none".',
                        },
                        cursor_focus: {
                            type: 'string',
                            maxLength: 150,
                            description: 'What is right at the red cursor marker, or "none".',
                        },
                        edit_plan: {
                            type: 'string',
                            maxLength: 300,
                            description: 'Terse bullets of the edits applied.',
                        },
                        output: {
                            type: 'string',
                            description: 'The final cleaned transcript. Only this field is shown to the user.',
                        },
                    },
                },
            },
        },
    });
    // Retry up to 2 times on transient failures
    const MAX_RETRIES = 2;
    let lastError: any = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (attempt > 0) {
                console.log(`[VoxType] Retry attempt ${attempt}/${MAX_RETRIES}...`);
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
            const raw = await callLLM(url, payload);
            const result = cleanLLMOutput(raw, transcript);
            cacheSet(cacheKey, result);
            return result;
        }
        catch (e: any) {
            lastError = e;
            console.log(`[VoxType] LLM call failed (attempt ${attempt + 1}):`, e?.message);
        }
    }
    // All retries exhausted — gracefully return original instead of crashing
    console.log(`[VoxType] All retries failed, returning original. Last error: ${lastError?.message}`);
    return transcript;
}
