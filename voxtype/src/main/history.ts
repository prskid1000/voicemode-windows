import fs from 'fs';
import path from 'path';
import os from 'os';

interface HistoryEntry {
  timestamp: string;
  raw: string;
  enhanced: string;
}

const MAX_ENTRIES = 20;
const HISTORY_DIR = path.join(os.homedir(), '.voxtype');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function load(): HistoryEntry[] {
  try {
    ensureDir();
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function save(entries: HistoryEntry[]) {
  ensureDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

export function addEntry(raw: string, enhanced: string) {
  const entries = load();
  entries.unshift({
    timestamp: new Date().toISOString(),
    raw,
    enhanced,
  });
  // Keep only last N
  save(entries.slice(0, MAX_ENTRIES));
}

export function getEntries(): HistoryEntry[] {
  return load();
}

export function clearHistory() {
  save([]);
}
