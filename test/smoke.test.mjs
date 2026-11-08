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
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: sid, live_agents: ['a1', 'a2'] });
  const summary = JSON.parse(r.stdout.trim());
  assert.equal(summary.was, 'working [background-running]');
  assert.deepEqual(summary.dropped, ['shell devserver']);
  assert.deepEqual(summary.kept, []);
  assert.equal(summary.diagnosis.verdict, 'stale-background');
  // The snapshot keeps the background work and the agent count, which the
  // report skill reads as evidence.
  const snap = JSON.parse(fs.readFileSync(summary.snapshot, 'utf8'));
  assert.deepEqual(snap.before.background, [{ id: 'devserver', kind: 'shell', started_min_ago: 0 }]);
  assert.equal(snap.live_agents, 2);
});

test('a snapshot gives a scheduled wakeup the minutes until it is due', (t) => {
  const { dir } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = 'smoke-8';
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi' });
  hook(dir, {
    hook_event_name: 'PostToolUse',
    session_id: sid,
    tool_name: 'ScheduleWakeup',
    tool_input: { prompt: 'check CI' },
    tool_response: { scheduledFor: Date.now() + 20 * 60 * 1000 },
  });
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: sid, live_agents: [] });
  const snap = JSON.parse(fs.readFileSync(JSON.parse(r.stdout.trim()).snapshot, 'utf8'));
  const wakeup = snap.before.background.find((b) => b.kind === 'wakeup');
  assert.ok(wakeup, `no wakeup in ${JSON.stringify(snap.before.background)}`);
  assert.ok(wakeup.due_in_min >= 19 && wakeup.due_in_min <= 20, `due_in_min ${wakeup.due_in_min}`);
});

test("a snapshot keeps only the session's newest 40 log lines", (t) => {
  const { dir } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = 'smoke-9';
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi' });
  for (let i = 0; i < 43; i++) hook(dir, { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash' });
  hook(dir, { hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Read' });
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: sid, live_agents: [] });
  const snap = JSON.parse(fs.readFileSync(JSON.parse(r.stdout.trim()).snapshot, 'utf8'));
  assert.equal(snap.log.length, 40);
  assert.match(snap.log[39], /PreToolUse \(Read/);
});

test('GlanceReset saves a snapshot with the diagnosis and only that session log lines', (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'other-session', prompt: 'hi' });
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'smoke-4', prompt: 'hi' });
  hook(dir, { hook_event_name: 'PreToolUse', session_id: 'smoke-4', tool_name: 'Bash' });
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: 'smoke-4', live_agents: [] });
  const summary = JSON.parse(r.stdout.trim());
  assert.equal(summary.snapshot, path.join(state, 'fix-smoke-4.json'));
  const snap = JSON.parse(fs.readFileSync(summary.snapshot, 'utf8'));
  assert.equal(snap.diagnosis.verdict, 'missed-end');
  assert.equal(snap.before.state, 'working');
  assert.equal(typeof snap.glance, 'string');
  assert.equal(snap.log.length, 2);
  assert.ok(snap.log.every((l) => l.includes(' smoke-4 ')));
  assert.ok(!JSON.stringify(snap).includes('other-se'));
});

test('a snapshot whose log could not be read says why, instead of showing an empty log', (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'smoke-5', prompt: 'hi' });
  const logFile = path.join(state, 'events.log');
  fs.rmSync(logFile);
  fs.mkdirSync(logFile);
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: 'smoke-5', live_agents: [] });
  const snap = JSON.parse(fs.readFileSync(JSON.parse(r.stdout.trim()).snapshot, 'utf8'));
  assert.deepEqual(snap.log, []);
  assert.equal(snap.log_error, 'EISDIR');
});

test('a missing log gives the snapshot an empty log and no error', (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'smoke-6', prompt: 'hi' });
  fs.rmSync(path.join(state, 'events.log'));
  // The reset's own log line lands after the snapshot reads the log.
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: 'smoke-6', live_agents: [] });
  const snap = JSON.parse(fs.readFileSync(JSON.parse(r.stdout.trim()).snapshot, 'utf8'));
  assert.deepEqual(snap.log, []);
  assert.equal(snap.log_error, undefined);
});

test('a snapshot that cannot be saved is logged, and the summary names no file', (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: 'smoke-7', prompt: 'hi' });
  fs.mkdirSync(path.join(state, 'fix-smoke-7.json'));
  const r = hook(dir, { hook_event_name: 'GlanceReset', session_id: 'smoke-7', live_agents: [] });
  assert.equal(JSON.parse(r.stdout.trim()).snapshot, '');
  assert.match(fs.readFileSync(path.join(state, 'events.log'), 'utf8'), / smoke-7 glance-fix snapshot-failed:/);
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

test('GlanceCheck reports what it found and leaves the session state alone', (t) => {
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = 'smoke-5';
  hook(dir, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'hi' });
  const file = path.join(state, `${sid}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const r = hook(dir, { hook_event_name: 'GlanceCheck', session_id: sid, surface: 'terminal' });
  const report = JSON.parse(r.stdout.trim());
  assert.equal(report.flash, 'paint-skipped:disabled');
  assert.equal(report.state, 'working [prompt]');
  assert.equal(report.surface, 'terminal');
  assert.match(report.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof report.terminal.name, 'string');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.match(lastLog(state), / smoke-5 main GlanceCheck -> working \[prompt\] flash:paint-skipped:disabled /);
});

test('UiIdle waits out the confirm window itself, then clears a pane no hook has touched since', (t) => {
  // The mod sends UiIdle the moment isWorking goes false, with idle_since set
  // to now; only the wait in main() makes it count.
  const { dir, state } = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sid = 'smoke-6';
  hook(dir, { hook_event_name: 'PreCompact', session_id: sid, trigger: 'manual' });
  hook(dir, { hook_event_name: 'UiIdle', session_id: sid, idle_since: Date.now() });
  const after = JSON.parse(fs.readFileSync(path.join(state, `${sid}.json`), 'utf8'));
  assert.equal(after.state, 'attention');
  assert.equal(after.reason, 'ui-idle');
});
