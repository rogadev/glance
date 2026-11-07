import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, emptyState, endedTaskIds, osc, CONFIG, WORKING, ATTENTION } from '../glance.mjs';

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
// no SubagentStop and shells get no hook at all, so this is the only end signal.
const notice = (id, status = 'killed') =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n` +
  `<output-file>C:\\tmp\\tasks\\${id}.output</output-file>\n<status>${status}</status>\n` +
  `<summary>x</summary>\n</task-notification>`;

// A Bash call with run_in_background, as PostToolUse reports it.
const bgShell = (id) =>
  main('PostToolUse', { tool_name: 'Bash', tool_input: { run_in_background: true }, tool_response: { backgroundTaskId: id } });

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

test('a background shell (for example a CI watch) keeps the pane working after Stop', () => {
  const waiting = run([main('UserPromptSubmit'), bgShell('b37q4qei1'), main('Stop')]);
  assert.equal(waiting.state, WORKING);
  assert.deepEqual(ids(waiting), ['b37q4qei1']);
  // Its completion arrives as a prompt; the turn that handles it ends with Stop.
  const done = run([main('UserPromptSubmit', { prompt: notice('b37q4qei1', 'completed') }), main('Stop')], waiting);
  assert.equal(done.state, ATTENTION);
  assert.deepEqual(ids(done), []);
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

test('TurnAborted with background work still running stays working', () => {
  const s = run([main('UserPromptSubmit'), bgShell('ci'), main('TurnAborted')]);
  assert.equal(s.state, WORKING);
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
  const s = run([main('UserPromptSubmit', { at: T }), { ...bgShell('ci'), at: T + 100 }, main('Stop', { at: T + 200 })]);
  assert.equal(run([titleIdle(T + 300, T + 60_000)], s).state, WORKING);
});

test('TitleIdle never turns the pane to working', () => {
  const s = run([main('UserPromptSubmit', { at: T }), main('Stop', { at: T + 100 })]);
  const after = run([titleIdle(T + 200, T + 60_000)], s);
  assert.equal(after.state, ATTENTION);
  assert.equal(after.reason, 'stop');
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

test('osc gives the working color, and resets to the profile for attention', () => {
  assert.equal(osc(WORKING), `11;${CONFIG.workingColor}`);
  assert.equal(osc(ATTENTION), '111');
});
