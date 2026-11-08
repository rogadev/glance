import { expect, mock, test } from 'claude-code/testing'
import { cannotStart, describeCheck, parsePane } from '../hooks/register'

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

const WORKING = JSON.stringify({ state: 'working', color: '#1F2D3D' }) + '\n'
const ATTENTION = JSON.stringify({ state: 'attention', color: '#1F2D3D' }) + '\n'

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
})
