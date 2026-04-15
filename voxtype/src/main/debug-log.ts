import fs from 'fs';
import path from 'path';
import os from 'os';

// Debug log + structured session log. Both live in ~/.voxtype/ and are
// TRUNCATED on every app start so they stay small and scoped to the current
// run (same model as telecode). The user's actual transcription history in
// history.json is untouched.

const DIR = path.join(os.homedir(), '.voxtype');
const DEBUG_FILE = path.join(DIR, 'debug.log');
const SESSIONS_FILE = path.join(DIR, 'sessions.jsonl');

let initialized = false;

function ensureDir() {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function fmt(args: unknown[]): string {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); }
            catch { return String(a); }
        })
        .join(' ');
}

/**
 * Initialize: truncate both log files and tee console output into debug.log.
 * Call once at startup before any other code that logs.
 */
export function initDebugLog(): void {
    if (initialized) return;
    initialized = true;
    try {
        ensureDir();
        // Truncate on startup — fresh log per launch.
        fs.writeFileSync(DEBUG_FILE, `=== VoxType started ${new Date().toISOString()} ===\n`, 'utf-8');
        fs.writeFileSync(SESSIONS_FILE, '', 'utf-8');
    } catch (e) {
        // If we can't write, just carry on with stdout.
        process.stderr.write(`[VoxType] debug log init failed: ${(e as Error).message}\n`);
        return;
    }

    const origLog = console.log.bind(console);
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);

    const write = (level: string, args: unknown[]) => {
        const line = `[${new Date().toISOString()}] ${level} ${fmt(args)}\n`;
        try { fs.appendFileSync(DEBUG_FILE, line, 'utf-8'); }
        catch { /* ignore — don't crash on log write */ }
    };

    console.log = (...args: unknown[]) => { origLog(...args); write('LOG', args); };
    console.warn = (...args: unknown[]) => { origWarn(...args); write('WARN', args); };
    console.error = (...args: unknown[]) => { origError(...args); write('ERR', args); };
}

export interface SessionRecord {
    ts: string;
    durationSec?: number;
    audioKB?: number;
    hadScreenshot?: boolean;
    screenshotKB?: number;
    model?: string;
    sttMs?: number;
    llmMs?: number;
    totalMs?: number;
    raw?: string;
    enhanced?: string;
    skipped?: string;
    error?: string;
}

/** Append one session record as a JSON line. Never throws. */
export function logSession(entry: SessionRecord): void {
    if (!initialized) return;
    try {
        fs.appendFileSync(SESSIONS_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
        /* ignore */
    }
}
