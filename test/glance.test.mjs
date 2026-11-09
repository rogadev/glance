import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorTtyFrom,
  backgroundChanges,
  decide,
  detectTerminal,
  diagnoseReset,
  emptyState,
  endedTaskIds,
  osc,
  recheckAt,
  stateLine,
  CONFIG,
  WORKING,
  STANDBY,
  ATTENTION,
} from '../glance.mjs';

const T = 1_000_000;

// Runs events one second apart, carrying updatedAt the way apply() does.
function run(events, start = emptyState()) {
  let s = start;
  let t = T;
  for (const e of events) {
    t = e.at ?? t + 1000;
    const n = decide(s, e, t);
    if (n === null) return null;
    s = { ...n, updatedAt: t };
  }
  return s;
}

const main = (hook_event_name, extra = {}) => ({ hook_event_name, ...extra });
const sub = (hook_event_name, agent_id, extra = {}) => ({ hook_event_name, agent_id, ...extra });
const ids = (s) => Object.keys(s.background);

// The real prompt Claude Code sends when background work ends. Killed agents get
// no SubagentStop and shells get no hook at all, so this is their end signal
// (except a shell stopped with TaskStop, which gets none; see taskStop below).
const notice = (id, status = 'killed') =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n` +
  `<output-file>C:\\tmp\\tasks\\${id}.output</output-file>\n<status>${status}</status>\n` +
  `<summary>x</summary>\n</task-notification>`;

// A Bash call with run_in_background, as PostToolUse reports it.
const bgShell = (id) =>
  main('PostToolUse', { tool_name: 'Bash', tool_input: { run_in_background: true }, tool_response: { backgroundTaskId: id } });

test('a manual /compact is working, then needs you when PostCompact arrives', () => {
  const during = run([main('Stop'), main('PreCompact', { trigger: 'manual' })]);
  assert.equal(during.state, WORKING);
  assert.equal(run([main('PostCompact', { trigger: 'manual' })], during).state, ATTENTION);
});

test('a manual /compact also ends on the SessionStart (compact) that follows it', () => {
  const during = run([main('PreCompact', { trigger: 'manual' })]);
  assert.equal(run([main('SessionStart', { source: 'compact' })], during).state, ATTENTION);
});

test('a manual /compact with a background shell running ends on standby', () => {
  const during = run([bgShell('b1'), main('Stop'), main('PreCompact', { trigger: 'manual' })]);
  assert.equal(during.state, WORKING);
  const after = run([main('PostCompact', { trigger: 'manual' })], during);
  assert.equal(after.state, STANDBY);
  assert.deepEqual(ids(after), ['b1']);
});

test('an automatic compact mid-turn stays working until the turn stops', () => {
  const s = run([
    main('UserPromptSubmit'),
    main('PreCompact', { trigger: 'auto' }),
    main('PostCompact', { trigger: 'auto' }),
    main('SessionStart', { source: 'compact' }),
  ]);
  assert.equal(s.state, WORKING);
  assert.equal(run([main('Stop')], s).state, ATTENTION);
});

test('a subagent compacting does not tint the pane', () => {
  assert.equal(run([main('Stop'), sub('PreCompact', 'a1', { trigger: 'auto' })]).state, ATTENTION);
});

test('a normal turn goes working, then attention on Stop', () => {
  assert.equal(run([main('UserPromptSubmit')]).state, WORKING);
  assert.equal(run([main('UserPromptSubmit'), main('PreToolUse', { tool_name: 'Bash' }), main('Stop')]).state, ATTENTION);
});

test('a permission prompt needs attention, and the approved tool finishing resumes working', () => {
  const asked = run([main('UserPromptSubmit'), main('PreToolUse', { tool_name: 'Bash' }), main('PermissionRequest')]);
  assert.equal(asked.state, ATTENTION);
  assert.equal(run([main('PostToolUse')], asked).state, WORKING);
});

test('AskUserQuestion and ExitPlanMode need attention until answered', () => {
  for (const tool_name of ['AskUserQuestion', 'ExitPlanMode']) {
    const asked = run([main('UserPromptSubmit'), main('PreToolUse', { tool_name })]);
    assert.equal(asked.state, ATTENTION);
    assert.equal(run([main('PostToolUse', { tool_name })], asked).state, WORKING);
  }
});

test('a subagent tool event never hides a question the main thread is waiting on', () => {
  const asked = run([
    main('UserPromptSubmit'),
    sub('SubagentStart', 'a1'),
    main('PreToolUse', { tool_name: 'AskUserQuestion' }),
    sub('PreToolUse', 'a1', { tool_name: 'Read' }),
    sub('PostToolUse', 'a1', { tool_name: 'Read' }),
  ]);
  assert.equal(asked.state, ATTENTION);
});

test('a subagent permission prompt needs attention and clears once its tool runs', () => {
  const asked = run([main('UserPromptSubmit'), sub('SubagentStart', 'a1'), sub('PermissionRequest', 'a1')]);
  assert.equal(asked.state, ATTENTION);
  assert.equal(asked.reason, 'subagent-permission');
  assert.equal(run([sub('PostToolUse', 'a1')], asked).state, WORKING);
});

test('Stop with background subagents running stays working, then the next Stop clears it', () => {
  const waiting = run([main('UserPromptSubmit'), sub('SubagentStart', 'a1'), main('Stop')]);
  assert.equal(waiting.state, WORKING);
  assert.equal(waiting.reason, 'background-running');
  assert.equal(run([sub('SubagentStop', 'a1'), main('Stop')], waiting).state, ATTENTION);
});

test('a killed background agent is cleared by its task notification, so Stop needs attention', () => {
  const s = run([
    main('UserPromptSubmit'),
    sub('SubagentStart', 'aae0544f9f4ba4d77'),
    main('UserPromptSubmit', { prompt: notice('aae0544f9f4ba4d77') }),
    main('Stop'),
  ]);
  assert.equal(s.state, ATTENTION);
  assert.deepEqual(ids(s), []);
});

test('a notification for one task leaves the others running', () => {
  const s = run([
    sub('SubagentStart', 'a1'),
    sub('SubagentStart', 'a2'),
    main('UserPromptSubmit', { prompt: notice('a1') }),
    main('Stop'),
  ]);
  assert.equal(s.state, WORKING);
  assert.deepEqual(ids(s), ['a2']);
});

test('a background shell (a CI watch, a dev server) puts the pane on standby after Stop, not working', () => {
  const waiting = run([main('UserPromptSubmit'), bgShell('b37q4qei1'), main('Stop')]);
  assert.equal(waiting.state, STANDBY);
  assert.equal(waiting.reason, 'shell-running');
  assert.deepEqual(ids(waiting), ['b37q4qei1']);
  // Its completion arrives as a prompt; the turn that handles it ends with Stop.
  const done = run([main('UserPromptSubmit', { prompt: notice('b37q4qei1', 'completed') }), main('Stop')], waiting);
  assert.equal(done.state, ATTENTION);
  assert.deepEqual(ids(done), []);
});

// TaskStop's PostToolUse, as Claude Code 2.1.319 sends it. No task notification follows.
const taskStop = (id, extra = {}) =>
  main('PostToolUse', {
    tool_name: 'TaskStop',
    tool_input: { task_id: id },
    tool_response: { message: `Successfully stopped task: ${id} (sleep 300)`, task_id: id, task_type: 'local_bash' },
    ...extra,
  });

test('a shell stopped with TaskStop no longer holds the tint', () => {
  const s = run([main('UserPromptSubmit'), bgShell('bn6pdd0nr'), taskStop('bn6pdd0nr'), main('Stop')]);
  assert.equal(s.state, ATTENTION);
  assert.deepEqual(ids(s), []);
});

test('TaskStop clears only the shell it stopped', () => {
  const s = run([main('UserPromptSubmit'), bgShell('b1'), bgShell('b2'), taskStop('b1'), main('Stop')]);
  assert.equal(s.state, STANDBY);
  assert.deepEqual(ids(s), ['b2']);
});

test('TaskStop takes the id from its input when the response has none, and the older KillShell works too', () => {
  const fromInput = run([bgShell('b1'), main('PostToolUse', { tool_name: 'TaskStop', tool_input: { task_id: 'b1' }, tool_response: {} }), main('Stop')]);
  assert.deepEqual(ids(fromInput), []);
  const deprecated = run([bgShell('b1'), main('PostToolUse', { tool_name: 'TaskStop', tool_input: { shell_id: 'b1' }, tool_response: {} }), main('Stop')]);
  assert.deepEqual(ids(deprecated), []);
  const kill = run([bgShell('b1'), main('PostToolUse', { tool_name: 'KillShell', tool_input: { shell_id: 'b1' }, tool_response: {} }), main('Stop')]);
  assert.deepEqual(ids(kill), []);
});

test('a TaskStop that failed keeps the shell, since it may still be running', () => {
  const s = run([bgShell('b1'), taskStop('b1', { hook_event_name: 'PostToolUseFailure' }), main('Stop')]);
  assert.equal(s.state, STANDBY);
  assert.deepEqual(ids(s), ['b1']);
});

test('a subagent stopping a shell clears it too', () => {
  const s = run([bgShell('b1'), sub('PostToolUse', 'a1', { tool_name: 'TaskStop', tool_input: { task_id: 'b1' }, tool_response: { task_id: 'b1' } }), main('Stop')]);
  assert.deepEqual(ids(s), []);
});

test('the log names background items as they are added and removed', () => {
  assert.equal(backgroundChanges({}, {}), '');
  assert.equal(backgroundChanges({}, { b1: { kind: 'shell' } }), ' (+shell b1)');
  assert.equal(backgroundChanges({ b1: { kind: 'shell' }, a1: { kind: 'agent' } }, { a1: { kind: 'agent' } }), ' (-shell b1)');
  assert.equal(backgroundChanges({ b1: { kind: 'shell' } }, { b2: { kind: 'shell' } }), ' (+shell b2, -shell b1)');
  assert.equal(backgroundChanges({ b1: { kind: 'shell' } }, null), ' (-shell b1)');
  assert.equal(backgroundChanges(undefined, { a1: {} }), ' (+agent a1)');
});

test('a foreground shell call is not tracked as background work', () => {
  const s = run([main('UserPromptSubmit'), main('PostToolUse', { tool_name: 'Bash', tool_response: { stdout: '' } }), main('Stop')]);
  assert.equal(s.state, ATTENTION);
});

test('background shells expire sooner than agents, so a forgotten dev server cannot hold the tint for hours', () => {
  const s = run([main('UserPromptSubmit'), { ...bgShell('srv'), at: T }, { ...sub('SubagentStart', 'a1'), at: T }]);
  const later = decide(s, main('Stop'), T + CONFIG.shellTtlMs + 1);
  assert.deepEqual(ids(later), ['a1']);
  const muchLater = decide(s, main('Stop'), T + CONFIG.agentTtlMs + 1);
  assert.equal(muchLater.state, ATTENTION);
  assert.deepEqual(ids(muchLater), []);
});

test('state files from before shells were tracked still count their agents', () => {
  const old = { state: WORKING, reason: 'tool', agents: { a1: T } };
  assert.equal(decide(old, main('Stop'), T + 1000).state, WORKING);
});

test('a subagent Stop event does not end the main turn', () => {
  assert.equal(run([main('UserPromptSubmit'), sub('Stop', 'a1')]).state, WORKING);
});

test('endedTaskIds reads every notification and skips running ones', () => {
  const running = '<task-notification><task-id>r1</task-id><status>running</status></task-notification>';
  const done = '<task-notification><task-id>d1</task-id><status>completed</status></task-notification>';
  assert.deepEqual(endedTaskIds(`${notice('k1')}\n${running}\n${done}`), ['k1', 'd1']);
  assert.deepEqual(endedTaskIds('a normal prompt that mentions <task-id>x</task-id>'), []);
  assert.deepEqual(endedTaskIds(undefined), []);
});

// Scheduled runs, as PostToolUse reports them (shapes captured 2026-11-07).
const wakeup = (scheduledFor, prompt = 'check CI again', extra = {}) =>
  main('PostToolUse', { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 240, prompt, ...extra }, tool_response: { scheduledFor } });
const cron = (id, nextFireAt, cronExpr, recurring, prompt = 'poll the deploy') =>
  main('PostToolUse', { tool_name: 'CronCreate', tool_input: { cron: cronExpr, prompt, recurring }, tool_response: { id, nextFireAt, recurring } });

test('a /loop wakeup keeps the pane working until it fires, then the iteration decides', () => {
  const waiting = run([main('UserPromptSubmit', { at: T }), wakeup(T + 240_000, 'check CI again', {}), main('Stop')]);
  assert.equal(waiting.state, WORKING);
  assert.equal(waiting.reason, 'background-running');
  const fired = run([main('UserPromptSubmit', { prompt: 'check CI again', at: T + 241_000 }), main('Stop')], waiting);
  assert.equal(fired.state, ATTENTION);
  assert.deepEqual(ids(fired), []);
});

test('an iteration that schedules the next wakeup stays working', () => {
  const s = run([wakeup(T + 240_000, 'loop'), main('Stop'), main('UserPromptSubmit', { prompt: 'loop', at: T + 241_000 }), wakeup(T + 481_000, 'loop'), main('Stop')]);
  assert.equal(s.state, WORKING);
});

test('ScheduleWakeup with stop ends the loop', () => {
  const s = run([wakeup(T + 240_000, 'loop'), main('PostToolUse', { tool_name: 'ScheduleWakeup', tool_input: { stop: true }, tool_response: {} }), main('Stop')]);
  assert.equal(s.state, ATTENTION);
});

test('your own prompt while a wakeup is pending does not consume it', () => {
  const s = run([wakeup(T + 240_000, 'loop'), main('Stop'), main('UserPromptSubmit', { prompt: 'how is it going?' }), main('Stop')]);
  assert.equal(s.state, WORKING);
  assert.deepEqual(ids(s), ['wakeup']);
});

test('a wakeup that never fires is dropped after its grace period', () => {
  const s = run([{ ...wakeup(T + 240_000, 'loop'), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(decide(s, main('Stop'), T + 240_000 + 121_000).state, ATTENTION);
});

test('a schedule more than an hour out does not hold the tint', () => {
  const s = run([{ ...cron('c1', T + 2 * 3600_000, '0 9 * * *', true), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(s.state, ATTENTION);
  assert.deepEqual(ids(s), ['cron:c1']);
});

test('a recurring cron keeps working across fires and ends on CronDelete', () => {
  const s = run([{ ...cron('c2', T + 300_000, '*/5 * * * *', true, 'poll'), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(s.state, WORKING);
  const afterFire = run([main('UserPromptSubmit', { prompt: 'poll', at: T + 301_000 }), main('Stop', { at: T + 302_000 })], s);
  assert.equal(afterFire.state, WORKING);
  assert.ok(afterFire.background['cron:c2'].dueAt > T + 301_000);
  const deleted = run([main('PostToolUse', { tool_name: 'CronDelete', tool_input: { id: 'c2' }, tool_response: {}, at: T + 303_000 }), main('Stop', { at: T + 304_000 })], afterFire);
  assert.equal(deleted.state, ATTENTION);
});

test('a one-shot cron ends when it fires', () => {
  const s = run([{ ...cron('c3', T + 120_000, '29 11 7 11 *', false, 'remind'), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(s.state, WORKING);
  assert.equal(run([main('UserPromptSubmit', { prompt: 'remind', at: T + 121_000 }), main('Stop', { at: T + 122_000 })], s).state, ATTENTION);
});

test('TitleIdle leaves a pane waiting on a scheduled run alone', () => {
  const s = run([main('UserPromptSubmit', { at: T }), { ...wakeup(T + 240_000, 'loop'), at: T + 100 }, main('Stop', { at: T + 200 })]);
  assert.equal(run([titleIdle(T + 300, T + 60_000)], s).state, WORKING);
});

test('TurnAborted (Esc, reported by the glance mod) clears the tint at once', () => {
  const s = run([main('UserPromptSubmit'), main('PreToolUse', { tool_name: 'Bash' }), main('TurnAborted')]);
  assert.equal(s.state, ATTENTION);
  assert.equal(s.reason, 'aborted');
});

test('TurnAborted with a subagent still running stays working, and with only a shell goes to standby', () => {
  assert.equal(run([main('UserPromptSubmit'), sub('SubagentStart', 'a1'), main('TurnAborted')]).state, WORKING);
  assert.equal(run([main('UserPromptSubmit'), bgShell('ci'), main('TurnAborted')]).state, STANDBY);
});

test('GlanceReset (/glance-fix) clears a tint held by stale shells and schedules', () => {
  const wakeup = main('PostToolUse', {
    tool_name: 'ScheduleWakeup',
    tool_input: { prompt: 'p' },
    tool_response: { scheduledFor: T + 10 * 60 * 1000 },
  });
  const stuck = run([main('UserPromptSubmit'), bgShell('dev'), wakeup, main('Stop')]);
  assert.equal(stuck.state, WORKING);
  const s = run([main('GlanceReset')], stuck);
  assert.equal(s.state, ATTENTION);
  assert.equal(s.reason, 'reset');
  assert.deepEqual(ids(s), []);
});

test('GlanceReset keeps only agents the engine still lists as running', () => {
  const s = run([
    main('UserPromptSubmit'),
    sub('SubagentStart', 'alive'),
    sub('SubagentStart', 'gone'),
    main('GlanceReset', { live_agents: ['alive'] }),
  ]);
  assert.equal(s.state, ATTENTION);
  assert.deepEqual(ids(s), ['alive']);
  // The kept agent still holds the tint after the next turn, as it should.
  assert.equal(run([main('UserPromptSubmit'), main('Stop')], s).state, WORKING);
});

// diagnoseReset says what /glance-fix found before it reset the pane.
const MIN = 60 * 1000;

test('/glance-fix on a tint held by a background shell names it and its age, not a bug', () => {
  const stuck = run([main('UserPromptSubmit'), bgShell('dev'), main('Stop')]);
  const d = diagnoseReset(stuck, main('GlanceReset', { live_agents: [] }), stuck.updatedAt + 42 * MIN);
  assert.equal(d.verdict, 'stale-background');
  assert.equal(d.suspect, false);
  assert.match(d.cause, /shell dev \(started 42 min ago\)/);
});

test('/glance-fix on agents Claude Code no longer lists reports a missed agent end', () => {
  const stuck = run([main('UserPromptSubmit'), sub('SubagentStart', 'gone'), main('Stop')]);
  const d = diagnoseReset(stuck, main('GlanceReset', { live_agents: [] }), stuck.updatedAt + MIN);
  assert.equal(d.verdict, 'missed-agent-end');
  assert.equal(d.suspect, true);
  assert.match(d.cause, /gone/);
});

test('/glance-fix with every tracked agent still running says the tint was right', () => {
  const s = run([main('UserPromptSubmit'), sub('SubagentStart', 'alive'), main('Stop')]);
  const d = diagnoseReset(s, main('GlanceReset', { live_agents: ['alive'] }), s.updatedAt + MIN);
  assert.equal(d.verdict, 'agents-running');
  assert.equal(d.suspect, false);
});

test('/glance-fix on a working pane with nothing running reports a missed end of turn', () => {
  const s = run([main('UserPromptSubmit'), main('PreToolUse', { tool_name: 'Bash' })]);
  const d = diagnoseReset(s, main('GlanceReset', { live_agents: [] }), s.updatedAt + 12 * MIN);
  assert.equal(d.verdict, 'missed-end');
  assert.equal(d.suspect, true);
  assert.match(d.cause, /tool/);
  assert.match(d.cause, /12 min ago/);
});

test('/glance-fix names a scheduled wakeup by when it is due, ahead or overdue', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0);
  const held = (dueAt) => ({
    ...emptyState(),
    state: WORKING,
    reason: 'background-running',
    updatedAt: now - MIN,
    background: { 'wakeup:w1': { kind: 'wakeup', dueAt } },
  });
  const ahead = diagnoseReset(held(now + 5 * MIN), main('GlanceReset', { live_agents: [] }), now);
  assert.equal(ahead.verdict, 'stale-background');
  assert.match(ahead.cause, /wakeup wakeup:w1 \(due in 5 min\)/);
  // One minute late is still inside the wakeup's allowance, so it's still tracked.
  const late = diagnoseReset(held(now - MIN), main('GlanceReset', { live_agents: [] }), now);
  assert.match(late.cause, /wakeup wakeup:w1 \(due 1 min ago\)/);
});

test('/glance-fix reports a missed agent end ahead of a stale shell', () => {
  const stuck = run([main('UserPromptSubmit'), bgShell('dev'), sub('SubagentStart', 'gone'), main('Stop')]);
  const d = diagnoseReset(stuck, main('GlanceReset', { live_agents: [] }), stuck.updatedAt + MIN);
  assert.equal(d.verdict, 'missed-agent-end');
  assert.equal(d.suspect, true);
});

test('/glance-fix rounds a shell age to the nearest minute, and says when it is under one', () => {
  const s = run([main('UserPromptSubmit'), bgShell('dev'), main('Stop')]);
  // Measured from when the shell started, not from the Stop after it.
  const started = Object.values(s.background).find((b) => b.kind === 'shell').at;
  const at = (ms) => diagnoseReset(s, main('GlanceReset', { live_agents: [] }), started + ms).cause;
  assert.match(at(90 * 1000), /started 2 min ago/);
  assert.match(at(29 * 1000), /started under a minute ago/);
});

test('/glance-fix reports a stale shell ahead of an agent that is still running', () => {
  const s = run([main('UserPromptSubmit'), bgShell('dev'), sub('SubagentStart', 'alive'), main('Stop')]);
  const d = diagnoseReset(s, main('GlanceReset', { live_agents: ['alive'] }), s.updatedAt + MIN);
  assert.equal(d.verdict, 'stale-background');
  assert.equal(d.suspect, false);
});

test('/glance-fix with no agent list counts every tracked agent as gone', () => {
  const stuck = run([main('UserPromptSubmit'), sub('SubagentStart', 'gone'), main('Stop')]);
  const d = diagnoseReset(stuck, main('GlanceReset'), stuck.updatedAt + MIN);
  assert.equal(d.verdict, 'missed-agent-end');
});

test('/glance-fix leaves out when the state was set if it never was', () => {
  const s = { ...emptyState(), state: WORKING, reason: 'tool', updatedAt: 0 };
  const d = diagnoseReset(s, main('GlanceReset', { live_agents: [] }), Date.UTC(2026, 10, 8));
  assert.equal(d.verdict, 'missed-end');
  assert.match(d.cause, /\(tool\)/);
  assert.doesNotMatch(d.cause, /, set /);
});

test('/glance-fix on a pane glance already had as needs you points at painting', () => {
  const s = run([main('UserPromptSubmit'), main('Stop')]);
  const d = diagnoseReset(s, main('GlanceReset', { live_agents: [] }), s.updatedAt + MIN);
  assert.equal(d.verdict, 'already-needs-you');
  assert.equal(d.suspect, true);
  assert.match(d.cause, /\/glance-check/);
});

// TitleIdle comes from paint.exe --watch when the pane title shows Claude idle.
const titleIdle = (idle_since, at) => ({ hook_event_name: 'TitleIdle', idle_since, at });

test('an Esc interrupt (no hook) is caught when the title has been idle long enough', () => {
  const s = run([main('UserPromptSubmit', { at: T }), main('PreToolUse', { tool_name: 'Bash', at: T + 1000 })]);
  const caught = run([titleIdle(T + 2000, T + 2000 + CONFIG.titleIdleConfirmMs)], s);
  assert.equal(caught.state, ATTENTION);
  assert.equal(caught.reason, 'title-idle');
});

test('TitleIdle waits out the confirm window', () => {
  const s = run([main('UserPromptSubmit', { at: T })]);
  assert.equal(run([titleIdle(T + 500, T + 1500)], s).state, WORKING);
});

test('TitleIdle ignores idle time from before the latest hook (title lags a new prompt)', () => {
  // The title was idle before the prompt; the prompt's hook fired after that.
  const s = run([main('UserPromptSubmit', { at: T + 10_000 })]);
  assert.equal(run([titleIdle(T, T + 11_000)], s).state, WORKING);
  assert.equal(run([titleIdle(T, T + 10_000 + CONFIG.titleIdleConfirmMs)], s).state, ATTENTION);
});

test('TitleIdle never clears the tint while background work runs', () => {
  const agent = run([main('UserPromptSubmit', { at: T }), { ...sub('SubagentStart', 'a1'), at: T + 100 }, main('Stop', { at: T + 200 })]);
  assert.equal(run([titleIdle(T + 300, T + 60_000)], agent).state, WORKING);
  const shell = run([main('UserPromptSubmit', { at: T }), { ...bgShell('ci'), at: T + 100 }, main('Stop', { at: T + 200 })]);
  assert.equal(run([titleIdle(T + 300, T + 60_000)], shell).state, STANDBY);
});

test('TitleIdle never turns the pane to working', () => {
  const s = run([main('UserPromptSubmit', { at: T }), main('Stop', { at: T + 100 })]);
  const after = run([titleIdle(T + 200, T + 60_000)], s);
  assert.equal(after.state, ATTENTION);
  assert.equal(after.reason, 'stop');
});

// UiIdle comes from the mod when the engine's isWorking goes false.
const uiIdle = (idle_since, at) => ({ hook_event_name: 'UiIdle', idle_since, at });

test('a /compact cancelled with Esc (no PostCompact) is cleared by UiIdle', () => {
  // Seen live: PreCompact, then Esc, then no event at all for two minutes.
  const s = run([main('Stop', { at: T }), main('PreCompact', { trigger: 'manual', at: T + 1000 })]);
  assert.equal(s.state, WORKING);
  const caught = run([uiIdle(T + 4000, T + 4000 + CONFIG.titleIdleConfirmMs + 100)], s);
  assert.equal(caught.state, ATTENTION);
  assert.equal(caught.reason, 'ui-idle');
});

test('UiIdle leaves the tint alone when a hook landed while it waited', () => {
  const s = run([main('UserPromptSubmit', { at: T + 2000 })]);
  assert.equal(run([uiIdle(T + 1000, T + 3600)], s).state, WORKING);
});

test('UiIdle never clears the tint while background work runs', () => {
  const agent = run([main('UserPromptSubmit', { at: T }), { ...sub('SubagentStart', 'a1'), at: T + 100 }, main('Stop', { at: T + 200 })]);
  assert.equal(run([uiIdle(T + 300, T + 60_000)], agent).state, WORKING);
  const shell = run([main('UserPromptSubmit', { at: T }), { ...bgShell('ci'), at: T + 100 }, main('Stop', { at: T + 200 })]);
  assert.equal(run([uiIdle(T + 300, T + 60_000)], shell).state, STANDBY);
});

test('bash mode (no hook, only UiWorking) shows working, then needs you on Stop', () => {
  // Seen live: ! sleep 20 sent no prompt or tool hook, then Stop when it ended.
  const s = run([main('Stop'), main('UiWorking')]);
  assert.equal(s.state, WORKING);
  assert.equal(s.reason, 'ui-working');
  assert.equal(run([main('Stop')], s).state, ATTENTION);
});

test('UiWorking never covers a question or a permission prompt', () => {
  const asks = [
    main('PermissionRequest', { tool_name: 'Bash' }),
    main('PreToolUse', { tool_name: 'AskUserQuestion' }),
    main('Elicitation'),
    main('Notification', { notification_type: 'permission_prompt' }),
    sub('PermissionRequest', 'a1', { tool_name: 'Bash' }),
  ];
  for (const ask of asks) {
    const s = run([main('UserPromptSubmit'), ask, main('UiWorking')]);
    assert.equal(s.state, ATTENTION, `UiWorking after ${ask.hook_event_name} ${ask.tool_name || ''}`);
  }
});

test('UiWorking during a turn changes nothing', () => {
  const s = run([main('UserPromptSubmit'), main('UiWorking')]);
  assert.equal(s.reason, 'prompt');
});

test('idle_prompt is the safety net: it forces attention when no background work runs', () => {
  assert.equal(run([main('UserPromptSubmit'), main('Notification', { notification_type: 'idle_prompt' })]).state, ATTENTION);
});

test('idle_prompt with background work running stays working', () => {
  const s = run([main('UserPromptSubmit'), sub('SubagentStart', 'a1'), main('Notification', { notification_type: 'idle_prompt' })]);
  assert.equal(s.state, WORKING);
});

test('notifications that do not need you change nothing', () => {
  assert.equal(run([main('UserPromptSubmit'), main('Notification', { notification_type: 'auth_success' })]).state, WORKING);
});

test('StopFailure (API error) needs attention', () => {
  assert.equal(run([main('UserPromptSubmit'), main('StopFailure')]).state, ATTENTION);
});

test('SessionStart clears background work left over from a previous process, except on compact', () => {
  const s = run([main('UserPromptSubmit'), sub('SubagentStart', 'a1')]);
  assert.deepEqual(ids(run([main('SessionStart', { source: 'resume' })], s)), []);
  assert.equal(run([main('SessionStart', { source: 'resume' })], s).state, ATTENTION);
  const compacted = run([main('SessionStart', { source: 'compact' })], s);
  assert.equal(compacted.state, WORKING);
  assert.deepEqual(ids(compacted), ['a1']);
});

test('SessionEnd ends tracking', () => {
  assert.equal(run([main('UserPromptSubmit'), main('SessionEnd')]), null);
});

test('osc gives the working and standby colors, and resets to the profile for attention', () => {
  assert.equal(osc(WORKING), `11;${CONFIG.workingColor}`);
  assert.equal(osc(STANDBY), `11;${CONFIG.standbyColor}`);
  assert.notEqual(CONFIG.standbyColor, CONFIG.workingColor);
  assert.equal(osc(ATTENTION), '111');
});

// ps -A -o pid=,ppid=,tty= on macOS ('??' for none) and Linux ('?').
test('ancestorTtyFrom finds the nearest ancestor with a terminal', () => {
  const mac = ['  1     0 ??', ' 500     1 ttys003', ' 600   500 ttys003', ' 700   600 ??', ' 800   700 ??'].join('\n');
  assert.equal(ancestorTtyFrom(mac, 800), '/dev/ttys003');
  const linux = ['1 0 ?', '40 1 pts/2', '41 40 ?', '42 41 ?'].join('\n');
  assert.equal(ancestorTtyFrom(linux, 42), '/dev/pts/2');
});

test('ancestorTtyFrom returns null when no ancestor has a terminal, or the pid is unknown', () => {
  assert.equal(ancestorTtyFrom('1 0 ??\n2 1 ??\n3 2 ??', 3), null);
  assert.equal(ancestorTtyFrom('1 0 ??', 99), null);
  assert.equal(ancestorTtyFrom('', 1), null);
});

test("ancestorTtyFrom ignores the process's own terminal and stops at a loop", () => {
  assert.equal(ancestorTtyFrom('5 6 ttys009\n6 5 ??', 5), null);
});

test('detectTerminal names the terminal from the environment Claude inherits', () => {
  assert.deepEqual(detectTerminal({ WT_SESSION: 'x' }), { name: 'Windows Terminal', support: 'confirmed' });
  assert.equal(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }).name, 'iTerm2');
  assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }).support, 'unknown');
  assert.equal(detectTerminal({ TERM: 'xterm-kitty' }).name, 'kitty');
  assert.equal(detectTerminal({ VTE_VERSION: '7600' }).support, 'expected');
  assert.equal(detectTerminal({ TERM_PROGRAM: 'mintty' }).name, 'mintty (Git Bash window)');
});

test('detectTerminal puts a multiplexer or editor ahead of the window it runs in', () => {
  // tmux inside iTerm2 is what decides whether the code gets through.
  assert.equal(detectTerminal({ TMUX: '/tmp/tmux', TERM_PROGRAM: 'iTerm.app' }).name, 'tmux');
  // VS Code's terminal inherits WT_SESSION when VS Code was started from Windows Terminal.
  assert.equal(detectTerminal({ TERM_PROGRAM: 'vscode', WT_SESSION: 'x' }).name, 'VS Code');
});

test('detectTerminal falls back to what the environment names, then to unknown', () => {
  assert.deepEqual(detectTerminal({}, 'linux'), { name: 'unknown', support: 'unknown' });
  assert.deepEqual(detectTerminal({ TERM: 'xterm-256color' }, 'linux'), { name: 'xterm-256color', support: 'unknown' });
  assert.deepEqual(detectTerminal({ TERM_PROGRAM: 'Hyper' }, 'darwin'), { name: 'Hyper', support: 'unknown' });
  assert.deepEqual(detectTerminal({}, 'win32'), { name: 'Windows console (conhost)', support: 'unknown' });
});

test('a manual /compact ends once, though PostCompact and SessionStart (compact) both arrive', () => {
  const s = run([
    main('PreCompact', { trigger: 'manual' }),
    main('PostCompact', { trigger: 'manual' }),
    main('SessionStart', { source: 'compact' }),
  ]);
  assert.equal(s.state, ATTENTION);
  assert.equal(s.reason, 'compact-done');
});

test('UiWorking turns working only from a finished state, never from a fresh one', () => {
  // A mod loaded into a session glance hasn't seen starts from init: no turn to trust.
  assert.equal(run([main('UiWorking')]).state, ATTENTION);
  for (const done of [
    [main('Stop')],
    [main('UserPromptSubmit'), main('Notification', { notification_type: 'idle_prompt' })],
    [main('PreCompact', { trigger: 'manual' }), main('PostCompact', { trigger: 'manual' })],
  ]) {
    const s = run([...done, main('UiWorking')]);
    assert.equal(s.state, WORKING, `UiWorking after ${done.map((e) => e.hook_event_name).join(', ')}`);
  }
});

test('UiIdle with no idle_since waits out the confirm window from the last hook', () => {
  const s = run([main('UserPromptSubmit', { at: T })]);
  assert.equal(run([{ hook_event_name: 'UiIdle', at: T + 500 }], s).state, WORKING);
});

// Stop and SubagentStop carry background_tasks: everything Claude Code still
// has in flight (captured 2026-11-09, Claude Code 2.1.319).
const task = (id, type = 'shell') => ({ id, type, status: 'running', description: 'x' });

test('a shell a subagent started is dropped at Stop once Claude Code no longer lists it', () => {
  // Seen live: three subagents each ran a background shell that ended within
  // seconds. No hook reports that end, and the pane stayed tinted for 28 minutes.
  const s = run([
    main('UserPromptSubmit'),
    sub('SubagentStart', 'a1'),
    sub('PostToolUse', 'a1', { tool_name: 'Bash', tool_response: { backgroundTaskId: 'bg1' } }),
    sub('SubagentStop', 'a1'),
    main('Stop', { background_tasks: [] }),
  ]);
  assert.equal(s.state, ATTENTION);
  assert.deepEqual(ids(s), []);
});

test('Stop keeps the background work Claude Code still lists, and notes when it was listed', () => {
  const s = run([main('UserPromptSubmit'), bgShell('dev'), bgShell('gone'), main('Stop', { background_tasks: [task('dev')] })]);
  assert.equal(s.state, STANDBY);
  assert.deepEqual(ids(s), ['dev']);
  assert.equal(s.background.dev.seen, s.updatedAt);
});

test('Stop adds background work Claude Code lists that glance never heard start', () => {
  const s = run([main('UserPromptSubmit'), main('Stop', { background_tasks: [task('a9', 'subagent'), task('b9'), task('m9', 'MCP task')] })]);
  assert.equal(s.state, WORKING);
  assert.deepEqual(
    Object.entries(s.background).map(([id, item]) => [id, item.kind]),
    [
      ['a9', 'agent'],
      ['b9', 'shell'],
      ['m9', 'MCP-task'],
    ],
  );
});

test('a workflow Claude Code lists holds the working color, and a monitor only standby', () => {
  assert.equal(run([main('Stop', { background_tasks: [task('w1', 'workflow')] })]).state, WORKING);
  assert.equal(run([main('Stop', { background_tasks: [task('m1', 'monitor')] })]).state, STANDBY);
});

test('Stop with no task list (an older Claude Code) keeps what glance tracked', () => {
  const s = run([main('UserPromptSubmit'), bgShell('dev'), sub('SubagentStart', 'a1'), main('Stop')]);
  assert.deepEqual(ids(s), ['dev', 'a1']);
  assert.equal(s.background.dev.seen, undefined);
});

test('SubagentStop drops what is no longer listed, and the stopping agent though it still lists itself', () => {
  const s = run([
    main('UserPromptSubmit'),
    sub('SubagentStart', 'a1'),
    sub('SubagentStart', 'a2'),
    bgShell('gone'),
    sub('SubagentStop', 'a1', { background_tasks: [task('a1', 'subagent'), task('a2', 'subagent')] }),
  ]);
  assert.deepEqual(ids(s), ['a2']);
});

test('the task list never touches scheduled runs, which it does not hold', () => {
  const s = run([{ ...wakeup(T + 240_000, 'loop'), at: T }, main('Stop', { background_tasks: [], at: T + 1000 })]);
  assert.equal(s.state, WORKING);
  assert.deepEqual(ids(s), ['wakeup']);
});

test('a subagent and a shell together hold working, and the shell alone holds standby once the agent ends', () => {
  const both = run([main('UserPromptSubmit'), bgShell('dev'), sub('SubagentStart', 'a1'), main('Stop')]);
  assert.equal(both.state, WORKING);
  const after = run([sub('SubagentStop', 'a1'), main('UserPromptSubmit', { prompt: notice('a1', 'completed') }), main('Stop')], both);
  assert.equal(after.state, STANDBY);
  assert.deepEqual(ids(after), ['dev']);
});

test('idle_prompt with only a shell running is standby, never working', () => {
  const s = run([main('UserPromptSubmit'), bgShell('dev'), main('Notification', { notification_type: 'idle_prompt' })]);
  assert.equal(s.state, STANDBY);
});

test('a question or a permission prompt shows needs you, whatever runs in the background', () => {
  const standby = run([main('UserPromptSubmit'), bgShell('dev'), main('Stop')]);
  assert.equal(run([main('UserPromptSubmit'), main('PermissionRequest')], standby).state, ATTENTION);
  assert.equal(run([main('Notification', { notification_type: 'permission_prompt' })], standby).state, ATTENTION);
});

test('bash mode turns a standby pane working, and it goes back to standby on Stop', () => {
  const standby = run([main('UserPromptSubmit'), bgShell('dev'), main('Stop')]);
  const busy = run([main('UiWorking')], standby);
  assert.equal(busy.state, WORKING);
  assert.equal(run([main('Stop')], busy).state, STANDBY);
});

// Tick comes from the mod at the moment recheckAt() named: no event arrives
// when background work expires in an idle session.
const tick = (at) => ({ hook_event_name: 'Tick', at });

test('Tick clears a standby pane once its shell has expired', () => {
  const s = run([main('UserPromptSubmit', { at: T }), { ...bgShell('dev'), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(run([tick(T + CONFIG.shellTtlMs - 1)], s).state, STANDBY);
  const expired = run([tick(T + CONFIG.shellTtlMs + 1)], s);
  assert.equal(expired.state, ATTENTION);
  assert.equal(expired.reason, 'expired');
  assert.deepEqual(ids(expired), []);
});

test('Tick clears a working pane held by a subagent that expired, and one held by a missed wakeup', () => {
  const agent = run([main('UserPromptSubmit', { at: T }), { ...sub('SubagentStart', 'a1'), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(run([tick(T + CONFIG.agentTtlMs + 1)], agent).state, ATTENTION);
  const loop = run([{ ...wakeup(T + 240_000, 'loop'), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(run([tick(T + 240_000)], loop).state, WORKING);
  assert.equal(run([tick(T + 240_000 + 121_000)], loop).state, ATTENTION);
});

test('Tick tints a finished pane when a scheduled run comes within the hour', () => {
  const s = run([{ ...cron('c1', T + 2 * 3600_000, '0 9 * * *', true), at: T }, main('Stop', { at: T + 1000 })]);
  assert.equal(s.state, ATTENTION);
  assert.equal(run([tick(T + 30 * 60_000)], s).state, ATTENTION);
  const near = run([tick(T + 3600_000 + 1000)], s);
  assert.equal(near.state, WORKING);
  assert.equal(near.reason, 'background-running');
});

test('Tick never covers a question or changes a turn in progress', () => {
  const soon = { ...wakeup(T + 240_000, 'loop'), at: T };
  const asked = run([soon, main('PreToolUse', { tool_name: 'AskUserQuestion' }), tick(T + 5000)]);
  assert.equal(asked.state, ATTENTION);
  assert.equal(asked.reason, 'asking');
  // Mid-turn, an expired shell changes nothing: the turn's own Stop decides.
  const midTurn = run([main('UserPromptSubmit', { at: T }), { ...bgShell('dev'), at: T }, tick(T + CONFIG.shellTtlMs + 1)]);
  assert.equal(midTurn.state, WORKING);
  assert.equal(midTurn.reason, 'tool-done');
});

test('Tick leaves a pane /glance-fix reset on needs you, even with a scheduled run due', () => {
  const s = {
    ...emptyState(),
    reason: 'reset',
    updatedAt: T,
    background: { wakeup: { kind: 'wakeup', at: T, dueAt: T + 240_000, prompt: 'p' } },
  };
  assert.equal(decide(s, tick(), T + 1000).state, ATTENTION);
});

test('recheckAt names the next moment time alone changes the pane', () => {
  assert.equal(recheckAt({ background: {} }, T), null);
  assert.equal(recheckAt(null, T), null);
  const shell = { background: { b1: { kind: 'shell', at: T }, a1: { kind: 'agent', at: T } } };
  assert.equal(recheckAt(shell, T + 5), T + CONFIG.shellTtlMs);
  // A wakeup due soon: the moment it counts as missed (2 minutes late).
  const soon = { background: { wakeup: { kind: 'wakeup', at: T, dueAt: T + 240_000 } } };
  assert.equal(recheckAt(soon, T), T + 240_000 + 120_000);
  // One due in three hours: the moment it comes within the hour.
  const far = { background: { wakeup: { kind: 'wakeup', at: T, dueAt: T + 3 * 3600_000 } } };
  assert.equal(recheckAt(far, T), T + 2 * 3600_000);
});

test('the state line carries the standby color and when to check back, and neither for a plain state', () => {
  assert.deepEqual(JSON.parse(stateLine({ state: WORKING, background: {} }, T)), { state: WORKING, color: CONFIG.workingColor });
  assert.deepEqual(JSON.parse(stateLine(null, T)), { state: ATTENTION, color: CONFIG.workingColor });
  const standby = { state: STANDBY, background: { b1: { kind: 'shell', at: T } } };
  assert.deepEqual(JSON.parse(stateLine(standby, T)), { state: STANDBY, color: CONFIG.standbyColor, recheck_in_ms: CONFIG.shellTtlMs });
  // Never sooner than the floor, so a check that changes nothing can't loop.
  assert.equal(JSON.parse(stateLine(standby, T + CONFIG.shellTtlMs + 5000)).recheck_in_ms, CONFIG.recheckMinMs);
});

test('/glance-fix on a standby pane names the shell Claude Code listed as running, not a bug', () => {
  const s = run([main('UserPromptSubmit'), bgShell('dev'), main('Stop', { background_tasks: [task('dev')] })]);
  assert.equal(s.state, STANDBY);
  const d = diagnoseReset(s, main('GlanceReset', { live_agents: [] }), s.updatedAt + 5 * MIN);
  assert.equal(d.verdict, 'background-running');
  assert.equal(d.suspect, false);
  assert.match(d.cause, /shell dev \(started 5 min ago, listed as running 5 min ago\)/);
  // The reset still drops it: the pane is yours to clear.
  assert.deepEqual(ids(run([main('GlanceReset', { live_agents: [] })], s)), []);
});
