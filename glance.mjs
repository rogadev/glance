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
import { PROMPT_KEEP, SCHEDULE_HORIZON_MS, advance, allowanceMs, promptMatches, scheduleHoldsTint } from './schedule.mjs';

export const CONFIG = {
  // Background while Claude, a subagent, or a scheduled run due soon is busy.
  workingColor: '#1F2D3D',
  // Background while Claude's turn is over and only a background shell (a dev
  // server, a CI watch) still runs: a dark purple, a different hue from the
  // working slate and the needs-you background, so slate always means Claude
  // itself is busy.
  standbyColor: '#29203B',
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
  // Off since the glance mod (hooks/register.tsx) reports Esc as TurnAborted with no polling.
  // Turn it back on for sessions that can't load the mod.
  titleWatcher: false,
  // How long /glance-check shows the working color before putting the pane back.
  checkFlashMs: 1500,
  stateDir: path.join(os.homedir(), '.claude', 'state', 'glance'),
  // events.log rotates at this size, keeping this many older files
  // (events.log.1 is the newest of them).
  logMaxBytes: 1024 * 1024,
  logKeep: 3,
  // The soonest glance asks the mod to check back on background work (Tick).
  recheckMinMs: 30 * 1000,
};

export const WORKING = 'working';
export const STANDBY = 'standby';
export const ATTENTION = 'attention';
export const BACKGROUND_RUNNING = 'background-running';
export const SHELL_RUNNING = 'shell-running';
const COMPACT_MANUAL = 'compact-manual';

// Reasons that mean "finished", not "asking you something", so the engine
// starting work again (UiWorking) may turn the pane working.
const SETTLED = new Set([
  'session-start',
  'stop',
  'stop-failure',
  'aborted',
  'compact-done',
  'ui-idle',
  'title-idle',
  'reset',
  'idle_prompt',
  'expired',
  SHELL_RUNNING,
]);

// Tools whose whole purpose is to wait for an answer from you.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Tools that stop background work. KillShell is TaskStop's older name.
const STOP_TOOLS = new Set(['TaskStop', 'KillShell']);

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

// Background work that is Claude itself working, so it holds the working
// color. Anything else that isn't scheduled (a shell, a monitor) only holds
// the standby color: it may be a dev server nobody is waiting on.
const ACTIVE = new Set(['agent', 'workflow']);

// What glance calls the task types Claude Code lists in background_tasks.
const TASK_KINDS = { subagent: 'agent' };

/** How long a background item with no end signal is kept. */
function ttlOf(item) {
  return ACTIVE.has(item.kind) ? CONFIG.agentTtlMs : CONFIG.shellTtlMs;
}

/**
 * Background work that hasn't expired. Entries are { kind, at } for
 * 'agent' and 'shell' (and any other task type Claude Code lists), plus
 * { seen } once Claude Code has listed the item as running, and
 * { dueAt, prompt } for scheduled 'wakeup' and 'cron' runs (and
 * { cron, recurring } for cron). State files written before shells were
 * tracked hold an 'agents' map of id to start time.
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
    if (now - item.at < ttlOf(item)) live[id] = item;
  }
  return live;
}

/**
 * Brings the tracked background work in line with the list Claude Code sends
 * on Stop and SubagentStop (input.background_tasks: everything still in
 * flight). Whatever the list no longer names has ended, whether or not its
 * end reached glance: a shell a subagent started sends no end signal at all.
 * Whatever it names that glance missed is added. Scheduled runs aren't in the
 * list, and a stopping subagent is still in it, so both are left alone.
 */
function reconcile(background, input, now) {
  const listed = new Map();
  for (const task of input.background_tasks) {
    if (task && task.id) listed.set(String(task.id), task);
  }
  for (const [id, item] of Object.entries(background)) {
    if (SCHEDULED.has(item.kind) || id === input.agent_id) continue;
    if (listed.has(id)) background[id] = { ...item, seen: now };
    else delete background[id];
  }
  for (const [id, task] of listed) {
    if (id === input.agent_id || background[id]) continue;
    const type = String(task.type || 'task').replace(/\s+/g, '-');
    background[id] = { kind: TASK_KINDS[type] || type, at: now, seen: now };
  }
}

/**
 * The next moment time alone could change the pane: a background item
 * expiring, a scheduled run counted as missed, or one coming within the hour
 * that holds the tint. No event arrives then, so the mod asks again (Tick).
 *
 * @param {{background?: object} | null} state The state just saved.
 * @param {number} now Epoch milliseconds.
 * @returns {number | null} Epoch milliseconds, or null with nothing to wait for.
 */
export function recheckAt(state, now) {
  let at = Infinity;
  for (const item of Object.values(state?.background || {})) {
    if (!SCHEDULED.has(item.kind)) {
      at = Math.min(at, item.at + ttlOf(item));
      continue;
    }
    at = Math.min(at, item.dueAt + allowanceMs(item));
    if (item.dueAt - now > SCHEDULE_HORIZON_MS) at = Math.min(at, item.dueAt - SCHEDULE_HORIZON_MS);
  }
  return Number.isFinite(at) ? at : null;
}

/** Rounds a span in milliseconds to whole minutes. */
const minutes = (ms) => Math.round(ms / 60000);

/** Formats a span as "42 min ago", for /glance-fix's diagnosis. */
function ago(ms) {
  const min = minutes(ms);
  return min < 1 ? 'under a minute ago' : `${min} min ago`;
}

/**
 * Diagnoses what held the pane before /glance-fix reset it, returning a
 * verdict, whether it looks like a glance bug (suspect, which makes the
 * command suggest /glance-report), and the cause in plain words. Pure; `prev`
 * is the state before the reset and `input.live_agents` the agents the engine
 * still lists as running.
 */
export function diagnoseReset(prev, input, now) {
  const live = new Set(Array.isArray(input.live_agents) ? input.live_agents.map(String) : []);
  const before = liveBackground(prev, now);
  const lost = [];
  const stale = [];
  const listed = [];
  let running = 0;
  for (const [id, item] of Object.entries(before)) {
    if (item.kind === 'agent') {
      if (live.has(id)) running++;
      else lost.push(id);
    } else if (SCHEDULED.has(item.kind)) {
      const due = minutes(item.dueAt - now);
      stale.push(`${item.kind} ${id} (${due >= 0 ? `due in ${due} min` : `due ${-due} min ago`})`);
    } else if (item.seen) {
      listed.push(`${item.kind} ${id} (started ${ago(now - item.at)}, listed as running ${ago(now - item.seen)})`);
    } else {
      stale.push(`${item.kind} ${id} (started ${ago(now - item.at)})`);
    }
  }
  const last = prev.updatedAt ? `, set ${ago(now - prev.updatedAt)}` : '';
  if (prev.state === ATTENTION) {
    return {
      verdict: 'already-needs-you',
      suspect: true,
      cause: `glance already had this pane as needs you (${prev.reason}${last}). If it looked tinted, the color didn't reach the terminal: run /glance-check.`,
    };
  }
  if (lost.length) {
    return {
      verdict: 'missed-agent-end',
      suspect: true,
      cause: `glance was waiting on ${lost.length} subagent(s) that Claude Code no longer lists as running (${lost.join(', ')}), so it missed their end.`,
    };
  }
  if (stale.length) {
    return {
      verdict: 'stale-background',
      suspect: false,
      cause: `glance was keeping the tint for background work it never heard finish: ${stale.join(', ')}. A shell left running, such as a dev server, holds the purple standby tint for up to an hour.`,
    };
  }
  if (listed.length) {
    return {
      verdict: 'background-running',
      suspect: false,
      cause: `Claude Code listed this background work as still running when Claude last stopped, so the tint was right: ${listed.join(', ')}. glance has stopped counting it.`,
    };
  }
  if (running) {
    return {
      verdict: 'agents-running',
      suspect: false,
      cause: `${running} subagent(s) are still running, so the tint was right. glance kept them.`,
    };
  }
  return {
    verdict: 'missed-end',
    suspect: true,
    cause: `Nothing was running, but glance still had the pane working (${prev.reason}${last}). If Claude had finished, glance missed the end of its turn.`,
  };
}

/**
 * Describes the background items one event added and removed, for the log line.
 *
 * @param {object | undefined} before The background map before the event.
 * @param {object | null | undefined} after The background map after it.
 * @returns {string} For example ` (+shell b1, -agent a2)`, or an empty string when nothing changed.
 */
export function backgroundChanges(before, after) {
  const was = before || {};
  const now = after || {};
  const kind = (item) => item?.kind || 'agent';
  const added = Object.keys(now).filter((id) => !(id in was)).map((id) => `+${kind(now[id])} ${id}`);
  const removed = Object.keys(was).filter((id) => !(id in now)).map((id) => `-${kind(was[id])} ${id}`);
  const changes = [...added, ...removed];
  return changes.length ? ` (${changes.join(', ')})` : '';
}

/** True when background work that is Claude working (a subagent, a scheduled run due soon) is live. */
function holdsWorking(background, now) {
  return Object.values(background).some((item) => (SCHEDULED.has(item.kind) ? scheduleHoldsTint(item, now) : ACTIVE.has(item.kind)));
}

/** True when a background shell, or another task that isn't Claude working, is live. */
function holdsStandby(background) {
  return Object.values(background).some((item) => !SCHEDULED.has(item.kind) && !ACTIVE.has(item.kind));
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
  if (Array.isArray(input.background_tasks)) reconcile(background, input, now);
  const next = (state, reason) => ({ state, reason, background });
  const same = () => next(prev.state, prev.reason);
  const busy = () => holdsWorking(background, now);
  // Where the pane rests once Claude's own turn is over: working while a
  // subagent or a scheduled run holds it, standby while only a shell does,
  // and otherwise needs you, for the reason given.
  const rest = (reason) => {
    if (busy()) return next(WORKING, BACKGROUND_RUNNING);
    return holdsStandby(background) ? next(STANDBY, SHELL_RUNNING) : next(ATTENTION, reason);
  };
  // A manual /compact ends waiting on you. An automatic one runs inside a
  // turn, which goes on and ends with its own Stop. PostCompact and the
  // SessionStart (compact) after it both land here; the first one clears it.
  const compactDone = () => (prev.reason === COMPACT_MANUAL ? rest('compact-done') : same());

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
      // Killed agents send no SubagentStop and shells send no hook at all, so
      // their end arrives as a task notification in a prompt. The exception is
      // a shell stopped with TaskStop, handled on that tool's PostToolUse.
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
      // A shell stopped with TaskStop gets no task notification, so its
      // PostToolUse is the only sign it ended. A failed stop keeps it.
      if (event === 'PostToolUse' && STOP_TOOLS.has(input.tool_name)) {
        const stopped = input.tool_response?.task_id || input.tool_input?.task_id || input.tool_input?.shell_id;
        if (stopped) delete background[stopped];
      }
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
      if (input.notification_type === 'idle_prompt') return rest('idle_prompt');
      return next(ATTENTION, input.notification_type);

    case 'SubagentStart':
      if (input.agent_id) background[input.agent_id] = { kind: 'agent', at: now };
      return same();

    case 'SubagentStop':
      if (input.agent_id) delete background[input.agent_id];
      return same();

    case 'Stop':
      if (!fromMain) return same();
      return rest('stop');

    case 'StopFailure':
      return next(ATTENTION, 'stop-failure');

    case 'TurnAborted':
      // From the glance mod (hooks/register.tsx): you pressed Esc. No settings
      // hook fires for that, so without the mod this case is TitleIdle's job.
      return rest('aborted');

    case 'Tick': {
      // From the mod, at the moment recheckAt() named: background work may
      // have expired, or a scheduled run come within the hour, with no event
      // to say so. Only a pane resting on background work can lose its tint,
      // and only a finished one (never a question, never one /glance-fix
      // reset) can gain it, from a scheduled run alone.
      if (prev.reason === BACKGROUND_RUNNING || prev.state === STANDBY) return rest('expired');
      const due = Object.values(background).some((item) => SCHEDULED.has(item.kind) && scheduleHoldsTint(item, now));
      if (prev.state === ATTENTION && SETTLED.has(prev.reason) && prev.reason !== 'reset' && due) return next(WORKING, BACKGROUND_RUNNING);
      return same();
    }

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
      return rest(event === 'UiIdle' ? 'ui-idle' : 'title-idle');
    }

    default:
      return same();
  }
}

// Terminals glance knows, in the order detectTerminal() tries them, and how
// sure that the color codes (OSC 11 to set, OSC 111 to reset) work there:
// 'confirmed' means seen working with glance, 'expected' means the terminal
// documents both codes but nobody has confirmed glance with it yet.
// Multiplexers and editor terminals come first: they inherit the variables of
// the window they were started from (WT_SESSION, TERM_PROGRAM), and they decide
// whether the code gets through.
const TERMINALS = [
  ['tmux', (e) => e.TMUX, 'unknown'],
  ['GNU screen', (e) => e.STY, 'unknown'],
  ['VS Code', (e) => e.TERM_PROGRAM === 'vscode', 'expected'],
  ['JetBrains', (e) => /JetBrains/i.test(e.TERMINAL_EMULATOR || ''), 'unknown'],
  ['Windows Terminal', (e) => e.WT_SESSION, 'confirmed'],
  ['iTerm2', (e) => e.TERM_PROGRAM === 'iTerm.app', 'expected'],
  ['macOS Terminal', (e) => e.TERM_PROGRAM === 'Apple_Terminal', 'unknown'],
  ['WezTerm', (e) => e.TERM_PROGRAM === 'WezTerm', 'expected'],
  ['Ghostty', (e) => e.TERM_PROGRAM === 'ghostty', 'expected'],
  ['kitty', (e) => e.KITTY_WINDOW_ID || e.TERM === 'xterm-kitty', 'expected'],
  ['Alacritty', (e) => e.ALACRITTY_WINDOW_ID || e.ALACRITTY_SOCKET, 'expected'],
  ['Konsole', (e) => e.KONSOLE_VERSION, 'expected'],
  ['mintty (Git Bash window)', (e) => e.TERM_PROGRAM === 'mintty', 'unknown'],
  ['ConEmu', (e) => e.ConEmuPID, 'unknown'],
  ['GNOME Terminal or another VTE terminal', (e) => e.VTE_VERSION, 'expected'],
];

/**
 * Names the terminal from the environment Claude Code (and so each hook)
 * inherits from it. Pure, for the tests.
 *
 * @param {Record<string, string | undefined>} env For example process.env.
 * @param {string} [platform] process.platform, or another for the tests.
 * @returns {{name: string, support: string}} support is 'confirmed',
 *   'expected', or 'unknown'.
 */
export function detectTerminal(env, platform = process.platform) {
  for (const [name, test, support] of TERMINALS) if (test(env)) return { name, support };
  if (platform === 'win32' && !env.TERM_PROGRAM) return { name: 'Windows console (conhost)', support: 'unknown' };
  return { name: env.TERM_PROGRAM || env.TERM || 'unknown', support: 'unknown' };
}

/**
 * /glance-check: shows the working color for a moment, puts the pane back as
 * glance has it, and prints what it found for the person to compare with what
 * they saw. Changes no state.
 */
function check(input, stateFile) {
  const flash = paint(osc(WORKING));
  sleep(CONFIG.checkFlashMs);
  let restore = '';
  let state = emptyState();
  withLock(stateFile + '.lock', () => {
    state = readState(stateFile);
    restore = paint(osc(state.state));
  });
  const report = {
    version: glanceVersion(),
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    surface: input.surface || 'unknown',
    terminal: detectTerminal(process.env),
    painter: process.platform === 'win32' ? 'paint.exe' : 'tty',
    flash,
    restore,
    flash_ms: CONFIG.checkFlashMs,
    state: `${state.state} [${state.reason}]`,
    background: Object.keys(liveBackground(state, Date.now())).length,
  };
  log(`${new Date().toISOString()} ${String(input.session_id || '').slice(0, 8)} main GlanceCheck -> ${report.state} flash:${flash} restore:${restore} terminal:${report.terminal.name}`);
  // The state line first, as apply() prints it, so the mod's band stays current.
  if (input.glance_via === 'mod') process.stdout.write(stateLine(state, Date.now()) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
}

/** The OSC body for a state, without the ESC ] prefix and BEL terminator. */
export function osc(state) {
  const color = state === WORKING ? CONFIG.workingColor : state === STANDBY ? CONFIG.standbyColor : CONFIG.attentionColor;
  return color ? `11;${color}` : '111';
}

/**
 * The line the mod reads first for every event it sends: the state and the
 * color its desktop band draws in, plus how long until the mod should send a
 * Tick, when background work could change the pane with no event.
 *
 * @param {{state: string, background?: object} | null} state The state just saved; null once the session has ended.
 * @param {number} now Epoch milliseconds.
 * @returns {string} One line of JSON.
 */
export function stateLine(state, now) {
  const name = state ? state.state : ATTENTION;
  const line = { state: name, color: name === STANDBY ? CONFIG.standbyColor : CONFIG.workingColor };
  const at = recheckAt(state, now);
  if (at !== null) line.recheck_in_ms = Math.max(CONFIG.recheckMinMs, at - now);
  return JSON.stringify(line);
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
  if (['TitleIdle', 'UiIdle', 'UiWorking', 'TurnAborted', 'GlanceReset', 'Tick', 'SessionEnd'].includes(input.hook_event_name)) return '';
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

/** The installed glance version from the plugin manifest, or 'unknown'. */
function glanceVersion() {
  try {
    const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '.claude-plugin', 'plugin.json');
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Reads the last `max` log lines for one session (its id's first 8
 * characters), from events.log and the file it last rotated out, so a
 * rotation just before /glance-fix doesn't empty the snapshot. A missing log
 * is just empty; any other read failure comes back as `error`, so the
 * snapshot can say why its log is short.
 */
function sessionLog(sid, max) {
  const lines = [];
  let error;
  for (const name of ['events.log.1', 'events.log']) {
    try {
      lines.push(...fs.readFileSync(path.join(CONFIG.stateDir, name), 'utf8').split('\n'));
    } catch (err) {
      if (err.code !== 'ENOENT') error = err.code || err.message;
    }
  }
  const recent = { lines: lines.filter((l) => l.split(' ')[1] === sid).slice(-max) };
  if (error) recent.error = error;
  return recent;
}

/**
 * Saves what /glance-fix found, for /glance-report and the report-issue skill:
 * the state before the reset, the diagnosis, versions, and this session's
 * recent log lines (no prompts). Returns the file's path, or '' if it failed.
 */
function saveSnapshot(input, prev, diagnosis, written, now) {
  const sid = String(input.session_id || '').slice(0, 8);
  const file = path.join(CONFIG.stateDir, `fix-${safeId(input.session_id)}.json`);
  const background = Object.entries(liveBackground(prev, now)).map(([id, item]) => ({
    id,
    kind: item.kind,
    ...(item.at ? { started_min_ago: minutes(now - item.at) } : {}),
    ...(item.seen ? { listed_running_min_ago: minutes(now - item.seen) } : {}),
    ...(item.dueAt ? { due_in_min: minutes(item.dueAt - now) } : {}),
  }));
  const snapshot = {
    at: new Date(now).toISOString(),
    glance: glanceVersion(),
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    session: sid,
    before: {
      state: prev.state,
      reason: prev.reason,
      set_min_ago: prev.updatedAt ? minutes(now - prev.updatedAt) : null,
      background,
    },
    live_agents: Array.isArray(input.live_agents) ? input.live_agents.length : 0,
    diagnosis,
    paint: written,
  };
  const recent = sessionLog(sid, 40);
  snapshot.log = recent.lines;
  if (recent.error) {
    // Usually unwritable too, so log() may drop this; the snapshot keeps it.
    snapshot.log_error = recent.error;
    log(`${snapshot.at} ${sid} glance-fix log-unreadable:${recent.error}`);
  }
  try {
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
    return file;
  } catch (err) {
    log(`${snapshot.at} ${sid} glance-fix snapshot-failed:${err.code || err.message}`);
    return '';
  }
}

function log(line) {
  const file = path.join(CONFIG.stateDir, 'events.log');
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > CONFIG.logMaxBytes) {
      for (let n = CONFIG.logKeep - 1; n >= 1; n--) {
        if (fs.existsSync(`${file}.${n}`)) fs.renameSync(`${file}.${n}`, `${file}.${n + 1}`);
      }
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
  // /glance-check changes no state; it takes the lock only for its restore.
  if (input.hook_event_name === 'GlanceCheck') return check(input, stateFile);
  // UiIdle arrives the moment the engine stops working. Wait out the confirm
  // window first, so decide() sees any hook that lands meanwhile (a new prompt,
  // the next tool) and leaves the tint alone.
  if (input.hook_event_name === 'UiIdle') sleep(CONFIG.titleIdleConfirmMs + 100);
  // Hooks for one session can run at the same moment (for example SubagentStart
  // and the Agent tool's PostToolUse), so read, decide, write, and paint under a
  // lock. That keeps the state file and the pane color in event order.
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
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
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
    // Only this hook's own lock: one that ran without it leaves the holder's alone.
    if (held) fs.rmSync(lockDir, { recursive: true, force: true });
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
  if (input.glance_via === 'mod') process.stdout.write(stateLine(next, now) + '\n');

  if (input.hook_event_name === 'GlanceReset') {
    // The mod prints this as the command's output.
    const before = liveBackground(prev, now);
    const dropped = Object.keys(before).filter((id) => !next.background[id]);
    const kept = Object.keys(next.background);
    const diagnosis = diagnoseReset(prev, input, now);
    process.stdout.write(
      JSON.stringify({
        was: `${prev.state} [${prev.reason}]`,
        dropped: dropped.map((id) => `${before[id].kind} ${id}`),
        kept: kept.map((id) => `agent ${id}`),
        paint: written,
        diagnosis,
        snapshot: saveSnapshot(input, prev, diagnosis, written, now),
      }) + '\n',
    );
  }

  const bgCount = next ? Object.keys(next.background).length : 0;
  log(
    `${new Date(now).toISOString()} ${sid} ${who} ${input.hook_event_name}` +
      `${detail ? ` (${detail})` : ''} -> ${next ? next.state : 'reset'} [${next ? next.reason : 'session-end'}]` +
      // Against everything the last event saved, so an item that expired shows as removed.
      ` bg=${bgCount}${backgroundChanges(prev.background, next?.background)} ${written}${watch ? ' ' + watch : ''}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
