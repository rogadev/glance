// Paints for real, end to end, without touching the terminal the tests run in:
// on macOS and Linux into a pseudo-terminal (test/pty_run.py), and on Windows
// into a hidden console of its own. The smoke tests turn painting off; these
// prove the color code reaches a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../glance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLANCE = path.join(HERE, '..', 'glance.mjs');
const WORKING_SEQ = `\x1b]11;${CONFIG.workingColor}\x07`;
const RESET_SEQ = '\x1b]111\x07';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-term-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, log: path.join(dir, '.claude', 'state', 'glance', 'events.log') };
}

// The tests must paint, so the switch that turns painting off is dropped.
function env(dir, extra = {}) {
  const e = { ...process.env, HOME: dir, USERPROFILE: dir, ...extra };
  delete e.GLANCE_NO_PAINT;
  return e;
}

const lastLog = (log) => fs.readFileSync(log, 'utf8').trim().split('\n').pop();

// Locally a missing python3 skips the pty tests; in CI it fails them, so they
// can't pass by never running.
const hasPython = spawnSync('python3', ['--version']).status === 0;
const skipPty = process.platform === 'win32' ? 'macOS and Linux only' : !hasPython && !process.env.CI && 'needs python3';

/** Runs one event through glance.mjs inside a pty and returns what the terminal received. */
function inPty(dir, mode, event) {
  const file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify(event));
  const r = spawnSync('python3', [path.join(HERE, 'pty_run.py'), mode, process.execPath, GLANCE, file], {
    encoding: 'utf8',
    env: env(dir),
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `pty_run.py exited ${r.status}: ${r.stderr}`);
  return Buffer.from(r.stdout.trim(), 'hex').toString('latin1');
}

for (const mode of ['direct', 'detached']) {
  test(`macOS and Linux: the tint reaches the terminal (${mode})`, { skip: skipPty }, (t) => {
    const { dir, log } = home(t);
    const sid = `term-${mode}`;
    const working = inPty(dir, mode, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi' });
    assert.ok(working.includes(WORKING_SEQ), `terminal got ${JSON.stringify(working)}`);
    assert.match(lastLog(log), /-> working \[prompt\] bg=0 ok$/);

    const reset = inPty(dir, mode, { hook_event_name: 'Stop', session_id: sid });
    assert.ok(reset.includes(RESET_SEQ), `terminal got ${JSON.stringify(reset)}`);
    assert.match(lastLog(log), /-> attention \[stop\] bg=0 ok$/);
  });
}

test('Windows: paint.exe attaches to a console and paints it', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  const { dir, log } = home(t);
  // A console process of its own stands in for claude.exe. Start-Process gives
  // it a new console with its window hidden. (Node's detached starts a process
  // with no console at all, which paint.exe can't attach to.)
  const started = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "(Start-Process cmd.exe -ArgumentList '/d','/k' -WindowStyle Hidden -PassThru).Id"],
    { encoding: 'utf8', timeout: 20_000 },
  );
  const hostPid = Number(started.stdout.trim());
  assert.ok(hostPid > 0, `could not start a console: ${started.stderr}`);
  t.after(() => {
    try {
      process.kill(hostPid);
    } catch {
      // Already gone.
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const run = (event) =>
    spawnSync(process.execPath, [GLANCE], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: env(dir, { GLANCE_CLAUDE_PID: String(hostPid) }),
      timeout: 10_000,
    });
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: 'term-win', prompt: 'hi' }).status, 0);
  assert.match(lastLog(log), /-> working \[prompt\] bg=0 ok$/);
  assert.equal(run({ hook_event_name: 'Stop', session_id: 'term-win' }).status, 0);
  assert.match(lastLog(log), /-> attention \[stop\] bg=0 ok$/);
});
