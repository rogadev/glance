// Live harness: runs a real, interactive Claude Code session in its own
// (minimized) console window, types into it without taking focus, and checks
// what glance logged. It answers what no unit test can: which events Claude
// Code actually sends for keys you press (Esc mid-compact, bash mode, and so on).
//
// Windows only, local only: it signs in as you and spends a few cents of
// tokens per scenario, so CI doesn't run it. The window paints like any pane.
//
//   node test/live/run.mjs              Run every scenario.
//   node test/live/run.mjs compact-esc  Run one.
//
// Uses the glance this folder installs (CLAUDE_CODE_PLUGIN_DIRS on the
// maintainer's machine) and the real log, ~/.claude/state/glance/events.log;
// each scenario's lines are picked out by its own session id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(os.homedir(), '.claude', 'state', 'glance', 'events.log');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each step is [what, ...args]. 'say' types a prompt and presses Enter; 'type'
// and 'key' type without Enter; 'until' waits for a log line; 'expect' fails
// the scenario unless a line shows up in time; 'watch' only records.
const SCENARIOS = {
  'esc-turn': {
    about: 'Esc during a normal turn turns the pane back to needs-you',
    steps: [
      ['say', 'Count from 1 to 300, one number per line, nothing else.'],
      ['until', /UserPromptSubmit .*-> working/, 30_000],
      ['pause', 2000],
      ['key', '{ESC}'],
      ['expect', /(TurnAborted|UiIdle) .*-> attention/, 10_000],
    ],
  },
  'compact-esc': {
    about: 'a /compact cancelled with Esc turns the pane back to needs-you',
    steps: [
      ['say', 'Reply with just the word hi.'],
      ['until', /Stop .*-> attention/, 60_000],
      ['say', '/compact'],
      ['until', /PreCompact .*-> working/, 20_000],
      ['pause', 3000],
      ['key', '{ESC}'],
      ['expect', /-> attention \[(ui-idle|compact-done)\]/, 15_000],
    ],
  },
  'check': {
    about: '/glance-check paints this window and puts it back',
    steps: [
      ['say', '/glance-check'],
      ['expect', /GlanceCheck -> attention \[session-start\] flash:ok restore:ok/, 20_000],
    ],
  },
  'bash-mode': {
    about: 'a bash-mode command (! sleep 20), which sends no hook, shows working, then needs-you',
    steps: [
      ['type', '!'],
      ['pause', 500],
      ['say', 'sleep 20'],
      ['expect', /UiWorking .*-> working \[ui-working\]/, 10_000],
      ['expect', /-> attention \[(stop|ui-idle)\]/, 40_000],
    ],
  },
};

function build() {
  const exe = path.join(os.tmpdir(), 'glance-live-console.exe');
  const r = spawnSync(CSC, ['-nologo', '-platform:x64', `-out:${exe}`, path.join(HERE, 'console.cs')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`console.cs did not build: ${r.stdout}${r.stderr}`);
  return exe;
}

/** Starts claude in a new minimized console and returns its pid. */
function start(cwd, sessionId) {
  // A clean environment: a Claude Code session started from inside another
  // inherits markers (CLAUDECODE, CLAUDE_CODE_*) that change its behaviour.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE(CODE|_CODE_)/.test(k)));
  const ps = `(Start-Process claude.exe -ArgumentList '--session-id','${sessionId}' -WorkingDirectory '${cwd}' -WindowStyle Minimized -PassThru).Id`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env });
  const pid = Number(r.stdout.trim());
  if (!pid) throw new Error(`claude did not start: ${r.stderr}`);
  return pid;
}

function linesFor(sessionId) {
  const sid = sessionId.slice(0, 8);
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(` ${sid} `));
  } catch {
    return [];
  }
}

async function runScenario(name, exe) {
  const { about, steps } = SCENARIOS[name];
  const sessionId = crypto.randomUUID();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-live-'));
  const screenFile = path.join(cwd, '..', `glance-live-${sessionId.slice(0, 8)}.txt`);
  const send = (text) => spawnSync(exe, [String(pid), 'send', text]).status === 0;
  const screen = () => {
    spawnSync(exe, [String(pid), 'screen', screenFile]);
    try {
      return fs.readFileSync(screenFile, 'utf8');
    } catch {
      return '';
    }
  };
  // Dialogs a fresh folder or account can show before the prompt is free.
  const clearDialogs = async () => {
    for (let i = 0; i < 5; i++) {
      const s = screen();
      if (/trust this folder/i.test(s)) send('{DOWN}{ENTER}');
      else if (/Not now/.test(s) && /Enter to confirm/.test(s)) send('{DOWN}{ENTER}');
      else return;
      await sleep(1500);
    }
  };
  const waitFor = async (re, ms) => {
    const end = Date.now() + ms;
    const seen = linesFor(sessionId).length;
    while (Date.now() < end) {
      if (linesFor(sessionId).slice(seen).some((l) => re.test(l))) return true;
      await sleep(250);
    }
    return false;
  };

  console.log(`\n== ${name}: ${about}`);
  const pid = start(cwd, sessionId);
  let failed = '';
  // What the window showed when a step failed, so the report says why.
  let lastScreen = '';
  try {
    if (!(await waitFor(/SessionStart/, 30_000))) await clearDialogs();
    await sleep(2000);
    await clearDialogs();
    for (const [what, arg, ms] of steps) {
      if (what === 'say') {
        send(arg);
        await sleep(800);
        send('{ENTER}');
      } else if (what === 'type') send(arg);
      else if (what === 'key') send(arg);
      else if (what === 'pause') await sleep(arg);
      else if (what === 'watch') await sleep(arg);
      else if (what === 'until' || what === 'expect') {
        const ok = await waitFor(arg, ms);
        await clearDialogs();
        // A missed 'until' means the scenario can't go on either.
        if (!ok) {
          failed = `no line matching ${arg} within ${ms / 1000} s`;
          lastScreen = screen();
          break;
        }
      }
    }
  } finally {
    send('{ESC}{ESC}');
    await sleep(500);
    send('/exit');
    await sleep(500);
    send('{ENTER}');
    await sleep(3000);
    try {
      process.kill(pid);
    } catch {
      // Exited on its own.
    }
    // Claude Code keeps each session's transcript in a folder named after its
    // working directory (every character but letters and digits as '-').
    const transcripts = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    // A command the session started (sleep) can hold the folder a moment longer.
    for (const p of [cwd, screenFile, transcripts]) {
      try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
      } catch (err) {
        console.log(`   (left ${p}: ${err.code})`);
      }
    }
  }
  for (const l of linesFor(sessionId)) console.log(`   ${l}`);
  if (failed) {
    const shown = lastScreen.split('\n').filter((l) => l.trim()).slice(-15);
    console.log('   Screen at the failure:');
    for (const l of shown.length ? shown : ['(the window was already gone)']) console.log(`   | ${l}`);
  }
  console.log(failed ? `FAIL ${name}: ${failed}` : `PASS ${name}`);
  return !failed;
}

if (process.platform !== 'win32') {
  console.error('The live harness drives Windows consoles; run it on Windows.');
  process.exit(2);
}
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
const unknown = names.filter((n) => !SCENARIOS[n]);
if (unknown.length) {
  console.error(`Unknown scenario: ${unknown.join(', ')}. Known: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}
const exe = build();
let ok = true;
for (const n of names) ok = (await runScenario(n, exe)) && ok;
process.exit(ok ? 0 : 1);
