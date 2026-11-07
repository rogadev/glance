#!/usr/bin/env node
// glance: tints a Claude Code pane while Claude is working, so you can tell
// from across the room which windows need you. Runs as a Claude Code hook for
// many events; reads the hook JSON on stdin, updates a per-session state file,
// and has paint.exe write an OSC 11 escape sequence to the pane's console.
//
// Design and the event table live in README.md beside this file.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { PROMPT_KEEP, advance, allowanceMs, promptMatches, scheduleHoldsTint } from './schedule.mjs';

export const CONFIG = {
  // Background while Claude, or background work it started, is busy.
  workingColor: '#1F2D3D',
  // null resets to the Windows Terminal profile background (OSC 111).
  attentionColor: null,
  // Background work with no end signal after this long is treated as finished.
  // Shells get less time: a dev server left running would otherwise hold the tint.
  agentTtlMs: 4 * 60 * 60 * 1000,
  shellTtlMs: 60 * 60 * 1000,
  // How long Claude must look idle, with no hook since, before TitleIdle (the
  // pane title) or UiIdle (the mod's isWorking) clears the tint.
  titleIdleConfirmMs: 2500,
  // The title watcher (paint.exe --watch) polls each pane's title to catch Esc.
  // Off since the glance mod (mod/) reports Esc as TurnAborted with no polling.
  // Turn it back on for sessions that can't load the mod.
  titleWatcher: false,
  stateDir: path.join(os.homedir(), '.claude', 'state', 'glance'),
  logMaxBytes: 512 * 1024,
};

export const WORKING = 'working';
export const ATTENTION = 'attention';
export const BACKGROUND_RUNNING = 'background-running';
const COMPACT_MANUAL = 'compact-manual';

// Needs-you reasons that mean "finished", not "asking you something", so the
// engine starting work again (UiWorking) may turn the pane working.
const SETTLED = new Set(['session-start', 'stop', 'stop-failure', 'aborted', 'compact-done', 'ui-idle', 'title-idle', 'reset', 'idle_prompt']);

// Tools whose whole purpose is to wait for an answer from you.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Notification types that mean "you need to look at this pane".
const ATTENTION_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

export function emptyState() {
  return { state: ATTENTION, reason: 'init', background: {} };
}

/** Task ids in a prompt's task notifications whose status is anything but running. */
export function endedTaskIds(prompt) {
  const ids = [];
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  for (const [, body] of String(prompt || '').matchAll(re)) {
    const id = body.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/)?.[1];
    const status = body.match(/<status>\s*([^<\s]+)\s*<\/status>/)?.[1];
    if (id && status !== 'running') ids.push(id);
  }
  return ids;
}

const SCHEDULED = new Set(['wakeup', 'cron']);

/**
 * Background work that hasn't expired. Entries are { kind, at } for
 * 'agent' and 'shell', plus { dueAt, prompt } for scheduled 'wakeup' and
 * 'cron' runs (and { cron, recurring } for cron). State files written before
 * shells were tracked hold an 'agents' map of id to start time.
 */
function liveBackground(prev, now) {
  const live = {};
  const entries = Object.entries(prev.background || {});
  for (const [id, at] of Object.entries(prev.agents || {})) entries.push([id, { kind: 'agent', at }]);
  for (const [id, item] of entries) {
    if (SCHEDULED.has(item.kind)) {
      // A run that never arrived was missed: a recurring job moves on, others end.
      const live_ = now > item.dueAt + allowanceMs(item) ? advance(item, now) : item;
      if (live_) live[id] = live_;
      continue;
    }
    const ttl = item.kind === 'shell' ? CONFIG.shellTtlMs : CONFIG.agentTtlMs;
    if (now - item.at < ttl) live[id] = item;
  }
  return live;
}

/** True when any background work should keep the pane working right now. */
function holdsTint(background, now) {
  return Object.values(background).some((item) => !SCHEDULED.has(item.kind) || scheduleHoldsTint(item, now));
}

/** Records or clears scheduled runs from the tools that manage them. */
function trackSchedules(background, input, now) {
  const ti = input.tool_input || {};
  const tr = input.tool_response || {};
  const prompt = String(ti.prompt || '').trim().slice(0, PROMPT_KEEP);
  if (input.tool_name === 'ScheduleWakeup') {
    delete background.wakeup;
    if (!ti.stop && Number(tr.scheduledFor)) {
      background.wakeup = { kind: 'wakeup', at: now, dueAt: Number(tr.scheduledFor), prompt };
    }
  } else if (input.tool_name === 'CronCreate' && tr.id && Number(tr.nextFireAt)) {
    background[`cron:${tr.id}`] = {
      kind: 'cron',
      at: now,
      dueAt: Number(tr.nextFireAt),
      cron: String(ti.cron || tr.humanSchedule || ''),
      recurring: tr.recurring !== false && ti.recurring !== false,
      prompt,
      // Added by apply() from paint.exe --utc-offset; see nextCronMatch.
      offsetMin: Number.isFinite(input.utc_offset_min) ? input.utc_offset_min : undefined,
    };
  } else if (input.tool_name === 'CronDelete' && ti.id) {
    delete background[`cron:${ti.id}`];
  }
}

/**
 * Decides the next pane state from the previous state and one hook event.
 * Pure: no I/O, so every rule is covered by glance.test.mjs.
 *
 * @param {{state: string, reason: string, background: object, updatedAt?: number}} prev
 * @param {object} input The hook's stdin JSON, or a TitleIdle event from paint.exe --watch.
 * @param {number} now Epoch milliseconds.
 * @returns {{state: string, reason: string, background: object} | null}
 *   The next state, or null when the session ends.
 */
export function decide(prev, input, now) {
  const event = input.hook_event_name;
  const fromMain = !input.agent_id;
  const background = liveBackground(prev, now);
  const next = (state, reason) => ({ state, reason, background });
  const same = () => next(prev.state, prev.reason);
  const busy = () => holdsTint(background, now);
  // A manual /compact ends waiting on you. An automatic one runs inside a
  // turn, which goes on and ends with its own Stop. PostCompact and the
  // SessionStart (compact) after it both land here; the first one clears it.
  const compactDone = () => {
    if (prev.reason !== COMPACT_MANUAL) return same();
    return busy() ? next(WORKING, BACKGROUND_RUNNING) : next(ATTENTION, 'compact-done');
  };

  switch (event) {
    case 'SessionStart':
      // A new or resumed process has no background work from before.
      // Compaction keeps the process and its background work.
      if (input.source === 'compact') return compactDone();
      return { state: ATTENTION, reason: 'session-start', background: {} };

    case 'PreCompact':
      // /compact runs no turn (no UserPromptSubmit, no tools), so without this
      // the pane shows needs-you for the minute or two compaction takes.
      if (!fromMain) return same();
      return next(WORKING, input.trigger === 'manual' ? COMPACT_MANUAL : 'compact');

    case 'PostCompact':
      return compactDone();

    case 'SessionEnd':
      return null;

    case 'UserPromptSubmit':
      // Killed agents send no SubagentStop and shells send nothing at all, but
      // every way background work ends delivers a task notification as a prompt.
      for (const id of endedTaskIds(input.prompt)) delete background[id];
      // A scheduled run firing arrives as its own prompt.
      for (const [id, item] of Object.entries(background)) {
        if (!SCHEDULED.has(item.kind) || !promptMatches(item, input.prompt)) continue;
        const moved = advance(item, now);
        if (moved) background[id] = moved;
        else delete background[id];
      }
      return next(WORKING, 'prompt');

    case 'PreToolUse':
      if (!fromMain) return same();
      if (ASKING_TOOLS.has(input.tool_name)) return next(ATTENTION, 'asking');
      return next(WORKING, 'tool');

    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'ElicitationResult': {
      const shellId = input.tool_response?.backgroundTaskId;
      if (shellId) background[shellId] = { kind: 'shell', at: now };
      if (fromMain && event === 'PostToolUse') trackSchedules(background, input, now);
      // A subagent's tool finishing only clears attention that subagent caused,
      // never a question the main thread is waiting on.
      if (fromMain || prev.reason === 'subagent-permission') return next(WORKING, 'tool-done');
      return same();
    }

    case 'PermissionRequest':
      return next(ATTENTION, fromMain ? 'permission' : 'subagent-permission');

    case 'Elicitation':
      return next(ATTENTION, 'elicitation');

    case 'Notification':
      if (!ATTENTION_NOTIFICATIONS.has(input.notification_type)) return same();
      // Idle while background work runs is not "needs you".
      if (input.notification_type === 'idle_prompt' && busy()) return next(WORKING, BACKGROUND_RUNNING);
      return next(ATTENTION, input.notification_type);

    case 'SubagentStart':
      if (input.agent_id) background[input.agent_id] = { kind: 'agent', at: now };
      return same();

    case 'SubagentStop':
      if (input.agent_id) delete background[input.agent_id];
      return same();

    case 'Stop':
      if (!fromMain) return same();
      return busy() ? next(WORKING, BACKGROUND_RUNNING) : next(ATTENTION, 'stop');

    case 'StopFailure':
      return next(ATTENTION, 'stop-failure');

    case 'TurnAborted':
      // From the glance mod (mod/hooks/register.ts): you pressed Esc. No settings
      // hook fires for that, so without the mod this case is TitleIdle's job.
      return busy() ? next(WORKING, BACKGROUND_RUNNING) : next(ATTENTION, 'aborted');

    case 'GlanceReset': {
      // From the mod's /glance-fix: the pane shows working but you can see it
      // isn't. Keep only agents the engine still lists as running
      // (input.live_agents). Shells and scheduled runs can't be checked from
      // here, so they go: a stale one is what holds a stuck tint, and dropping a
      // live one errs toward needs-you.
      const live = new Set(Array.isArray(input.live_agents) ? input.live_agents.map(String) : []);
      const kept = {};
      for (const [id, item] of Object.entries(background)) {
        if (item.kind === 'agent' && live.has(id)) kept[id] = item;
      }
      return { state: ATTENTION, reason: 'reset', background: kept };
    }

    case 'UiWorking':
      // From the mod: the engine has been working for a moment (isWorking).
      // This is how bash mode (! command) shows working: it sends no prompt or
      // tool hook. Only a pane that's idle because something finished turns
      // working; one waiting on a question or a prompt stays as it is.
      if (prev.state === WORKING || !SETTLED.has(prev.reason)) return same();
      return next(WORKING, 'ui-working');

    case 'TitleIdle':
    case 'UiIdle': {
      // TitleIdle comes from paint.exe --watch (the pane title shows Claude
      // idle); UiIdle from the mod (the engine's isWorking went false). Either
      // catches an end no hook reports: an Esc, or a /compact cancelled with Esc,
      // which sends no PostCompact. It only ever clears the tint, and only when
      // Claude has looked idle for a while with no hook since.
      if (prev.state !== WORKING || busy()) return same();
      const quietSince = Math.max(Number(input.idle_since) || now, prev.updatedAt || 0);
      if (now - quietSince < CONFIG.titleIdleConfirmMs) return same();
      return next(ATTENTION, event === 'UiIdle' ? 'ui-idle' : 'title-idle');
    }

    default:
      return same();
  }
}

/** The OSC body for a state, without the ESC ] prefix and BEL terminator. */
export function osc(state) {
  const color = state === WORKING ? CONFIG.workingColor : CONFIG.attentionColor;
  return color ? `11;${color}` : '111';
}

const PAINT_EXE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'paint.exe');
const PAINT_ERRORS = { 2: 'bad-args', 3: 'no-claude-ancestor', 4: 'attach-failed', 5: 'open-failed', 6: 'write-failed' };

/**
 * Paints the pane: paint.exe on Windows, the pane's terminal device on macOS
 * and Linux. Returns 'ok' or a reason for the log.
 */
function paint(body) {
  // Tests set GLANCE_NO_PAINT so they never repaint the pane they run in.
  if (process.env.GLANCE_NO_PAINT) return 'paint-skipped:disabled';
  if (process.platform === 'win32') return paintConsole(body);
  if (process.platform === 'darwin' || process.platform === 'linux') return paintTty(body);
  return `paint-skipped:${process.platform}`;
}

/**
 * Finds the terminal device of the nearest ancestor of `pid` that has one, from
 * `ps -A -o pid=,ppid=,tty=` output. Claude Code holds the pane's terminal even
 * when a hook it starts has none of its own. Pure, for the tests.
 *
 * @param {string} psOutput Lines of "pid ppid tty"; tty is '??' or '?' for none.
 * @param {number} pid The process to start from (its own tty is not checked).
 * @returns {string | null} For example '/dev/ttys003' or '/dev/pts/2'.
 */
export function ancestorTtyFrom(psOutput, pid) {
  const procs = new Map();
  for (const line of String(psOutput).split('\n')) {
    const [p, pp, tty] = line.trim().split(/\s+/);
    if (p && pp) procs.set(Number(p), { ppid: Number(pp), tty });
  }
  const seen = new Set([pid]);
  let cur = procs.get(pid)?.ppid;
  for (let depth = 0; cur && !seen.has(cur) && depth < 16; depth++) {
    seen.add(cur);
    const proc = procs.get(cur);
    if (!proc) return null;
    if (proc.tty && !/^\?+$/.test(proc.tty) && proc.tty !== '-') return `/dev/${proc.tty}`;
    cur = proc.ppid;
  }
  return null;
}

/**
 * macOS and Linux: writes ESC ] <body> BEL to the pane's terminal device. A
 * hook that shares Claude's controlling terminal reaches it as /dev/tty;
 * otherwise the nearest ancestor with a terminal (Claude) names the device.
 */
function paintTty(body) {
  const seq = `\x1b]${body}\x07`;
  const write = (dev) => {
    const fd = fs.openSync(dev, 'w');
    try {
      fs.writeSync(fd, seq);
    } finally {
      fs.closeSync(fd);
    }
  };
  let first;
  try {
    write('/dev/tty');
    return 'ok';
  } catch (err) {
    first = err.code || err.message;
  }
  // Only runs ps (about 20 ms) when the hook has no terminal of its own.
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,tty='], { encoding: 'utf8', timeout: 2000 });
  const dev = ps.status === 0 ? ancestorTtyFrom(ps.stdout, process.pid) : null;
  if (!dev) return `paint-failed:tty-${first},no-ancestor-tty`;
  try {
    write(dev);
    return 'ok';
  } catch (err) {
    return `paint-failed:tty-${first},${dev}-${err.code || err.message}`;
  }
}

/**
 * Windows. Claude Code starts hooks with their own hidden console, so writing
 * to this process's console reaches nothing; paint.exe attaches to the
 * claude.exe ancestor's console (the visible pane) instead. See paint.cs.
 */
function paintConsole(body) {
  // The watcher runs glance.mjs outside Claude's process tree, so it passes the pid.
  const args = process.env.GLANCE_CLAUDE_PID ? [body, process.env.GLANCE_CLAUDE_PID] : [body];
  const r = spawnSync(PAINT_EXE, args, { stdio: 'ignore', timeout: 2000, windowsHide: true });
  if (r.error) return `paint-failed:${r.error.code || r.error.message}`;
  if (r.status !== 0) return `paint-failed:${PAINT_ERRORS[r.status] || r.status}`;
  return 'ok';
}

/**
 * Starts this session's title watcher (paint.exe --watch) unless one is running.
 * Hooks can't see an Esc interrupt; the watcher sees it in the pane title.
 * Returns a short status for the log, or '' when nothing was done.
 */
function ensureWatcher(input, stateFile) {
  if (!CONFIG.titleWatcher || process.platform !== 'win32') return '';
  if (['TitleIdle', 'UiIdle', 'UiWorking', 'TurnAborted', 'GlanceReset', 'SessionEnd'].includes(input.hook_event_name)) return '';
  const watchFile = stateFile.replace(/\.json$/, '.watch');
  try {
    process.kill(Number(fs.readFileSync(watchFile, 'utf8')), 0);
    return '';
  } catch {
    // No watcher yet, or it exited.
  }
  const found = spawnSync(PAINT_EXE, ['--pid'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
  const claudePid = Number(found.stdout);
  if (found.status !== 0 || !claudePid) return 'watch-failed:no-claude-pid';
  const self = fileURLToPath(import.meta.url);
  const child = spawn(PAINT_EXE, ['--watch', String(claudePid), String(input.session_id), stateFile, process.execPath, self], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(watchFile, String(child.pid));
  return `watch-started:${child.pid}`;
}

function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
}

function readState(file) {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return emptyState();
  }
}

function log(line) {
  const file = path.join(CONFIG.stateDir, 'events.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > CONFIG.logMaxBytes) {
      fs.renameSync(file, file + '.1');
    }
    fs.appendFileSync(file, line + '\n');
  } catch {
    // Logging must never break the hook.
  }
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    log(`${new Date().toISOString()} input-unreadable ${err.code || err.message}`);
    return;
  }
  // paint.exe --watch writes stdin through .NET, which can prefix a UTF-8 byte-order mark.
  const BOM = String.fromCharCode(0xfeff);
  if (raw.startsWith(BOM)) raw = raw.slice(1);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    const head = [...raw.slice(0, 12)].map((ch) => ch.charCodeAt(0).toString(16)).join(' ');
    log(`${new Date().toISOString()} input-unparsable (${raw.length} chars, starts ${head})`);
    return;
  }

  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  if (process.env.GLANCE_DEBUG || fs.existsSync(path.join(CONFIG.stateDir, 'debug'))) {
    fs.appendFileSync(path.join(CONFIG.stateDir, 'debug.jsonl'), raw.trim() + '\n');
  }
  const stateFile = path.join(CONFIG.stateDir, safeId(input.session_id) + '.json');
  // Hooks for one session can run at the same moment (for example SubagentStart
  // and the Agent tool's PostToolUse), so read, decide, write, and paint under a
  // lock. That keeps the state file and the pane color in event order.
  // UiIdle arrives the moment the engine stops working. Wait out the confirm
  // window first, so decide() sees any hook that lands meanwhile (a new prompt,
  // the next tool) and leaves the tint alone.
  if (input.hook_event_name === 'UiIdle') sleep(CONFIG.titleIdleConfirmMs + 100);
  withLock(stateFile + '.lock', () => apply(input, stateFile));
  if (input.hook_event_name === 'SessionStart') pruneOldStates();
}

// Sessions that crash never send SessionEnd; drop their state after a week.
function pruneOldStates() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(CONFIG.stateDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(CONFIG.stateDir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {}
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(lockDir, fn) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch {
      // A lock older than a few seconds belongs to a hook that died.
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 3000) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) break; // Paint anyway rather than drop the event.
      sleep(10);
    }
  }
  try {
    fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function apply(input, stateFile) {
  const now = Date.now();
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'CronCreate') {
    const r = spawnSync(PAINT_EXE, ['--utc-offset'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
    if (r.status === 0 && /^-?\d+$/.test(r.stdout.trim())) input = { ...input, utc_offset_min: Number(r.stdout.trim()) };
  }
  const prev = readState(stateFile);
  const next = decide(prev, input, now);

  const detail = [input.tool_name, input.notification_type, input.source, input.agent_type, input.glance_via && `via:${input.glance_via}`]
    .filter(Boolean)
    .join(' ');
  const who = input.agent_id ? `agent:${String(input.agent_id).slice(0, 8)}` : 'main';
  const sid = String(input.session_id || '').slice(0, 8);

  const written = paint(osc(next ? next.state : ATTENTION));

  let watch = '';
  if (next) {
    fs.writeFileSync(stateFile, JSON.stringify({ ...next, updatedAt: now }));
    try {
      watch = ensureWatcher(input, stateFile);
    } catch (err) {
      watch = `watch-failed:${err.code || err.message}`;
    }
  } else {
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(stateFile.replace(/\.json$/, '.watch'), { force: true });
  }

  // The mod reads this to draw the desktop band (hooks/register.tsx). Settings
  // hooks and the watcher don't send glance_via, and their stdout stays empty.
  if (input.glance_via === 'mod') {
    process.stdout.write(JSON.stringify({ state: next ? next.state : ATTENTION, color: CONFIG.workingColor }) + '\n');
  }

  if (input.hook_event_name === 'GlanceReset') {
    // The mod prints this as the command's output.
    const before = liveBackground(prev, now);
    const dropped = Object.keys(before).filter((id) => !next.background[id]);
    const kept = Object.keys(next.background);
    process.stdout.write(
      JSON.stringify({
        was: `${prev.state} [${prev.reason}]`,
        dropped: dropped.map((id) => `${before[id].kind} ${id}`),
        kept: kept.map((id) => `agent ${id}`),
        paint: written,
      }) + '\n',
    );
  }

  const bgCount = next ? Object.keys(next.background).length : 0;
  log(
    `${new Date(now).toISOString()} ${sid} ${who} ${input.hook_event_name}` +
      `${detail ? ` (${detail})` : ''} -> ${next ? next.state : 'reset'} [${next ? next.reason : 'session-end'}]` +
      ` bg=${bgCount} ${written}${watch ? ' ' + watch : ''}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
