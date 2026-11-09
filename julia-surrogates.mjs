/**
 * Bridge to TimeseriesSurrogates.jl.
 *
 * One Julia process per call, spawned with the project that pins the package.
 * Julia startup costs ~8 s; a single call generates every surrogate at once, so a
 * run pays it once. Any failure throws and the caller falls back to the built-in
 * phase-randomiser, so the app keeps working on a machine without Julia.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export async function juliaSurrogates(returns, { count = 1, method = 'aaft', seed = 7, block = 8 } = {}) {
  const payload = JSON.stringify({ returns, count, method, seed, block });

  return await new Promise((resolve, reject) => {
    const child = spawn('julia', ['--project=julia', 'surrogates.jl'], {
      cwd: HERE,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done(reject, new Error('julia timed out after 120 s'));
    }, 120000);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => done(reject, err));
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = (stderr.split('\n').find((l) => l.trim() && !l.startsWith('   ')) || `exit ${code}`).trim();
        return done(reject, new Error(detail.slice(0, 160)));
      }
      try {
        done(resolve, JSON.parse(stdout));
      } catch {
        done(reject, new Error('julia returned something that is not JSON'));
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}
