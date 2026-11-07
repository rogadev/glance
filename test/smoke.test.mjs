// Runs glance.mjs as a hook does (event JSON on stdin) against a throwaway
// home folder, so the state file, the log, and the painter's result are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GLANCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'glance.mjs');

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-smoke-'));
  return { dir, state: path.join(dir, '.claude', 'state', 'glance') };
}

function hook(dir, event) {
  const r = spawnSync(process.execPath, [GLANCE], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, USERPROFILE: dir, GLANCE_NO_PAINT: '1' },
    timeout: 10_000,
  });
  assert.equal(r.status, 0, `glance.mjs exited ${r.status}: ${r.stderr}`);
  return r;
}

const lastLog = (state) => fs.readFileSync(path.join(state, 'events.log'), 'utf8').trim().split('\n').pop();

// The tests turn painting off (they may run inside a Claude pane), and the log
// line still records that nothing was painted.
const PAINT_SKIPPED = /paint-skipped:disabled$/;

test('a turn writes state, logs each event, and ends by deleting the state file', (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = 'smoke-1';
  const file = path.join(state, `${sid}.json`);

  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'working');
  assert.match(lastLog(state), / smoke-1 main UserPromptSubmit -> working \[prompt\] bg=0 /);
  assert.match(lastLog(state), PAINT_SKIPPED);

  hook(dir, { hook_event_name: 'Stop', session_id: sid });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'attention');

  hook(dir, { hook_event_name: 'SessionEnd', session_id: sid });
  assert.equal(fs.existsSync(file), false);
  assert.match(lastLog(state), /SessionEnd -> reset \[session-end\]/);
});

test('GlanceReset prints the summary /glance-fix shows', (t) => {
  const { dir } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = 'smoke-2';
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi' });
  hook(dir, {
    hook_event_name: 'PostToolUse',
    session_id: sid,
    tool_name: 'Bash',
    tool_response: { backgroundTaskId: 'devserver' },
  });
  hook(dir, { hook_event_name: 'Stop', session_id: sid });
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: sid, live_agents: [] });
  const summary = JSON.parse(r.stdout.trim());
  assert.equal(summary.was, 'working [background-running]');
  assert.deepEqual(summary.dropped, ['shell devserver']);
  assert.deepEqual(summary.kept, []);
});

test('unparsable input is logged, not dropped silently', (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(state, { recursive: true });
  const r = spawnSync(process.execPath, [GLANCE], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, USERPROFILE: dir, GLANCE_NO_PAINT: '1' },
  });
  assert.equal(r.status, 0);
  assert.match(lastLog(state), /input-unparsable/);
});

test('events from the mod get a state line first, for the desktop band', (t) => {
  const { dir } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'smoke-3', prompt: 'hi', glance_via: 'mod' });
  assert.deepEqual(JSON.parse(r.stdout.split('\n')[0]), { state: 'working', color: '#1F2D3D' });
  const reset = hook(dir, { hook_event_name: 'GlanceReset', session_id: 'smoke-3', live_agents: [], glance_via: 'mod' });
  const [state, summary] = reset.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(state.state, 'attention');
  assert.equal(summary.was, 'working [prompt]');
});

// A CI runner has no terminal, so this proves the macOS and Linux painter fails
// cleanly (logged, exit 0) rather than that it paints. On Windows it would
// paint the pane running the tests, so it's skipped there.
test('without a terminal, the macOS and Linux painter logs why and carries on', { skip: process.platform === 'win32' }, (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [GLANCE], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'smoke-4' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, USERPROFILE: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // no controlling terminal, as under a CI runner
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(lastLog(state), /Stop -> attention \[stop\] bg=0 (ok|paint-failed:tty-\S+)$/);
});
