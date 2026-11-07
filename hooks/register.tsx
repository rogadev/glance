import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pane } from '../types'

// The glance mod. It hands each event glance.mjs decides on to that script,
// which keeps the per-session state and paints the terminal pane: the
// settings-hook events (as `classic.*`, so an install needs no settings.json
// entries), PreToolUse (through `tool.call`, which carries a subagent's
// `agentId`), Esc (`turn.complete` aborted, which fires no settings hook), and
// /glance-fix. The desktop app has no terminal to tint, so there the mod draws
// a band above the prompt from the state glance.mjs reports back.

/** This session's pane as glance.mjs last reported it. Change `shape` when Pane changes. */
const pane = atom({ plugin: 'glance', key: 'pane' } as const, { state: 'attention', color: '#1F2D3D' } as Pane, {
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
const LIVE: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

type Summary = { was?: string; dropped?: string[]; kept?: string[]; paint?: string }

/** Turns glance.mjs's one-line JSON summary into the command's output. */
export function describe(stdout: string): string {
  let r: Summary
  try {
    r = JSON.parse(stdout.trim().split('\n').pop() || '')
  } catch {
    return `glance-fix: glance.mjs gave no summary. Output: ${stdout.slice(0, 200) || '(empty)'}`
  }
  const lines = [`glance was ${r.was}; now needs-you.`]
  lines.push(r.dropped?.length ? `Dropped: ${r.dropped.join(', ')}.` : 'Nothing stale to drop.')
  if (r.kept?.length) lines.push(`Kept (still running): ${r.kept.join(', ')}.`)
  if (r.paint !== 'ok') lines.push(`Painting failed (${r.paint}); see ~/.claude/state/glance/events.log.`)
  return lines.join('\n')
}

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
      name: FIX,
      description: 'Reset a stuck glance tint: drop stale background work and repaint as needs-you',
      // Runs even while a turn is in flight, in case the stuck part is the turn.
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: FIX }, async ($) => {
    const session_id = await $.session.id()
    const agents = await $.agent.list()
    const live_agents = agents.filter((a) => LIVE.has(a.status)).map((a) => a.id)
    const r = await glance($, { hook_event_name: 'GlanceReset', session_id, live_agents })
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
