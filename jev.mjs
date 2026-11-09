/**
 * Minimal TypeSafe System One client. No dependencies — Node's fetch only.
 *
 * Key resolution, in order:
 *   1. TYPESAFE_API_KEY
 *   2. TYPESAFE_KEY_FILE  (path to a file containing the key)
 *   3. .env in the working directory (TYPESAFE_API_KEY=...)
 *
 * The key is read once per process and never leaves it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MODEL = process.env.JEV_MODEL || 'jev-1.14.0';
const ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';

let keyCache = null;

async function readMaybe(path) {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** KEY=VALUE lines; ignores comments and blank lines; strips one layer of quotes. */
async function fromDotEnv() {
  const raw = await readMaybe(join(process.cwd(), '.env'));
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || m[1].toUpperCase() !== 'TYPESAFE_API_KEY') continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  return null;
}

export async function getKey() {
  if (keyCache) return keyCache;

  const env = (process.env.TYPESAFE_API_KEY || '').trim();
  if (env) return (keyCache = env);

  const file = (process.env.TYPESAFE_KEY_FILE || '').trim();
  if (file) {
    const value = await readMaybe(file);
    if (value) return (keyCache = value);
    throw new Error(`TYPESAFE_KEY_FILE points at ${file}, which could not be read`);
  }

  const dot = await fromDotEnv();
  if (dot) return (keyCache = dot);

  throw new Error(
    'no API key — set TYPESAFE_API_KEY, add TYPESAFE_API_KEY=... to .env, or point TYPESAFE_KEY_FILE at a file',
  );
}

/** One request, one round trip. Any failure throws — callers decide the fallback. */
export async function systemOne({ state, questions, timeoutMs = 25000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await getKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: ctrl.signal,
    });

    const text = await r.text();
    if (!r.ok) {
      let message = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text);
        message = parsed.detail?.error?.message || parsed.error?.message || parsed.message || message;
      } catch {}
      throw new Error(`jev ${r.status}: ${message}`);
    }

    const json = JSON.parse(text);
    return { answers: json.answers || {}, usage: json.usage || {}, model: json.model || MODEL };
  } finally {
    clearTimeout(timer);
  }
}
