import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Pane } from '../types'

// The glance mod. It hands each event glance.mjs decides on to that script,
// which keeps the per-session state and paints the terminal pane: the
// settings-hook events (as `classic.*`, so an install needs no settings.json
// entries), PreToolUse (through `tool.call`, which carries a subagent's
// `agentId`), Esc (`turn.complete` aborted, which fires no settings hook), the
// engine's isWorking (UiWorking and UiIdle, for what sends no hook, such as
// bash mode or a cancelled /compact), a Tick when glance.mjs asks to be
// checked on later (background work expires with no event), /glance-check,
// and /glance-fix. The desktop app has no terminal to tint, so there the mod
// draws a band above the prompt from the state glance.mjs reports back.

/**
 * This session's pane as glance.mjs last reported it. Change `shape` when Pane
 * changes. The color stays empty until glance.mjs, which owns it, reports one;
 * the band draws only after that.
 */
const pane = atom({ plugin: 'glance', key: 'pane' } as const, { state: 'attention', color: '' } as Pane, {
  shape: 'pane-2',
})

const STATES: ReadonlySet<string> = new Set(['working', 'standby', 'attention'])

/** The state line glance.mjs prints first for every event the mod sends, or null. */
export function parsePane(stdout: string): Pane | null {
  try {
    const r = JSON.parse(stdout.split('\n')[0] || '')
    if (STATES.has(r.state) && typeof r.color === 'string') {
      return { state: r.state, color: r.color }
    }
  } catch {
    // Older glance.mjs, or no output: the band keeps its last state.
  }
  return null
}

/**
 * Gets how long glance.mjs's state line says to wait before sending a Tick,
 * in milliseconds, or 0 when it asks for none.
 */
export function recheckOf(stdout: string): number {
  try {
    const ms = JSON.parse(stdout.split('\n')[0] || '').recheck_in_ms
    return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  } catch {
    return 0
  }
}

const FIX = 'glance-fix'
const CHECK = 'glance-check'
const REPORT = 'glance-report'
const LIVE: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])

type Diagnosis = { verdict?: string; suspect?: boolean; cause?: string }
type Summary = { was?: string; dropped?: string[]; kept?: string[]; paint?: string; diagnosis?: Diagnosis; snapshot?: string }

/** glance.mjs's "attention [stop]" in the words the commands use: "needs you [stop]". */
function plainState(state: string | undefined): string {
  return (state || 'unknown').replace(/^attention\b/, 'needs you').replace(/^standby\b/, 'standing by')
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
  if (r.diagnosis?.cause) lines.push('', r.diagnosis.cause)
  if (r.diagnosis?.suspect) {
    lines.push(`If the pane really was stuck, that's a glance bug. Run /${REPORT} to have Claude draft an issue for the glance maintainers; you see it before anything is filed.`)
  }
  return lines.join('\n')
}

/** Gets the snapshot path from glance.mjs's /glance-fix summary, or '' when there is none. */
export function snapshotOf(stdout: string): string {
  try {
    const r: Summary = JSON.parse(stdout.trim().split('\n').pop() || '')
    return typeof r.snapshot === 'string' ? r.snapshot : ''
  } catch {
    return ''
  }
}

/** Builds the prompt /glance-report hands Claude: run the report skill, on the last /glance-fix snapshot if any. */
export function reportPrompt(snapshot: string): string {
  const start = 'Use the glance:report-issue skill to help me report a problem with glance.'
  if (!snapshot) return `${start} I haven't run /glance-fix in this session, so ask me what went wrong.`
  return `${start} Start from the snapshot /glance-fix saved at ${snapshot}: it holds what glance found before it reset the pane, and this session's recent glance log lines.`
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

const COLOR = 'glance-color'
const COLOR_NAMES: Record<string, string> = { workingColor: 'Working', standbyColor: 'Standing by' }
type ColorReport = {
  file?: string
  colors?: Record<string, string>
  defaults?: Record<string, string>
  custom?: string[]
  changed?: { action: string; key?: string; keys?: string[]; color?: string }
  error?: string
  paint?: string
}

/** Turns glance.mjs's /glance-color report into the command's output. */
export function describeColor(stdout: string): string {
  let r: ColorReport
  try {
    r = JSON.parse(stdout.trim().split('\n').pop() || '')
  } catch {
    return `${COLOR}: glance.mjs gave no report. Output: ${stdout.slice(0, 200) || '(empty)'}`
  }
  const colors = r.colors || {}
  const lines: string[] = []
  if (r.error) lines.push(`${COLOR}: ${r.error}.`)
  else if (r.changed?.action === 'set' && r.changed.key) {
    lines.push(`${COLOR_NAMES[r.changed.key]} is now ${r.changed.color}. Your other sessions switch at their next event, or run /${FIX} in one to repaint it now.`)
  } else if (r.changed?.action === 'reset') {
    const names = (r.changed.keys || []).map((k) => COLOR_NAMES[k]).join(' and ')
    lines.push(`${names} ${r.changed.keys?.length === 1 ? 'is' : 'are'} back to the default.`)
  }
  if (r.paint?.startsWith('paint-failed')) lines.push(`Painting this pane failed (${r.paint}); see ~/.claude/state/glance/events.log.`)
  if (lines.length) lines.push('')
  const custom = new Set(r.custom || [])
  for (const key of Object.keys(COLOR_NAMES)) {
    const mark = custom.has(key) ? ` (default ${r.defaults?.[key]})` : ' (default)'
    lines.push(`${COLOR_NAMES[key]}: ${colors[key] || 'unknown'}${mark}`)
  }
  lines.push("Needs you: your terminal's own background")
  if (!r.changed) {
    lines.push(
      '',
      `/${COLOR} standby #3A2A55   set a color (working or standby)`,
      `/${COLOR} reset standby     put one back to the default`,
      `/${COLOR} reset             put both back`,
    )
  }
  if (r.file && custom.size) lines.push('', `Saved in ${r.file}.`)
  return lines.join('\n')
}

// The surface the prompt band last drew on, for /glance-check's report.
let lastSurface = 'unknown'
// Where the last /glance-fix saved its snapshot, for /glance-report.
let lastSnapshot = ''
// The prompt /glance-report queued, submitted at the next idle draw of the
// prompt area.
let pendingReport = ''

/** Submits the prompt /glance-report queued. Not awaited: it is a turn of its own. */
function submitReport($: EngineInterface) {
  const text = pendingReport
  pendingReport = ''
  const refused = (why: string) => {
    $.ui.log(`glance: /glance-report could not submit its prompt: ${why}`, { to: 'debug' })
    $.ui.toast('glance could not start the report. Run /glance:report-issue to start it yourself.')
  }
  // A hook or the engine refusing the prompt resolves as { drop }; anything
  // else that goes wrong rejects.
  void $.prompt
    .submit({ text })
    .then((r) => {
      if (r.drop !== undefined) refused(r.drop)
    })
    .catch((err: unknown) => refused(String(err)))
}

// Set once `node` can't be started, so the warning shows once per load
// instead of on every event.
let warned = false
/** Builds the output a command shows when glance.mjs didn't run or didn't finish. */
function couldNotRun(command: string, error: unknown): string {
  if (cannotStart(error)) return `${command}: could not run glance.mjs. Is Node.js installed and on PATH?`
  return `${command}: glance.mjs didn't finish in time (${String(error)}). Try again in a moment; claude --debug shows more.`
}

/**
 * Checks whether a `$.process.run` rejection means the command could not start (for
 * `node`: not installed or not on PATH), as opposed to a run that timed out.
 * The engine's rejection carries no code, only its message: "... failed to
 * start: ENOENT: ..." or "... aborted: still running after 5000ms".
 */
export function cannotStart(err: unknown): boolean {
  return /failed to start|ENOENT/.test(String(err))
}

// The timer for the next Tick and when it fires, so the events of a turn
// don't each replace a timer that is already right.
let recheck: Timer | undefined
let recheckDue = 0
/** Two due times closer than this are the same timer. */
const RECHECK_SLACK_MS = 5000
/** The longest one timer waits; the Tick it sends asks again. */
const RECHECK_MAX_MS = 6 * 60 * 60 * 1000

/**
 * Sets the timer for the Tick glance.mjs asked for, `ms` from now, or clears
 * it when `ms` is 0. Background work expires, and a scheduled run comes due,
 * with no event to repaint the pane; the Tick is that event.
 */
function armRecheck($: EngineInterface, ms: number) {
  if (!ms) {
    recheck?.cancel()
    recheck = undefined
    recheckDue = 0
    return
  }
  const due = Date.now() + ms
  if (recheck && Math.abs(due - recheckDue) < RECHECK_SLACK_MS) return
  recheck?.cancel()
  recheckDue = due
  // A second late, so glance.mjs finds the moment it named already past.
  recheck = $.clock.after(Math.min(ms, RECHECK_MAX_MS) + 1000, () => {
    recheck = undefined
    recheckDue = 0
    void tick($)
  })
}

/** Sends glance.mjs the Tick it asked for. Never throws: nobody awaits it. */
async function tick($: EngineInterface) {
  try {
    const session_id = await $.session.id()
    await glance($, { hook_event_name: 'Tick', session_id })
  } catch (err: unknown) {
    $.ui.log(`glance: could not send the Tick: ${String(err)}`, { to: 'debug' })
  }
}

/**
 * Runs glance.mjs with one event on stdin. Never throws: a run that couldn't
 * start or didn't finish comes back as `{ error }`, so a command can say which.
 */
async function glance($: EngineInterface, input: object) {
  let r
  try {
    r = await $.process.run(['node', `${$.plugin.root}/glance.mjs`], {
      stdin: JSON.stringify({ ...input, glance_via: 'mod' }),
      timeoutMs: 5000,
    })
  } catch (err: unknown) {
    // A slow run (a busy machine) is not a missing Node.js: the next event
    // repaints, so it goes to the debug log only.
    $.ui.log(`glance: could not run glance.mjs: ${String(err)}`, { to: 'debug' })
    if (cannotStart(err) && !warned) {
      warned = true
      $.ui.toast('glance could not start Node.js, so the pane tint is off. Install Node.js 20 or later and restart Claude.')
    }
    return { error: err }
  }
  if (r.exitCode !== 0) $.ui.log(`glance: exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`, { to: 'debug' })
  try {
    armRecheck($, recheckOf(r.stdout))
  } catch (err: unknown) {
    $.ui.log(`glance: could not set the timer for the next check: ${String(err)}`, { to: 'debug' })
  }
  const next = parsePane(r.stdout)
  if (!next) {
    $.ui.log(`glance: no state line from glance.mjs: ${r.stdout.slice(0, 200)}`, { to: 'debug' })
    return r
  }
  try {
    await update($, pane, () => next)
  } catch (err: unknown) {
    $.ui.log(`glance: could not save the pane state for the band: ${String(err)}`, { to: 'debug' })
  }
  return r
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
      // Every turn gets here 1.5 s in, already working from its prompt:
      // UiWorking would change nothing, so skip the run.
      if ((await read($, pane)).state === 'working') return
    }
    const session_id = await $.session.id()
    await glance($, { hook_event_name: working ? 'UiWorking' : 'UiIdle', session_id, idle_since })
  } catch (err: unknown) {
    // Nobody awaits this, so a throw would go unreported; log it instead.
    $.ui.log(`glance: could not report isWorking=${working}: ${String(err)}`, { to: 'debug' })
  }
}

/** Runs one of glance's own commands, with isWorking reports held off while it runs. */
async function runOwn<T>(work: () => Promise<T>): Promise<T> {
  ownCommands++
  try {
    return await work()
  } finally {
    ownCommands--
  }
}

// Update check. Claude Code's docs say it auto-updates plugins from a
// third-party marketplace only when the user turns that on (not yet verified
// here; see the README's open questions), so glance looks for a newer
// release itself, at most once a day across all windows, and says so in a
// toast at the start of each session while it is behind.

const UPDATE = 'glance-update'
const LATEST_URL = 'https://raw.githubusercontent.com/rogadev/glance/main/.claude-plugin/plugin.json'
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
// The toast waits for the session's screen to be up.
const NOTICE_DELAY_MS = 3000

/** What the update check keeps in `$.store`, shared by every session. */
type UpdateCheck = { checkedAt?: number; latest?: string }

/**
 * Checks whether version `latest` is newer than `installed`, both `x.y.z`.
 * Anything that isn't three numbers counts as not newer, so a bad answer
 * never shows a notice.
 */
export function isNewer(latest: string, installed: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const a = parse(latest)
  const b = parse(installed)
  if (!a || !b) return false
  for (const [i, n] of a.entries()) {
    const m = b[i]
    if (m !== undefined && n !== m) return n > m
  }
  return false
}

/**
 * Gets the marketplace glance was installed from, read off its folder
 * (`.../plugins/cache/<marketplace>/glance/<version>`), or '' when glance runs
 * from a folder of its own (`--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS`).
 */
export function marketplaceOf(root: string): string {
  const m = /[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]glance[\\/][^\\/]+[\\/]?$/.exec(root)
  return m?.[1] ?? ''
}

/**
 * Checks whether the last update check is old enough to fetch again. A check
 * dated in the future (the clock was set back) counts as due, so a wrong clock
 * can't hold off every check until it catches up.
 */
export function checkDue(check: UpdateCheck, now: number): boolean {
  if (typeof check.checkedAt !== 'number') return true
  const age = now - check.checkedAt
  return age < 0 || age >= CHECK_EVERY_MS
}

/** Reads a stored update check, keeping only the fields of the right type. */
export function asUpdateCheck(stored: unknown): UpdateCheck {
  if (typeof stored !== 'object' || stored === null) return {}
  // A non-null object, checked above; each field is checked below.
  const { checkedAt, latest } = stored as Record<string, unknown>
  return {
    ...(typeof checkedAt === 'number' ? { checkedAt } : {}),
    ...(typeof latest === 'string' ? { latest } : {}),
  }
}

/** Builds the toast that says a newer glance is out. */
export function updateNotice(latest: string, installed: string): string {
  return `glance ${latest} is out (you have ${installed}). Run /${UPDATE}, then /reload-plugins. To get updates on their own, turn on auto-update for the glance marketplace under /plugin, Marketplaces.`
}

/** What the update check reads and does, so tests can stand in for the engine. */
export type UpdateIO = {
  env: (name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' | 'DISABLE_AUTOUPDATER' | 'DISABLE_UPDATES') => Promise<string | undefined>
  readFile: (path: string) => Promise<string>
  load: () => Promise<unknown>
  save: (check: UpdateCheck) => Promise<void>
  fetch: (url: string) => Promise<{ ok: boolean; status: number; text: string }>
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  log: (text: string) => void
  toast: (text: string) => void
}

/**
 * Shows the update notice when a newer glance is out, fetching the latest
 * version at most once a day. Never throws; each reason it stops is logged.
 */
export async function runUpdateCheck(io: UpdateIO, root: string): Promise<void> {
  try {
    const quiet =
      (await io.env('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) || (await io.env('DISABLE_AUTOUPDATER')) || (await io.env('DISABLE_UPDATES'))
    if (quiet) return io.log('glance: update check off (an update or network setting turns it off)')
    if (!marketplaceOf(root)) return io.log(`glance: update check off (runs from ${root}, not a marketplace install)`)
    const installed = JSON.parse(await io.readFile(`${root}/.claude-plugin/plugin.json`)).version
    if (typeof installed !== 'string') return io.log('glance: update check found no version in its own plugin.json')
    let check = asUpdateCheck(await io.load())
    const now = await io.now()
    if (checkDue(check, now)) {
      const r = await io.fetch(LATEST_URL)
      const latest = r.ok ? JSON.parse(r.text).version : undefined
      if (typeof latest !== 'string') return io.log(`glance: update check got no version (HTTP ${r.status})`)
      check = { checkedAt: now, latest }
      await io.save(check)
    }
    if (check.latest && isNewer(check.latest, installed)) {
      await io.sleep(NOTICE_DELAY_MS)
      io.toast(updateNotice(check.latest, installed))
    }
  } catch (err: unknown) {
    io.log(`glance: update check failed: ${String(err)}`)
  }
}

/** What `/glance-update` needs from a finished `claude plugin update` or `git` run. */
type Ran = { exitCode: number; stdout: string; stderr: string }

/** The first line of a run's output that says something, for a short message. */
function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200)
}

/**
 * Updates a glance that runs from a folder of its own (a clone loaded with
 * `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`) with `git pull --ff-only`, so
 * it never merges or rewrites anything the user has there. Never throws.
 */
async function updateFolder(run: (argv: string[]) => Promise<Ran>, root: string): Promise<string> {
  const byHand = `Update that folder by hand (for example, \`git pull\` in ${root}), then run /reload-plugins.`
  let r: Ran
  try {
    r = await run(['git', '-C', root, 'rev-parse', '--is-inside-work-tree'])
  } catch (err: unknown) {
    return `${UPDATE}: glance runs from ${root}, and git couldn't run there (${String(err)}). ${byHand}`
  }
  if (r.exitCode !== 0 || r.stdout.trim() !== 'true') {
    return `${UPDATE}: glance runs from ${root}, which isn't a git clone or a marketplace install, so glance can't update it. ${byHand}`
  }
  try {
    r = await run(['git', '-C', root, 'pull', '--ff-only'])
  } catch (err: unknown) {
    return `${UPDATE}: couldn't run git pull in ${root} (${String(err)}). ${byHand}`
  }
  if (r.exitCode !== 0) {
    const why = firstLine(r.stderr) || firstLine(r.stdout)
    return `${UPDATE}: git pull in ${root} failed${why ? ` (${why})` : ''}. ${byHand}`
  }
  if (/already up to date/i.test(r.stdout)) return `${UPDATE}: glance in ${root} is already up to date.`
  return `${UPDATE}: pulled the latest glance into ${root}. Run /reload-plugins to start using it.`
}

/**
 * Updates glance and says what happened: with `claude plugin update` for a
 * marketplace install, or with `git pull` for a clone glance runs from.
 * Never throws.
 */
export async function updateGlance(run: (argv: string[]) => Promise<Ran>, root: string): Promise<string> {
  const marketplace = marketplaceOf(root)
  if (!marketplace) return updateFolder(run, root)
  const id = `glance@${marketplace}`
  const byHand = `Run \`claude plugin update ${id}\` in a terminal, or update glance under /plugin, Installed.`
  let r: Ran
  try {
    r = await run(['claude', 'plugin', 'update', id, '--json'])
  } catch (err: unknown) {
    return `${UPDATE}: couldn't run the update (${String(err)}). ${byHand}`
  }
  // --json prints one result line: { outcome, message, ... }.
  let message = ''
  try {
    const result = JSON.parse(r.stdout.trim().split('\n').pop() || '')
    if (typeof result.message === 'string') message = result.message
  } catch {
    message = r.stderr.trim().slice(0, 200)
  }
  if (r.exitCode !== 0) return `${UPDATE}: the update failed${message ? ` (${message})` : ''}. ${byHand}`
  return `${UPDATE}: ${message || 'glance is updated'}. Run /reload-plugins to start using it.`
}

/** Runs the update check on the engine. Not awaited by its caller. */
function checkForUpdate($: EngineInterface, root: string) {
  return runUpdateCheck(
    {
      // Each name spelled out: the engine reads the variables a module uses off its source.
      env: (name) =>
        name === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
          ? $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
          : name === 'DISABLE_AUTOUPDATER'
            ? $.env.get('DISABLE_AUTOUPDATER')
            : $.env.get('DISABLE_UPDATES'),
      readFile: (path) => $.fs.read(path),
      load: () => $.store.get('update'),
      save: (check) => $.store.set('update', check),
      fetch: (url) => $.http.fetch(url),
      now: () => $.clock.now(),
      sleep: (ms) => $.clock.sleep(ms),
      log: (text) => $.ui.log(text, { to: 'debug' }),
      toast: (text) => $.ui.toast(text),
    },
    root,
  )
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
    await $.command.register({
      name: COLOR,
      description: 'Show or change the colors glance tints the pane with',
      argumentHint: '[working|standby <#hex> | reset [working|standby]]',
      immediate: true,
    })
    await $.command.register({
      name: REPORT,
      description: 'Have Claude research a glance problem (from the last /glance-fix, if any) and draft an issue for the glance maintainers',
    })
    await $.command.register({
      name: UPDATE,
      description: 'Update glance to the latest release (then run /reload-plugins)',
    })
    // Not awaited: the check must never hold up the session.
    if (e.isInteractive) void checkForUpdate($, $.plugin.root)
    return next(e)
  }).catch(failOpen)

  on('command.run', { command: CHECK }, async ($) => {
    const session_id = await $.session.id()
    const r = await runOwn(() => glance($, { hook_event_name: 'GlanceCheck', session_id, surface: lastSurface }))
    if ('error' in r) return { text: couldNotRun(CHECK, r.error) }
    if (r.exitCode !== 0) return { text: `glance-check: glance.mjs exited ${r.exitCode}: ${r.stderr.slice(0, 300)}` }
    return { text: describeCheck(r.stdout) }
  }).catch((_$, _e, next) => ({ text: `glance-check failed: ${String(next.error)}` }))

  on('command.run', { command: FIX }, async ($) => {
    // Cleared first, so a failed run can't leave /glance-report an older snapshot.
    lastSnapshot = ''
    const session_id = await $.session.id()
    const agents = await $.agent.list()
    const live_agents = agents.filter((a) => LIVE.has(a.status)).map((a) => a.id)
    const r = await runOwn(() => glance($, { hook_event_name: 'GlanceReset', session_id, live_agents }))
    if ('error' in r) return { text: couldNotRun(FIX, r.error) }
    if (r.exitCode !== 0) return { text: `glance-fix: glance.mjs exited ${r.exitCode}: ${r.stderr.slice(0, 300)}` }
    lastSnapshot = snapshotOf(r.stdout)
    return { text: describe(r.stdout) }
  }).catch((_$, _e, next) => ({ text: `glance-fix failed: ${String(next.error)}` }))

  on('command.run', { command: COLOR }, async ($, e) => {
    const session_id = await $.session.id()
    const r = await runOwn(() => glance($, { hook_event_name: 'GlanceColor', session_id, args: e.args }))
    if ('error' in r) return { text: couldNotRun(COLOR, r.error) }
    if (r.exitCode !== 0) return { text: `${COLOR}: glance.mjs exited ${r.exitCode}: ${r.stderr.slice(0, 300)}` }
    return { text: describeColor(r.stdout) }
  }).catch((_$, _e, next) => ({ text: `${COLOR} failed: ${String(next.error)}` }))

  on('command.run', { command: UPDATE }, async ($) => {
    const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 120_000 })
    // claude plugin update and git pull can take a while, and isWorking is true the whole time.
    return { text: await runOwn(() => updateGlance(run, $.plugin.root)) }
  }).catch((_$, _e, next) => ({ text: `${UPDATE} failed: ${String(next.error)}` }))

  on('command.run', { command: REPORT }, async () => {
    // The engine refuses a prompt submitted from a command.run hook (it would
    // wait on this command's own turn), and a command's turn sends no
    // turn.complete, so the next idle draw of the prompt area submits it.
    pendingReport = reportPrompt(lastSnapshot)
    return { text: 'glance-report: asking Claude to research this and draft an issue for glance. It shows you the draft before anything is filed.' }
  }).catch((_$, _e, next) => ({ text: `glance-report failed: ${String(next.error)}` }))

  /**
   * The desktop app's stand-in for the terminal tint: a full-width band above
   * the prompt, in the working color while glance says working and in the
   * purple standby color while only a background shell runs, and nothing
   * otherwise (needs you). The terminal is tinted by glance.mjs, so it passes.
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Not awaited: drawing shouldn't wait on glance.mjs, which sleeps on UiIdle.
    void noteWorking($, e.props.isWorking)
    // /glance-report's prompt, once its command is over and the engine is idle.
    if (pendingReport && !e.props.isWorking) submitReport($)
    lastSurface = e.surface
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const now = await read($, pane)
    if (now.state === 'attention') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box width="100%" paddingX={1} backgroundColor={now.color}>
        <Text color="#FFFFFF">
          {now.state === 'working' ? 'Claude is working' : 'A background task is still running'}
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
      // The turn is already over: nothing here may lose its result.
      try {
        const session_id = await $.session.id()
        // Not awaited: the turn's end shouldn't wait on painting.
        void glance($, { hook_event_name: 'TurnAborted', session_id })
      } catch (err: unknown) {
        $.ui.log(`glance: could not report the Esc: ${String(err)}`, { to: 'debug' })
      }
    }
    return result
  }).catch(failOpen)
}
