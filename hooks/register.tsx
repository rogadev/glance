import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pane } from '../types'

// The glance mod. It hands each event glance.mjs decides on to that script,
// which keeps the per-session state and paints the terminal pane: the
// settings-hook events (as `classic.*`, so an install needs no settings.json
// entries), PreToolUse (through `tool.call`, which carries a subagent's
// `agentId`), Esc (`turn.complete` aborted, which fires no settings hook), the
// engine's isWorking (UiWorking and UiIdle, for what sends no hook, such as
// bash mode or a cancelled /compact), /glance-check, and /glance-fix. The
// desktop app has no terminal to tint, so there the mod draws a band above the
// prompt from the state glance.mjs reports back.

/**
 * This session's pane as glance.mjs last reported it. Change `shape` when Pane
 * changes. The color stays empty until glance.mjs, which owns it, reports one;
 * the band draws only after that.
 */
const pane = atom({ plugin: 'glance', key: 'pane' } as const, { state: 'attention', color: '' } as Pane, {
  shape: 'pane-1',
})

/** The state line glance.mjs prints first for every event the mod sends, or null. */
export function parsePane(stdout: string): Pane | null {
  try {
    const r = JSON.parse(stdout.split('\n')[0] || '')
    if ((r.state === 'working' || r.state === 'attention') && typeof r.color === 'string') {
      return { state: r.state, color: r.color }
    }
  } catch {
    // Older glance.mjs, or no output: the band keeps its last state.
  }
  return null
}

const FIX = 'glance-fix'
const CHECK = 'glance-check'
const LIVE: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

type Summary = { was?: string; dropped?: string[]; kept?: string[]; paint?: string }

/** glance.mjs's "attention [stop]" in the words the commands use: "needs you [stop]". */
function plainState(state: string | undefined): string {
  return (state || 'unknown').replace(/^attention\b/, 'needs you')
}

/** Turns glance.mjs's one-line JSON summary into the command's output. */
export function describe(stdout: string): string {
  let r: Summary
  try {
    r = JSON.parse(stdout.trim().split('\n').pop() || '')
  } catch {
    return `glance-fix: glance.mjs gave no summary. Output: ${stdout.slice(0, 200) || '(empty)'}`
  }
  const lines = [`glance was ${plainState(r.was)}; now needs you.`]
  lines.push(r.dropped?.length ? `Dropped: ${r.dropped.join(', ')}.` : 'Nothing stale to drop.')
  if (r.kept?.length) lines.push(`Kept (still running): ${r.kept.join(', ')}.`)
  if (r.paint !== 'ok') lines.push(`Painting failed (${r.paint}); see ~/.claude/state/glance/events.log.`)
  return lines.join('\n')
}

type Check = {
  version?: string
  platform?: string
  node?: string
  surface?: string
  terminal?: { name: string; support: string }
  painter?: string
  flash?: string
  restore?: string
  flash_ms?: number
  state?: string
  background?: number
}

const SUPPORT: Record<string, string> = {
  confirmed: 'confirmed working with glance',
  expected: 'should work (it supports the color codes), not yet confirmed with glance',
  unknown: 'not known to work yet',
}

/** Turns glance.mjs's /glance-check report into the command's output. */
export function describeCheck(stdout: string): string {
  let r: Check
  try {
    r = JSON.parse(stdout.trim().split('\n').pop() || '')
  } catch {
    return `glance-check: glance.mjs gave no report. Output: ${stdout.slice(0, 200) || '(empty)'}`
  }
  const issue = 'Open an issue at https://github.com/rogadev/glance/issues with this report.'
  const desktop = r.surface === 'desktop'
  const lines: string[] = []
  if (desktop) {
    lines.push('In Claude Desktop, glance draws a band above the prompt while Claude works, instead of tinting a terminal.')
  } else if (r.flash !== 'ok') {
    lines.push(`glance couldn't paint this pane (${r.flash}). ${issue}`)
  } else if (r.restore !== 'ok') {
    lines.push(`glance painted the working color but couldn't put the pane back (${r.restore}), so it may still look busy. Run /glance-fix to repaint it. ${issue}`)
  } else {
    const shown = r.flash_ms ? `for ${r.flash_ms / 1000} seconds` : 'for a moment'
    lines.push(`glance showed the working color ${shown}, then put the pane back. Did you see the background change and change back?`)
    lines.push(`If you didn't, your terminal ignores the color codes. ${issue}`)
  }
  const term = r.terminal ? `${r.terminal.name}: ${SUPPORT[r.terminal.support] || r.terminal.support}` : 'unknown'
  lines.push('')
  if (desktop) lines.push('Terminal: none (Claude Desktop)')
  else lines.push(`Terminal: ${term}`, `Painter: ${r.painter} (flash ${r.flash}, restore ${r.restore})`)
  lines.push(
    `Now: ${plainState(r.state)}, ${r.background ?? 0} background item(s)`,
    `glance ${r.version} on ${r.platform}, Node ${r.node}, surface ${r.surface}`,
  )
  return lines.join('\n')
}

// The surface the prompt band last drew on, for /glance-check's report.
let lastSurface = 'unknown'

// Set once glance.mjs can't be started (most often: no `node` on PATH), so
// the warning shows once per load instead of on every event.
let warned = false

/** Runs glance.mjs with one event on stdin. Never throws. */
async function glance($: EngineInterface, input: object) {
  try {
    const r = await $.process.run(['node', `${$.plugin.root}/glance.mjs`], {
      stdin: JSON.stringify({ ...input, glance_via: 'mod' }),
      timeoutMs: 5000,
    })
    if (r.exitCode !== 0) $.ui.log(`glance: exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`, { to: 'debug' })
    const next = parsePane(r.stdout)
    if (next) await update($, pane, () => next)
    else $.ui.log(`glance: no state line from glance.mjs: ${r.stdout.slice(0, 200)}`, { to: 'debug' })
    return r
  } catch (err: unknown) {
    $.ui.log(`glance: could not run glance.mjs: ${String(err)}`, { to: 'debug' })
    if (!warned) {
      warned = true
      $.ui.toast('glance could not start Node.js, so the pane tint is off. Install Node.js 20 or later and restart Claude.')
    }
    return undefined
  }
}

// The engine's isWorking as the prompt band last saw it, so only changes are
// sent, and a count of the changes, so a stale wait can tell it was overtaken.
let uiWorking: boolean | undefined
let uiChanges = 0
// How many of glance's own commands are running. They keep the engine busy
// for a second or two (isWorking), which isn't Claude working.
let ownCommands = 0

/** How long isWorking must stay true before it counts: /exit and the like flip it briefly. */
const WORKING_SETTLE_MS = 1500

/**
 * Tells glance.mjs when the engine starts or stops working, for what sends no
 * hook. Starting covers bash mode (! command); stopping covers a /compact
 * cancelled with Esc. glance.mjs decides whether either changes the color.
 */
async function noteWorking($: EngineInterface, working: boolean) {
  if (working === uiWorking) return
  uiWorking = working
  const change = ++uiChanges
  const idle_since = Date.now()
  try {
    if (working) {
      await $.clock.sleep(WORKING_SETTLE_MS)
      if (change !== uiChanges || ownCommands > 0) return
    }
    const session_id = await $.session.id()
    await glance($, { hook_event_name: working ? 'UiWorking' : 'UiIdle', session_id, idle_since })
  } catch (err: unknown) {
    // Nobody awaits this, so a throw would go unreported; log it instead.
    $.ui.log(`glance: could not report isWorking=${working}: ${String(err)}`, { to: 'debug' })
  }
}

/** Runs one of glance's own commands, with isWorking reports held off while it runs. */
async function runOwn($: EngineInterface, input: object) {
  ownCommands++
  try {
    return await glance($, input)
  } finally {
    ownCommands--
  }
}

/** A hook's .catch: let the event go on as if glance weren't there. */
function failOpen<E, R>(_$: EngineInterface, e: E, next: (e: E) => R): R {
  return next(e)
}

export const register: Register = (on) => {
  // Awaited before next(), as a settings hook is, so events reach glance.mjs
  // in the order they happen. One line per event keeps each hook typed.
  // failOpen: a glance failure must never hold up or block Claude.
  on('classic.SessionStart', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.SessionEnd', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.UserPromptSubmit', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.PostToolUse', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.PostToolUseFailure', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.ElicitationResult', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.PermissionRequest', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.Elicitation', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.Notification', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.SubagentStart', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.SubagentStop', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.Stop', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.StopFailure', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.PreCompact', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)
  on('classic.PostCompact', async ($, e, next) => (await glance($, e), next(e))).catch(failOpen)

  on('tool.call', async ($, e, next) => {
    const session_id = await $.session.id()
    await glance($, {
      hook_event_name: 'PreToolUse',
      session_id,
      tool_name: e.tool,
      ...(e.agentId === undefined ? {} : { agent_id: e.agentId }),
    })
    return next(e)
  }).catch(failOpen)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: CHECK,
      description: 'Show the working color for a moment and report what glance found, to check it works in your terminal',
      immediate: true,
    })
    await $.command.register({
      name: FIX,
      description: 'Reset a stuck glance tint: drop stale background work and repaint as needs-you',
      // Runs even while a turn is in flight, in case the stuck part is the turn.
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: CHECK }, async ($) => {
    const session_id = await $.session.id()
    const r = await runOwn($, { hook_event_name: 'GlanceCheck', session_id, surface: lastSurface })
    if (!r) return { text: 'glance-check: could not run glance.mjs. Is Node.js installed and on PATH?' }
    if (r.exitCode !== 0) return { text: `glance-check: glance.mjs exited ${r.exitCode}: ${r.stderr.slice(0, 300)}` }
    return { text: describeCheck(r.stdout) }
  }).catch((_$, _e, next) => ({ text: `glance-check failed: ${String(next.error)}` }))

  on('command.run', { command: FIX }, async ($) => {
    const session_id = await $.session.id()
    const agents = await $.agent.list()
    const live_agents = agents.filter((a) => LIVE.has(a.status)).map((a) => a.id)
    const r = await runOwn($, { hook_event_name: 'GlanceReset', session_id, live_agents })
    if (!r) return { text: 'glance-fix: could not run glance.mjs. Is Node.js installed and on PATH?' }
    if (r.exitCode !== 0) return { text: `glance-fix: glance.mjs exited ${r.exitCode}: ${r.stderr.slice(0, 300)}` }
    return { text: describe(r.stdout) }
  }).catch((_$, _e, next) => ({ text: `glance-fix failed: ${String(next.error)}` }))

  /**
   * The desktop app's stand-in for the terminal tint: a full-width band in the
   * working color above the prompt while glance says working, and nothing
   * otherwise (needs you). The terminal is tinted by glance.mjs, so it passes.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Not awaited: drawing shouldn't wait on glance.mjs, which sleeps on UiIdle.
    void noteWorking($, e.props.isWorking)
    lastSurface = e.surface
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const now = await read($, pane)
    if (now.state !== 'working') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box width="100%" paddingX={1} backgroundColor={now.color}>
        <Text color="#FFFFFF">
          Claude is working
        </Text>
      </Box>
    )
  }).catch(failOpen)

  /**
   * Pressing Esc ends a turn without firing any settings hook (no Stop). The
   * engine's own turn.complete does fire, with reason 'aborted'; glance.mjs
   * treats that TurnAborted the way it treats Stop.
   */
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (e.reason === 'aborted' || e.isAborted)) {
      const session_id = await $.session.id()
      // Not awaited: the turn's end shouldn't wait on painting.
      void glance($, { hook_event_name: 'TurnAborted', session_id })
    }
    return result
  })
}
