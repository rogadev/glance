import { expect, mock, test } from 'claude-code/testing'
import {
  asUpdateCheck,
  cannotStart,
  checkDue,
  describe,
  describeCheck,
  isNewer,
  marketplaceOf,
  parsePane,
  recheckOf,
  reportPrompt,
  runUpdateCheck,
  snapshotOf,
  updateGlance,
  updateNotice,
} from '../hooks/register'

// Nothing sits beneath the plugin: each hook here stands for the engine.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], runs: any[], stdout = '') {
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_, e) => {
    runs.push(e)
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

const stdinOf = (run: any) => JSON.parse(run.init.stdin)
const turn = { answer: '', durationMs: 5, turnId: 't1' }

test('an Esc on the main loop hands TurnAborted to glance', async ($, on) => {
  const runs: any[] = []
  engine(on, runs)
  await $.turn.complete({ ...turn, isAborted: true, reason: 'aborted' })
  await new Promise((r) => setTimeout(r, 0))
  expect(runs.length).toBe(1)
  expect(runs[0].argv[0]).toBe('node')
  expect(String(runs[0].argv[1])).toMatch(/[\\/]glance\.mjs$/)
  expect(stdinOf(runs[0])).toEqual({ hook_event_name: 'TurnAborted', session_id: 'sess-1', glance_via: 'mod' })
})

test('a normal answer and a subagent abort run nothing', async ($, on) => {
  const runs: any[] = []
  engine(on, runs)
  await $.turn.complete({ ...turn, isAborted: false, reason: 'answer' })
  await $.turn.complete({ ...turn, isAborted: true, reason: 'aborted', agentId: 'a1' })
  await new Promise((r) => setTimeout(r, 0))
  expect(runs.length).toBe(0)
})

test('settings-hook events reach glance.mjs whole, before the hooks beneath', async ($, on) => {
  const runs: any[] = []
  engine(on, runs)
  on('classic.Stop', () => ({}))
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(runs.length).toBe(1)
  const sent = stdinOf(runs[0])
  expect(sent.hook_event_name).toBe('Stop')
  expect(sent.session_id).toBe('sess-1')
  expect(sent.glance_via).toBe('mod')
})

test('/compact reaches glance.mjs: it runs no turn, so these two events are all glance hears', async ($, on) => {
  const runs: any[] = []
  engine(on, runs)
  on('classic.PreCompact', () => ({}))
  on('classic.PostCompact', () => ({}))
  await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null })
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'summary' })
  expect(runs.map(stdinOf).map((s) => [s.hook_event_name, s.trigger])).toEqual([
    ['PreCompact', 'manual'],
    ['PostCompact', 'manual'],
  ])
})

test('a tool call reaches glance.mjs as PreToolUse, with the subagent id when there is one', async ($, on) => {
  const runs: any[] = []
  engine(on, runs)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  const pre = runs.map(stdinOf).filter((s) => s.hook_event_name === 'PreToolUse')
  expect(pre).toEqual([
    { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Bash', glance_via: 'mod' },
    { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Bash', agent_id: 'a1', glance_via: 'mod' },
  ])
})

test('/glance-fix sends GlanceReset with only the running agents and reports the result', async ($, on) => {
  const runs: any[] = []
  const out = { was: 'working [background-running]', dropped: ['shell b1'], kept: ['agent a1'], paint: 'ok' }
  engine(on, runs, JSON.stringify(out) + '\n')
  on('agent.list', () => ({
    value: [
      { id: 'a1', status: 'running', description: '', type: 'Explore' },
      { id: 'a2', status: 'completed', description: '', type: 'Explore' },
    ],
  }))
  on('command.run', () => ({ text: 'engine ran it' }))
  const r = await $.command.run({ command: 'glance-fix' })
  expect(runs.length).toBe(1)
  expect(stdinOf(runs[0])).toEqual({
    hook_event_name: 'GlanceReset',
    session_id: 'sess-1',
    live_agents: ['a1'],
    glance_via: 'mod',
  })
  expect(r.text).toContain('Dropped: shell b1.')
  expect(r.text).toContain('Kept (still running): agent a1.')
})

const fixed = (suspect: boolean) =>
  JSON.stringify({
    was: 'working [tool]',
    dropped: [],
    kept: [],
    paint: 'ok',
    diagnosis: { verdict: suspect ? 'missed-end' : 'stale-background', suspect, cause: 'The cause in words.' },
    snapshot: '/home/u/.claude/state/glance/fix-sess-1.json',
  })

test('/glance-fix shows the cause, and suggests /glance-report only for a suspected bug', () => {
  const bug = describe(fixed(true))
  expect(bug).toContain('The cause in words.')
  expect(bug).toContain('/glance-report')
  const fine = describe(fixed(false))
  expect(fine).toContain('The cause in words.')
  expect(fine).not.toContain('/glance-report')
})

test('/glance-report with no /glance-fix asks Claude to ask what went wrong', () => {
  expect(reportPrompt('')).toContain('glance:report-issue')
  expect(reportPrompt('')).toContain('ask me what went wrong')
})

test('/glance-report asks Claude to run the report skill on the last /glance-fix snapshot', async ($, on) => {
  const runs: any[] = []
  const prompts: any[] = []
  engine(on, runs, fixed(true) + '\n')
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', (_, e) => (prompts.push(e), { text: e.text }))
  engineBand(on)
  on('command.run', () => ({ text: 'engine ran it' }))
  await $.command.run({ command: 'glance-fix' })
  const r = await $.command.run({ command: 'glance-report' })
  expect(prompts.length).toBe(0)
  // The prompt goes in at the first draw of the prompt area with the engine
  // idle, and only once (live: test/live/run.mjs report).
  const draw = (isWorking: boolean) => $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking } })
  await draw(true)
  expect(prompts.length).toBe(0)
  await draw(false)
  await draw(false)
  await new Promise((res) => setTimeout(res, 0))
  expect(prompts.length).toBe(1)
  expect(prompts[0].text).toContain('glance:report-issue')
  expect(prompts[0].text).toContain('/home/u/.claude/state/glance/fix-sess-1.json')
  expect(r.text).toContain('draft')
})

const WORKING = JSON.stringify({ state: 'working', color: '#1F2D3D' }) + '\n'
const ATTENTION = JSON.stringify({ state: 'attention', color: '#1F2D3D' }) + '\n'
const STANDBY = JSON.stringify({ state: 'standby', color: '#161D25' }) + '\n'

// The engine's own drawing of the band, beneath the plugin: one line reading "engine".
function engineBand(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.log', () => ({ value: undefined }))
}

const BAND = {
  plugin: 'glance',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the desktop shows a working band while glance says working, and nothing once it needs you', async ($, on) => {
  let stdout = WORKING
  engineBand(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout, stderr: '' } }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))

  await $.classic.UserPromptSubmit({ session_id: 'sess-1', prompt: 'hi' })
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Claude is working/ }))?.text).toBe('Claude is working')
  await ui.unmount()

  stdout = ATTENTION
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Claude is working/ })).toBeUndefined()
  await ui.unmount()
})

test('the terminal gets no band: glance.mjs tints the pane there', async ($, on) => {
  engineBand(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: WORKING, stderr: '' } }))
  on('classic.UserPromptSubmit', () => ({}))

  await $.classic.UserPromptSubmit({ session_id: 'sess-1', prompt: 'hi' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Claude is working/ })).toBeUndefined()
  await ui.unmount()
})

test('no state line (an older glance.mjs) leaves the band as it was', async ($, on) => {
  engineBand(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('classic.UserPromptSubmit', () => ({}))

  await $.classic.UserPromptSubmit({ session_id: 'sess-1', prompt: 'hi' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Claude is working/ })).toBeUndefined()
  await ui.unmount()
})

test('the band reports the engine starting and stopping work, once per change', async ($, on) => {
  const runs: any[] = []
  engineBand(on)
  engine(on, runs, ATTENTION)
  const clock = mock.clock(on)
  const sent = () => runs.map(stdinOf).map((s) => s.hook_event_name).filter((n) => n.startsWith('Ui'))
  const draw = async (isWorking: boolean, settle: number) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking } })
    await clock.advance(settle)
    await ui.unmount()
  }

  await draw(false, 10)
  const before = sent().length
  // Working long enough counts; the stop after it is sent at once.
  await draw(true, 1700)
  await draw(false, 10)
  expect(sent().slice(before)).toEqual(['UiWorking', 'UiIdle'])
  // The same value again sends nothing.
  await draw(false, 10)
  expect(sent().length).toBe(before + 2)
  // A flip shorter than the settle time (as /exit makes) sends only the stop.
  await draw(true, 100)
  await draw(false, 1700)
  expect(sent().slice(before + 2)).toEqual(['UiIdle'])
})

test('/glance-check sends GlanceCheck with the surface and explains the report', async ($, on) => {
  const runs: any[] = []
  const report = {
    version: '0.1.0',
    platform: 'darwin arm64',
    node: 'v22.0.0',
    surface: 'terminal',
    terminal: { name: 'iTerm2', support: 'expected' },
    painter: 'tty',
    flash: 'ok',
    restore: 'ok',
    state: 'attention [stop]',
    background: 0,
  }
  engine(on, runs, JSON.stringify(report) + '\n')
  engineBand(on)
  on('command.run', () => ({ text: 'engine ran it' }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  await ui.unmount()
  const r = await $.command.run({ command: 'glance-check' })
  const sent = runs.map(stdinOf).find((s) => s.hook_event_name === 'GlanceCheck')
  expect(sent).toEqual({ hook_event_name: 'GlanceCheck', session_id: 'sess-1', surface: 'terminal', glance_via: 'mod' })
  expect(r.text).toContain('Did you see the background change')
  expect(r.text).toContain('iTerm2: should work')
})

test("glance's own commands don't count as Claude working, and the hold ends with the command", async ($, on) => {
  const runs: any[] = []
  let release = () => {}
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_, e) => {
    runs.push(e)
    const report = JSON.stringify({ surface: 'terminal', flash: 'ok', restore: 'ok', state: 'attention [stop]' })
    const done = { value: { exitCode: 0, stdout: ATTENTION + report + '\n', stderr: '' } }
    if (stdinOf(e).hook_event_name !== 'GlanceCheck') return done
    return new Promise((resolve) => (release = () => resolve(done))) as never
  })
  on('command.run', () => ({ text: 'engine ran it' }))
  engineBand(on)
  const clock = mock.clock(on)
  const sent = () => runs.map(stdinOf).map((s) => s.hook_event_name).filter((n) => n.startsWith('Ui'))
  const draw = async (isWorking: boolean, settle: number) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking } })
    await clock.advance(settle)
    await ui.unmount()
  }

  await draw(false, 10)
  const before = sent().length
  const check = $.command.run({ command: 'glance-check' })
  await draw(true, 1700)
  expect(sent().slice(before)).toEqual([])
  release()
  await check
  await draw(false, 10)
  await draw(true, 1700)
  expect(sent().slice(before)).toEqual(['UiIdle', 'UiWorking'])
})

test('a glance.mjs that cannot start never holds Claude up, and warns once', async ($, on) => {
  const stops: unknown[] = []
  const toasts: unknown[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ deny: NOT_FOUND }) as never)
  on('ui.toast', (_, e) => (toasts.push(e), { value: undefined }) as never)
  on('classic.Stop', (_, e) => (stops.push(e), {}))
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(stops.length).toBe(2)
  expect(toasts.length).toBe(1)
  expect(JSON.stringify(toasts[0])).toContain('Node.js')
})

// The engine's own wording, from a probe mod (Claude Code 2.1.319). A hook's
// { deny } makes $.process.run reject with it; a thrown error would not.
const NOT_FOUND = "glance: $.process.run(node) failed to start: ENOENT: Command 'node' not found or is in an unsafe location (current directory)"
const TIMED_OUT = 'glance: $.process.run(node) aborted: still running after 5000ms'

test('a glance.mjs run that times out never blames Node.js, and is logged', async ($, on) => {
  const toasts: unknown[] = []
  const logs: string[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ deny: TIMED_OUT }) as never)
  on('ui.toast', (_, e) => (toasts.push(e), { value: undefined }) as never)
  on('ui.log', (_, e) => (logs.push(e.text), { value: undefined }) as never)
  on('classic.Stop', () => ({}))
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(toasts.length).toBe(0)
  expect(logs.some((l) => l.includes('still running after 5000ms'))).toBe(true)
})

test('/glance-fix and /glance-check blame Node.js only when it cannot start', async ($, on) => {
  let deny = TIMED_OUT
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ deny }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('command.run', () => ({ text: 'engine ran it' }))
  for (const command of ['glance-fix', 'glance-check']) {
    const slow = await $.command.run({ command })
    expect(slow.text).toContain("didn't finish in time")
    expect(slow.text).not.toContain('Node.js')
  }
  deny = NOT_FOUND
  for (const command of ['glance-fix', 'glance-check']) {
    expect((await $.command.run({ command })).text).toContain('Is Node.js installed')
  }
})

test('a /glance-fix that fails leaves /glance-report no older snapshot', async ($, on) => {
  let fail = false
  const prompts: any[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => (fail ? { deny: TIMED_OUT } : { value: { exitCode: 0, stdout: fixed(true) + '\n', stderr: '' } }) as never)
  on('prompt.submit', (_, e) => (prompts.push(e), { text: e.text }))
  engineBand(on)
  on('command.run', () => ({ text: 'engine ran it' }))
  await $.command.run({ command: 'glance-fix' })
  fail = true
  await $.command.run({ command: 'glance-fix' })
  await $.command.run({ command: 'glance-report' })
  await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  await new Promise((res) => setTimeout(res, 0))
  expect(prompts.length).toBe(1)
  expect(prompts[0].text).not.toContain('fix-sess-1.json')
  expect(prompts[0].text).toContain('ask me what went wrong')
})

test('a refused /glance-report prompt is logged, told to the user, and not retried', async ($, on) => {
  const logs: string[] = []
  const toasts: unknown[] = []
  let submits = 0
  // engineBand's own ui.log would clash with the one that collects logs here.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  on('prompt.submit', () => (submits++, { drop: 'a turn is in flight' }))
  on('ui.log', (_, e) => (logs.push(e.text), { value: undefined }) as never)
  on('ui.toast', (_, e) => (toasts.push(e), { value: undefined }) as never)
  on('command.run', () => ({ text: 'engine ran it' }))
  await $.command.run({ command: 'glance-report' })
  const idle = () => $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  await idle()
  await idle()
  await new Promise((res) => setTimeout(res, 0))
  expect(submits).toBe(1)
  expect(logs.filter((l) => l.includes('could not submit its prompt')).length).toBe(1)
  expect(toasts.length).toBe(1)
  expect(JSON.stringify(toasts[0])).toContain('/glance:report-issue')
})

test('a /glance-report prompt the engine rejects is logged and told to the user too', async ($, on) => {
  const logs: string[] = []
  const toasts: unknown[] = []
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  // No prompt.submit hook: with nothing to answer it, $.prompt.submit rejects.
  on('ui.log', (_, e) => (logs.push(e.text), { value: undefined }) as never)
  on('ui.toast', (_, e) => (toasts.push(e), { value: undefined }) as never)
  on('command.run', () => ({ text: 'engine ran it' }))
  await $.command.run({ command: 'glance-report' })
  const idle = () => $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: false } })
  await idle()
  await idle()
  await new Promise((res) => setTimeout(res, 0))
  expect(logs.filter((l) => l.includes('could not submit its prompt')).length).toBe(1)
  expect(toasts.length).toBe(1)
  expect(JSON.stringify(toasts[0])).toContain('/glance:report-issue')
})

test('a timeout does not use up the missing-Node.js notice', async ($, on) => {
  const toasts: unknown[] = []
  let calls = 0
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ deny: ++calls === 1 ? TIMED_OUT : NOT_FOUND }) as never)
  on('ui.toast', (_, e) => (toasts.push(e), { value: undefined }) as never)
  on('classic.Stop', () => ({}))
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(toasts.length).toBe(1)
  expect(JSON.stringify(toasts[0])).toContain('Node.js')
})

test('a pane state that cannot be saved is logged, and never blamed on Node.js', async ($, on) => {
  const toasts: unknown[] = []
  const logs: string[] = []
  const stops: unknown[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: WORKING, stderr: '' } }))
  on('state.set', () => ({ deny: 'state store unavailable' }) as never)
  on('ui.toast', (_, e) => (toasts.push(e), { value: undefined }) as never)
  on('ui.log', (_, e) => (logs.push(e.text), { value: undefined }) as never)
  on('classic.Stop', (_, e) => (stops.push(e), {}))
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  expect(stops.length).toBe(1)
  expect(toasts.length).toBe(0)
  expect(logs.filter((l) => l.includes('could not save the pane state')).length).toBe(1)
})

test('snapshotOf finds no snapshot in empty, broken, or snapshot-less output', () => {
  expect(snapshotOf('')).toBe('')
  expect(snapshotOf('not json')).toBe('')
  expect(snapshotOf('{}')).toBe('')
  expect(snapshotOf('{"snapshot":"/s/fix-1.json"}\n')).toBe('/s/fix-1.json')
})

test('only a command that cannot start counts as a missing Node.js', () => {
  expect(cannotStart(new Error(NOT_FOUND))).toBe(true)
  expect(cannotStart(new Error(TIMED_OUT))).toBe(false)
  expect(cannotStart(new Error('something else'))).toBe(false)
  expect(cannotStart(undefined)).toBe(false)
})

test('/glance-check names the step that failed, and warns when the pane may be left busy', async () => {
  const base = { surface: 'terminal', painter: 'tty', flash_ms: 1500, state: 'attention [stop]', background: 0 }
  const say = (r: object) => describeCheck(JSON.stringify({ ...base, ...r }))
  expect(say({ flash: 'ok', restore: 'ok' })).toContain('for 1.5 seconds')
  expect(say({ flash: 'ok', restore: 'ok' })).toContain('Now: needs you [stop]')
  expect(say({ flash: 'paint-failed:tty-ENXIO,no-ancestor-tty', restore: 'paint-failed:x' })).toContain(
    "couldn't paint this pane (paint-failed:tty-ENXIO,no-ancestor-tty)",
  )
  const restoreFailed = say({ flash: 'ok', restore: 'paint-failed:write-failed' })
  expect(restoreFailed).toContain("couldn't put the pane back (paint-failed:write-failed)")
  expect(restoreFailed).toContain('/glance-fix')
  const desktop = say({ surface: 'desktop', flash: 'paint-failed:no-claude-ancestor', restore: 'paint-failed:no-claude-ancestor' })
  expect(desktop).toContain('In Claude Desktop')
  expect(desktop).toContain('Terminal: none (Claude Desktop)')
  expect(desktop).not.toContain('Painter:')
  expect(describeCheck('not json')).toContain('gave no report')
})

test('parsePane takes only a well-formed state line', async () => {
  expect(parsePane('{"state":"working","color":"#1F2D3D"}\n{"was":"x"}')).toEqual({ state: 'working', color: '#1F2D3D' })
  expect(parsePane('{"state":"busy","color":"#1F2D3D"}')).toBeNull()
  expect(parsePane('{"state":"working"}')).toBeNull()
  expect(parsePane('')).toBeNull()
  expect(parsePane(STANDBY)).toEqual({ state: 'standby', color: '#161D25' })
})

test('recheckOf reads how long to wait for the Tick, and 0 when the state line asks for none', () => {
  expect(recheckOf('{"state":"standby","color":"#161D25","recheck_in_ms":60000}\n{"was":"x"}')).toBe(60000)
  expect(recheckOf(WORKING)).toBe(0)
  expect(recheckOf('{"recheck_in_ms":"soon"}')).toBe(0)
  expect(recheckOf('{"recheck_in_ms":-5}')).toBe(0)
  expect(recheckOf('')).toBe(0)
})

test('the desktop shows a dimmer band while only a background task runs', async ($, on) => {
  engineBand(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: STANDBY, stderr: '' } }))
  on('classic.Stop', () => ({}))
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /background task/ }))?.text).toBe('A background task is still running')
  expect(await ui.find({ type: 'Text', text: /Claude is working/ })).toBeUndefined()
  await ui.unmount()
})

test('a state line that asks to be checked on gets one Tick when its time comes, however many events asked', async ($, on) => {
  const runs: any[] = []
  let stdout = JSON.stringify({ state: 'standby', color: '#161D25', recheck_in_ms: 60_000 }) + '\n'
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_, e) => (runs.push(e), { value: { exitCode: 0, stdout, stderr: '' } }))
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on)
  const ticks = () => runs.map(stdinOf).filter((s) => s.hook_event_name === 'Tick')

  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  await clock.advance(59_000)
  expect(ticks().length).toBe(0)
  // The Tick's own answer asks for nothing more, so the timer ends with it.
  stdout = ATTENTION
  await clock.advance(3000)
  expect(ticks()).toEqual([{ hook_event_name: 'Tick', session_id: 'sess-1', glance_via: 'mod' }])
  await clock.advance(120_000)
  expect(ticks().length).toBe(1)
})

test('a state line that no longer asks to be checked on cancels the Tick', async ($, on) => {
  const runs: any[] = []
  let stdout = JSON.stringify({ state: 'standby', color: '#161D25', recheck_in_ms: 60_000 }) + '\n'
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', (_, e) => (runs.push(e), { value: { exitCode: 0, stdout, stderr: '' } }))
  on('classic.Stop', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  const clock = mock.clock(on)
  await $.classic.Stop({ session_id: 'sess-1', stop_hook_active: false })
  stdout = WORKING
  await $.classic.UserPromptSubmit({ session_id: 'sess-1', prompt: 'hi' })
  await clock.advance(120_000)
  expect(runs.map(stdinOf).filter((s) => s.hook_event_name === 'Tick').length).toBe(0)
})

test('a turn that is already working sends no UiWorking: it would change nothing', async ($, on) => {
  const runs: any[] = []
  engineBand(on)
  engine(on, runs, WORKING)
  on('classic.UserPromptSubmit', () => ({}))
  const clock = mock.clock(on)
  await $.classic.UserPromptSubmit({ session_id: 'sess-1', prompt: 'hi' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  await clock.advance(1700)
  await ui.unmount()
  expect(runs.map(stdinOf).filter((s) => s.hook_event_name === 'UiWorking').length).toBe(0)
})

test('an Esc glance cannot report still ends the turn with its answer', async ($, on) => {
  const logs: string[] = []
  on('session.id', () => ({ deny: 'no session' }) as never)
  on('ui.log', (_, e) => (logs.push(e.text), { value: undefined }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const r = await $.turn.complete({ ...turn, answer: 'done', isAborted: true, reason: 'aborted' })
  expect(r.text).toBe('done')
  expect(logs.some((l) => l.includes('could not report the Esc'))).toBe(true)
})

// The update check. ROOT is where a marketplace install of glance lives.
const ROOT = '/home/u/.claude/plugins/cache/glance/glance/0.2.0'
const DAY = 24 * 60 * 60 * 1000

test('isNewer compares x.y.z versions, and nothing else counts as newer', () => {
  expect(isNewer('0.3.0', '0.2.0')).toBe(true)
  expect(isNewer('0.10.0', '0.9.9')).toBe(true)
  expect(isNewer('1.0.0', '0.99.0')).toBe(true)
  expect(isNewer('0.2.0', '0.2.0')).toBe(false)
  expect(isNewer('0.1.9', '0.2.0')).toBe(false)
  expect(isNewer('0.3.0-beta', '0.2.0')).toBe(false)
  expect(isNewer('', '0.2.0')).toBe(false)
})

test('marketplaceOf reads the marketplace off an install folder, and gives none for a folder of its own', () => {
  expect(marketplaceOf(ROOT)).toBe('glance')
  expect(marketplaceOf(String.raw`C:\Users\u\.claude\plugins\cache\rogadev-glance\glance\0.2.0`)).toBe('rogadev-glance')
  expect(marketplaceOf(String.raw`C:\Users\u\Documents\GitHub\glance`)).toBe('')
  expect(marketplaceOf('/home/u/.claude/plugins/cache/glance/other/1.0.0')).toBe('')
})

test('checkDue fetches again only once a day has passed', () => {
  expect(checkDue({}, 5)).toBe(true)
  expect(checkDue({ checkedAt: 0, latest: '0.2.0' }, DAY - 1)).toBe(false)
  expect(checkDue({ checkedAt: 0, latest: '0.2.0' }, DAY)).toBe(true)
})

test('checkDue counts a check dated in the future as due, so a clock set back cannot hold off every check', () => {
  expect(checkDue({ checkedAt: 100 * DAY, latest: '0.2.0' }, 10 * DAY)).toBe(true)
})

test('asUpdateCheck keeps only the stored fields of the right type', () => {
  expect(asUpdateCheck(undefined)).toEqual({})
  expect(asUpdateCheck(null)).toEqual({})
  expect(asUpdateCheck('junk')).toEqual({})
  expect(asUpdateCheck({ checkedAt: 5, latest: '0.3.0' })).toEqual({ checkedAt: 5, latest: '0.3.0' })
  expect(asUpdateCheck({ checkedAt: '5', latest: 3 })).toEqual({})
})

test('a stored field of the wrong type is never trusted, and junk in the store is fetched again', async () => {
  const { io, seen } = updateIO({ saved: { checkedAt: 10 * DAY, latest: 42 } })
  await runUpdateCheck(io, ROOT)
  expect(seen.fetches.length).toBe(0)
  expect(seen.toasts.length).toBe(0)
  const junk = updateIO({ saved: 'junk' })
  await runUpdateCheck(junk.io, ROOT)
  expect(junk.seen.fetches.length).toBe(1)
  expect(junk.seen.toasts.length).toBe(1)
})

test('the update notice names both versions, the update command, and auto-update', () => {
  const text = updateNotice('0.3.0', '0.2.0')
  expect(text).toContain('0.3.0')
  expect(text).toContain('0.2.0')
  expect(text).toContain('/glance-update')
  expect(text).toContain('/reload-plugins')
  expect(text).toContain('auto-update')
})

/** A stand-in for the engine under the update check, recording what it did. */
function updateIO(opts: { latest?: string; ok?: boolean; env?: Record<string, string>; saved?: unknown } = {}) {
  const seen = { fetches: [] as string[], reads: [] as string[], logs: [] as string[], toasts: [] as string[], slept: 0, saved: opts.saved }
  const io = {
    env: async (name: string) => opts.env?.[name],
    readFile: async (path: string) => (seen.reads.push(path), JSON.stringify({ name: 'glance', version: '0.2.0' })),
    load: async () => seen.saved,
    save: async (check: unknown) => {
      seen.saved = check
    },
    fetch: async (url: string) => {
      seen.fetches.push(url)
      const ok = opts.ok ?? true
      return { ok, status: ok ? 200 : 404, text: ok ? JSON.stringify({ version: opts.latest ?? '0.3.0' }) : 'Not Found' }
    },
    now: async () => 10 * DAY,
    sleep: async (ms: number) => {
      seen.slept += ms
    },
    log: (text: string) => void seen.logs.push(text),
    toast: (text: string) => void seen.toasts.push(text),
  }
  return { io, seen }
}

test('a newer release is fetched once, saved for every window, and shown after a moment', async () => {
  const { io, seen } = updateIO()
  await runUpdateCheck(io, ROOT)
  expect(seen.reads).toEqual([`${ROOT}/.claude-plugin/plugin.json`])
  expect(seen.fetches).toEqual(['https://raw.githubusercontent.com/rogadev/glance/main/.claude-plugin/plugin.json'])
  expect(seen.saved).toEqual({ checkedAt: 10 * DAY, latest: '0.3.0' })
  expect(seen.slept).toBeGreaterThan(0)
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toContain('glance 0.3.0 is out (you have 0.2.0)')
})

test('a check saved today is used without fetching, and still shows the notice', async () => {
  const { io, seen } = updateIO({ saved: { checkedAt: 10 * DAY - 60_000, latest: '0.3.0' } })
  await runUpdateCheck(io, ROOT)
  expect(seen.fetches.length).toBe(0)
  expect(seen.toasts.length).toBe(1)
})

test('a check saved yesterday is fetched again', async () => {
  const { io, seen } = updateIO({ saved: { checkedAt: 9 * DAY - 1, latest: '0.2.0' }, latest: '0.4.0' })
  await runUpdateCheck(io, ROOT)
  expect(seen.fetches.length).toBe(1)
  expect(seen.toasts[0]).toContain('glance 0.4.0 is out')
})

test('an up-to-date glance shows nothing', async () => {
  const { io, seen } = updateIO({ latest: '0.2.0' })
  await runUpdateCheck(io, ROOT)
  expect(seen.fetches.length).toBe(1)
  expect(seen.toasts.length).toBe(0)
})

test('each update or network setting turns the check off', async () => {
  for (const name of ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES']) {
    const { io, seen } = updateIO({ env: { [name]: '1' } })
    await runUpdateCheck(io, ROOT)
    expect(seen.fetches.length).toBe(0)
    expect(seen.toasts.length).toBe(0)
    expect(seen.logs.some((l) => l.includes('update check off'))).toBe(true)
  }
})

test('glance run from a folder of its own never checks', async () => {
  const { io, seen } = updateIO()
  await runUpdateCheck(io, '/home/u/src/glance')
  expect(seen.fetches.length).toBe(0)
  expect(seen.logs.some((l) => l.includes('not a marketplace install'))).toBe(true)
})

test('a failed fetch is logged, shows nothing, and is tried again next session', async () => {
  const { io, seen } = updateIO({ ok: false })
  await runUpdateCheck(io, ROOT)
  expect(seen.toasts.length).toBe(0)
  expect(seen.logs.some((l) => l.includes('HTTP 404'))).toBe(true)
  expect(seen.saved).toBe(undefined)
})

test('a fetch that answers 200 with no version is logged, saves nothing, and is tried again next session', async () => {
  const { io, seen } = updateIO()
  io.fetch = async () => ({ ok: true, status: 200, text: '{}' })
  await runUpdateCheck(io, ROOT)
  expect(seen.toasts.length).toBe(0)
  expect(seen.logs.some((l) => l.includes('got no version (HTTP 200)'))).toBe(true)
  expect(seen.saved).toBe(undefined)
})

test('a glance whose own plugin.json has no version never fetches', async () => {
  const { io, seen } = updateIO()
  io.readFile = async () => '{}'
  await runUpdateCheck(io, ROOT)
  expect(seen.fetches.length).toBe(0)
  expect(seen.logs.some((l) => l.includes('no version in its own plugin.json'))).toBe(true)
})

test('a fetch that throws is logged, never thrown', async () => {
  const { io, seen } = updateIO()
  io.fetch = async () => {
    throw new Error('offline')
  }
  await runUpdateCheck(io, ROOT)
  expect(seen.toasts.length).toBe(0)
  expect(seen.logs.some((l) => l.includes('update check failed: Error: offline'))).toBe(true)
})

// /glance-update. The CLI's --json failure line is the one `claude plugin
// update` printed for a plugin it couldn't find (Claude Code 2.1.319).
const NOT_FOUND_JSON = '{"command":"update","outcome":"failed","plugin":"glance@glance","message":"Plugin \\"glance\\" not found","failureCode":"not_found"}'

test('/glance-update runs claude plugin update for the marketplace glance came from', async () => {
  const runs: string[][] = []
  const text = await updateGlance(async (argv) => {
    runs.push(argv)
    return { exitCode: 0, stdout: '{"command":"update","outcome":"updated","message":"Updated glance to 0.3.0"}\n', stderr: '' }
  }, ROOT)
  expect(runs).toEqual([['claude', 'plugin', 'update', 'glance@glance', '--json']])
  expect(text).toContain('Updated glance to 0.3.0')
  expect(text).toContain('/reload-plugins')
})

test('/glance-update says what failed and how to update by hand', async () => {
  const text = await updateGlance(async () => ({ exitCode: 1, stdout: NOT_FOUND_JSON + '\n', stderr: '' }), ROOT)
  expect(text).toContain('Plugin "glance" not found')
  expect(text).toContain('claude plugin update glance@glance')
  expect(text).not.toContain('/reload-plugins')
})

test('/glance-update falls back to stderr when the CLI prints no JSON', async () => {
  const text = await updateGlance(async () => ({ exitCode: 1, stdout: 'boom', stderr: 'permission denied\n' }), ROOT)
  expect(text).toContain('the update failed (permission denied)')
  expect(text).toContain('claude plugin update glance@glance')
})

test('/glance-update reads the last line of the output, and fills in a missing message', async () => {
  const last = await updateGlance(
    async () => ({ exitCode: 0, stdout: 'Checking glance...\n{"outcome":"updated","message":"Updated glance to 0.3.0"}\n', stderr: '' }),
    ROOT,
  )
  expect(last).toContain('Updated glance to 0.3.0')
  const bare = await updateGlance(async () => ({ exitCode: 0, stdout: '', stderr: '' }), ROOT)
  expect(bare).toContain('glance is updated')
  expect(bare).toContain('/reload-plugins')
  const failed = await updateGlance(async () => ({ exitCode: 1, stdout: '', stderr: '' }), ROOT)
  expect(failed).toContain('the update failed. ')
})

test('/glance-update that cannot run the CLI says how to update by hand', async () => {
  const text = await updateGlance(async () => {
    throw new Error("failed to start: ENOENT: Command 'claude' not found")
  }, ROOT)
  expect(text).toContain("couldn't run the update")
  expect(text).toContain('claude plugin update glance@glance')
})

// A glance run from a clone of its own updates with git instead.
const CLONE = String.raw`C:\Users\u\Documents\GitHub\glance`
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })

test('/glance-update on a clone pulls it fast-forward only, and says to reload', async () => {
  const runs: string[][] = []
  const text = await updateGlance(async (argv) => {
    runs.push(argv)
    return argv.includes('rev-parse') ? ok('true\n') : ok('Updating 4ab1ca9..9f00d1e\nFast-forward\n glance.mjs | 2 +-\n')
  }, CLONE)
  expect(runs).toEqual([
    ['git', '-C', CLONE, 'rev-parse', '--is-inside-work-tree'],
    ['git', '-C', CLONE, 'pull', '--ff-only'],
  ])
  expect(text).toContain('pulled the latest glance')
  expect(text).toContain('/reload-plugins')
})

test('/glance-update on a clone that is current says so', async () => {
  const text = await updateGlance(async (argv) => (argv.includes('rev-parse') ? ok('true\n') : ok('Already up to date.\n')), CLONE)
  expect(text).toContain('already up to date')
  expect(text).not.toContain('/reload-plugins')
})

test('/glance-update on a clone whose pull fails says why and how to update by hand', async () => {
  const text = await updateGlance(
    async (argv) =>
      argv.includes('rev-parse') ? ok('true\n') : { exitCode: 128, stdout: '', stderr: '\nfatal: Not possible to fast-forward, aborting.\n' },
    CLONE,
  )
  expect(text).toContain('git pull in')
  expect(text).toContain('(fatal: Not possible to fast-forward, aborting.)')
  expect(text).toContain('by hand')
})

test('/glance-update on a folder that is not a git clone pulls nothing', async () => {
  const runs: string[][] = []
  const text = await updateGlance(async (argv) => {
    runs.push(argv)
    return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
  }, CLONE)
  expect(runs.length).toBe(1)
  expect(text).toContain("isn't a git clone")
})

test('/glance-update on a clone without git says how to update by hand', async () => {
  const text = await updateGlance(async () => {
    throw new Error("failed to start: ENOENT: Command 'git' not found")
  }, CLONE)
  expect(text).toContain("git couldn't run there")
  expect(text).toContain('by hand')
})

test('/glance-update from the engine runs git for a glance run from its own folder', async ($, on) => {
  const runs: any[] = []
  on('process.run', (_, e) => (runs.push(e), { value: ok(e.argv.includes('rev-parse') ? 'true\n' : 'Already up to date.\n') }))
  on('command.run', () => ({ text: 'engine ran it' }))
  const r = await $.command.run({ command: 'glance-update' })
  expect(runs.map((e) => e.argv[0])).toEqual(['git', 'git'])
  expect(r.text).toContain('already up to date')
})

// session.start: in the test engine $.plugin.root is this folder, not a
// marketplace install, so the update check stops at that and logs why.
function sessionEngine(on: Parameters<Parameters<typeof test>[1]>[1], env: (name: string) => Promise<string | undefined>) {
  const seen = { commands: [] as string[], envs: [] as string[], logs: [] as string[] }
  on('command.register', (_, e) => (seen.commands.push(e.name), { value: undefined }) as never)
  on('env.get', (_, e) => (seen.envs.push(e.name), env(e.name).then((value) => ({ value }))) as never)
  on('ui.log', (_, e) => (seen.logs.push(String(e.text)), { value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  return seen
}

const START = { cwd: '/home/u/project', surface: 'terminal', isInteractive: true } as const

test('an interactive session registers /glance-update and starts the update check', async ($, on) => {
  const seen = sessionEngine(on, async () => undefined)
  await $.session.start(START)
  await new Promise((r) => setTimeout(r, 0))
  expect(seen.commands).toContain('glance-update')
  expect(seen.envs).toEqual(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES'])
  expect(seen.logs.some((l) => l.includes('not a marketplace install'))).toBe(true)
})

test('each update or network setting reaches the check by its own name', async ($, on) => {
  const seen = sessionEngine(on, async (name) => (name === 'DISABLE_UPDATES' ? '1' : undefined))
  await $.session.start(START)
  await new Promise((r) => setTimeout(r, 0))
  expect(seen.logs.some((l) => l.includes('update check off (an update or network setting'))).toBe(true)
})

test('session start never waits on the update check', async ($, on) => {
  const seen = sessionEngine(on, () => new Promise(() => {}))
  await $.session.start(START)
  expect(seen.commands).toContain('glance-update')
  expect(seen.envs.length).toBe(1)
})

test('a session nobody is at (claude -p, the SDK) starts no update check', async ($, on) => {
  const seen = sessionEngine(on, async () => undefined)
  await $.session.start({ ...START, surface: null, isInteractive: false })
  await new Promise((r) => setTimeout(r, 0))
  expect(seen.commands).toContain('glance-update')
  expect(seen.envs).toEqual([])
})

test('a command that fails to register never holds up or fails session start', async ($, on) => {
  const starts: unknown[] = []
  on('command.register', () => {
    throw new Error('registry closed')
  })
  on('session.start', (_, e) => (starts.push(e), { cwd: e.cwd }) as never)
  const r = await $.session.start(START)
  expect(r.cwd).toBe(START.cwd)
  expect(starts.length).toBe(1)
})
