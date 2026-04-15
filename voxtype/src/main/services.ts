import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execFileP = promisify(execFile);

// ─── Service definitions ────────────────────────────────────────────
// VoxType owns these as child processes — no scheduled tasks, no .bat
// wrappers, no manual starts. Mirrors telecode's Popen pattern but in Node.

export type ServiceName = 'whisper' | 'kokoro';
export type DeviceMode = 'gpu' | 'cpu';

export interface WhisperConfig {
    model: string;
    port: number;
    device: DeviceMode;
}

export interface KokoroConfig {
    port: number;
    device: DeviceMode;
}

export interface ServiceStatus {
    name: ServiceName;
    pid: number | null;
    running: boolean;
    ready: boolean;
    lastError?: string;
}

interface Managed {
    proc: ChildProcess | null;
    config: WhisperConfig | KokoroConfig;
    ready: boolean;
    lastError?: string;
    healthUrl: string;
    // True when stop() was called intentionally — suppresses auto-restart.
    stopping: boolean;
    // Restart-on-crash backoff state
    restartCount: number;
    restartTimer: ReturnType<typeof setTimeout> | null;
}

const INSTALL_DIR = path.join(os.homedir(), '.voicemode-windows');
const STT_VENV = path.join(INSTALL_DIR, 'stt-venv');
const TTS_VENV = path.join(INSTALL_DIR, 'tts-venv');
const KOKORO_REPO = path.join(INSTALL_DIR, 'Kokoro-FastAPI');

const services: Partial<Record<ServiceName, Managed>> = {};
const statusListeners: Array<(s: ServiceStatus) => void> = [];

export function onStatusChange(fn: (s: ServiceStatus) => void): void {
    statusListeners.push(fn);
}

function notify(name: ServiceName) {
    const m = services[name];
    if (!m) return;
    const s: ServiceStatus = {
        name,
        pid: m.proc?.pid ?? null,
        running: !!m.proc && m.proc.exitCode === null,
        ready: m.ready,
        lastError: m.lastError,
    };
    for (const fn of statusListeners) {
        try { fn(s); } catch { /* ignore */ }
    }
}

// ─── Spawn helpers ───────────────────────────────────────────────────

function whisperExe(): string {
    return path.join(STT_VENV, 'Scripts', 'faster-whisper-server.exe');
}

function uvicornExe(): string {
    return path.join(TTS_VENV, 'Scripts', 'uvicorn.exe');
}

function spawnWhisper(cfg: WhisperConfig): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (cfg.device === 'cpu') env.CUDA_VISIBLE_DEVICES = '-1';
    const args = [cfg.model, '--host', '127.0.0.1', '--port', String(cfg.port)];
    return spawn(whisperExe(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
    });
}

function spawnKokoro(cfg: KokoroConfig): ChildProcess {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUTF8: '1',
        USE_GPU: cfg.device === 'gpu' ? 'true' : 'false',
        USE_ONNX: 'false',
        PROJECT_ROOT: KOKORO_REPO,
        PYTHONPATH: `${KOKORO_REPO};${path.join(KOKORO_REPO, 'api')}`,
        MODEL_DIR: 'src/models',
        VOICES_DIR: 'src/voices/v1_0',
        WEB_PLAYER_PATH: path.join(KOKORO_REPO, 'web'),
    };
    const args = ['api.src.main:app', '--host', '127.0.0.1', '--port', String(cfg.port)];
    return spawn(uvicornExe(), args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: KOKORO_REPO,
        env,
    });
}

// ─── Healthcheck ────────────────────────────────────────────────────

function pingOnce(url: string, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode !== undefined && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function waitReady(name: ServiceName, url: string, totalTimeoutMs = 60_000): Promise<boolean> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < totalTimeoutMs) {
        attempt++;
        const ok = await pingOnce(url);
        if (ok) {
            console.log(`[VoxType] ${name} ready after ${Date.now() - start}ms (${attempt} attempts)`);
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`[VoxType] ${name} did not become ready in ${totalTimeoutMs}ms`);
    return false;
}

// ─── Lifecycle: start ────────────────────────────────────────────────

function attach(m: Managed, name: ServiceName) {
    const proc = m.proc!;
    proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trimEnd();
        if (text) console.log(`[${name}] ${text}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trimEnd();
        if (text) console.log(`[${name}] ${text}`);
    });
    proc.on('exit', (code, signal) => {
        console.log(`[VoxType] ${name} exited (code=${code}, signal=${signal})`);
        m.ready = false;
        m.proc = null;
        notify(name);
        if (m.stopping) {
            m.stopping = false;
            return;
        }
        // Auto-restart on crash with exponential backoff (1s, 2s, 4s, capped at 30s)
        m.restartCount++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(m.restartCount, 5));
        console.log(`[VoxType] ${name} crashed — restart #${m.restartCount} in ${delay}ms`);
        m.restartTimer = setTimeout(() => {
            m.restartTimer = null;
            startInternal(name, m).catch((e) => {
                console.error(`[VoxType] ${name} restart failed:`, e);
            });
        }, delay);
    });
}

async function startInternal(name: ServiceName, m: Managed): Promise<void> {
    // Sanity-check binary exists before spawning — gives a much clearer error.
    const exe = name === 'whisper' ? whisperExe() : uvicornExe();
    if (!fs.existsSync(exe)) {
        m.lastError = `executable missing: ${exe}`;
        console.error(`[VoxType] ${name} not installed (${exe} missing) — skipping start`);
        notify(name);
        return;
    }
    if (name === 'kokoro' && !fs.existsSync(KOKORO_REPO)) {
        m.lastError = `Kokoro repo missing: ${KOKORO_REPO}`;
        console.error(`[VoxType] kokoro repo missing (${KOKORO_REPO}) — skipping start`);
        notify(name);
        return;
    }

    console.log(`[VoxType] Starting ${name}...`);
    m.proc =
        name === 'whisper'
            ? spawnWhisper(m.config as WhisperConfig)
            : spawnKokoro(m.config as KokoroConfig);
    m.ready = false;
    m.lastError = undefined;
    attach(m, name);
    notify(name);
    console.log(`[VoxType] ${name} spawned (PID ${m.proc.pid})`);

    const ready = await waitReady(name, m.healthUrl);
    m.ready = ready;
    if (!ready) m.lastError = 'service did not become ready';
    notify(name);
}

export async function startWhisper(cfg: WhisperConfig): Promise<void> {
    const existing = services.whisper;
    if (existing?.proc) {
        console.log('[VoxType] whisper already running');
        return;
    }
    const m: Managed = existing ?? {
        proc: null,
        config: cfg,
        ready: false,
        healthUrl: `http://127.0.0.1:${cfg.port}/health`,
        stopping: false,
        restartCount: 0,
        restartTimer: null,
    };
    m.config = cfg;
    m.healthUrl = `http://127.0.0.1:${cfg.port}/health`;
    services.whisper = m;
    await startInternal('whisper', m);
}

export async function startKokoro(cfg: KokoroConfig): Promise<void> {
    const existing = services.kokoro;
    if (existing?.proc) {
        console.log('[VoxType] kokoro already running');
        return;
    }
    const m: Managed = existing ?? {
        proc: null,
        config: cfg,
        ready: false,
        healthUrl: `http://127.0.0.1:${cfg.port}/health`,
        stopping: false,
        restartCount: 0,
        restartTimer: null,
    };
    m.config = cfg;
    m.healthUrl = `http://127.0.0.1:${cfg.port}/health`;
    services.kokoro = m;
    await startInternal('kokoro', m);
}

// ─── Lifecycle: stop ─────────────────────────────────────────────────

async function killTree(pid: number, force: boolean): Promise<void> {
    // taskkill /T kills the process + all descendants. /F is forceful.
    // uvicorn / faster-whisper-server may have child workers; /T cleans them up.
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    try {
        await execFileP('taskkill.exe', args, { timeout: 5000 });
    } catch {
        /* process may have already exited */
    }
}

async function waitExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null) return true;
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        proc.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
}

export async function stopService(name: ServiceName): Promise<void> {
    const m = services[name];
    if (!m) return;
    if (m.restartTimer) {
        clearTimeout(m.restartTimer);
        m.restartTimer = null;
    }
    m.stopping = true;
    m.restartCount = 0;
    if (!m.proc || m.proc.exitCode !== null) {
        m.proc = null;
        m.ready = false;
        notify(name);
        return;
    }
    const pid = m.proc.pid!;
    console.log(`[VoxType] Stopping ${name} (PID ${pid})...`);
    // Graceful first
    await killTree(pid, false);
    const exited = await waitExit(m.proc, 3000);
    if (!exited) {
        console.log(`[VoxType] ${name} did not exit gracefully — forceful kill`);
        await killTree(pid, true);
        await waitExit(m.proc, 2000);
    }
    m.proc = null;
    m.ready = false;
    notify(name);
}

export async function restartService(
    name: ServiceName,
    newCfg?: WhisperConfig | KokoroConfig,
): Promise<void> {
    const m = services[name];
    if (newCfg && m) m.config = newCfg;
    await stopService(name);
    if (name === 'whisper') {
        await startWhisper((m?.config ?? newCfg) as WhisperConfig);
    } else {
        await startKokoro((m?.config ?? newCfg) as KokoroConfig);
    }
}

export async function stopAll(): Promise<void> {
    await Promise.all(
        (Object.keys(services) as ServiceName[]).map((n) => stopService(n)),
    );
}

// ─── Status ──────────────────────────────────────────────────────────

export function getStatus(name: ServiceName): ServiceStatus {
    const m = services[name];
    return {
        name,
        pid: m?.proc?.pid ?? null,
        running: !!m?.proc && m.proc.exitCode === null,
        ready: !!m?.ready,
        lastError: m?.lastError,
    };
}

export function isRunning(name: ServiceName): boolean {
    const m = services[name];
    return !!m?.proc && m.proc.exitCode === null;
}
