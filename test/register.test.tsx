import { expect, test } from 'claude-code/testing'

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

// The engine's own drawing of the band, beneath the plugin: an empty line.
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
