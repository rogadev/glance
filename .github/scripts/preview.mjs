// Builds the pictures of glance: mock Windows Terminal windows running Claude
// Code, each tinted the way glance tints it, using the colors in CONFIG.
// .github/preview.svg and .github/preview-six.svg are Windows desktops with
// four and six sessions, and .github/states.svg shows one window per state
// above its legend entry.
// Run: node .github/scripts/preview.mjs
import { writeFileSync } from 'node:fs'

import { CONFIG } from '../../glance.mjs'

const C = {
  working: CONFIG.workingColor,
  standby: CONFIG.standbyColor,
  // Needs you resets to the profile background: Windows Terminal's default
  // Campbell scheme.
  attention: '#0C0C0C',
  fg: '#CCCCCC',
  bright: '#F2F2F2',
  dim: '#8B8B8B',
  green: '#4EBA65',
  red: '#E06C75',
  claude: '#D77757',
  blue: '#7AA2F7',
  teal: '#4FB6BE',
  rule: '#5A5A5A',
  backdrop: '#1B1B1B',
  border: '#3C3C3C',
}

const UI = 'Segoe UI, Helvetica, Arial, sans-serif'
const W = 1600
const H = 900
const GAP = 2
const TASKBAR = 48
const TAB = 40
const FS = 12.5
const CW = FS * 0.6 // Cascadia Mono advance width
const LH = 18

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Wraps text to `width` columns; continuation lines get `indent` spaces.
function wrap(text, width, indent) {
  const out = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) {
      out.push(line)
      line = ' '.repeat(indent) + word
    } else {
      line = line ? line + ' ' + word : word
    }
  }
  out.push(line)
  return out
}

// Turns a pane's content items into terminal rows. A row is a list of
// [text, color, bold] segments, or { bar: row } for a highlighted user prompt,
// or { rule: true }.
function rows(items, cols) {
  const out = []
  for (const it of items) {
    if (it === '') out.push([])
    else if (Array.isArray(it)) out.push(it)
    else if (it.user) {
      wrap(it.user, cols - 2, 0).forEach((l, i) => out.push({ bar: [[i ? '  ' : '> ', C.dim], [l, C.bright]] }))
    } else if (it.say) {
      wrap(it.say, cols - 2, 0).forEach((l, i) => out.push([[i ? '  ' : '● ', C.fg], [l, C.fg]]))
    } else if (it.tool) {
      const dot = it.running ? C.dim : it.failed ? C.red : C.green
      out.push([['● ', dot], [it.tool, C.fg, true], [`(${it.arg})`, C.fg]])
      if (it.out) out.push([['  ⎿  ', C.dim], [it.out, C.dim]])
    } else if (it.ran) out.push([['  ' + it.ran, C.dim]])
    else if (it.spin) {
      out.push([['✻ ', C.claude], [it.spin + ' ', C.claude], [it.meta, C.dim]])
      if (it.tip) out.push([['  ⎿  ', C.dim], [it.tip, C.dim]])
    } else if (it.done) out.push([['✻ ', C.dim], [it.done, C.dim]])
    else if (it.rule) out.push({ rule: true })
  }
  return out
}

const promptBox = (footer) => [{ rule: true }, [['> ', C.fg]], { rule: true }, footer || [['  ? for shortcuts', C.dim]]]

const P = {
  rate: {
    title: 'Add rate limiting',
    project: 'api-server',
    state: 'working',
    items: [
      { user: 'Add rate limiting to the public endpoints, 100 requests a minute per API key.' },
      '',
      { say: "I'll add a token-bucket limiter as middleware and apply it to the public router." },
      '',
      { tool: 'Update', arg: 'src/middleware/rateLimit.ts', out: 'Added 42 lines' },
      '',
      { tool: 'Update', arg: 'src/routes/public.ts', out: 'Added 2 lines, removed 1 line' },
      '',
      { tool: 'Bash', arg: 'npm test -- rateLimit', out: 'Running…', running: true },
      '',
      { spin: 'Brewing…', meta: '(1m 12s · ↓ 4.1k tokens)' },
    ],
    footer: [['  ⏵⏵ accept edits on', C.claude], [' (shift+tab to cycle)', C.dim]],
  },
  landing: {
    title: 'Landing page refresh',
    project: 'marketing-site',
    state: 'working',
    items: [
      { user: 'Audit the landing page, then tighten up the hero section.' },
      '',
      { say: 'Splitting the audit three ways so it goes faster.' },
      '',
      { ran: 'Launched 3 background agents (↓ to manage)' },
      '',
      { say: "While they run, I'm tightening the hero section." },
      '',
      { tool: 'Read', arg: 'src/components/Hero.astro', out: 'Read 88 lines' },
      '',
      { spin: 'Pondering…', meta: '(3m 40s · ↓ 12.6k tokens)' },
    ],
    footer: [['  ? for shortcuts', C.dim], [' · ', C.dim], ['3 agents', C.teal]],
  },
  push: {
    title: 'Push notifications',
    project: 'mobile-app',
    state: 'attention',
    items: [
      { user: 'Add push notifications for new messages.' },
      '',
      { say: 'The notification module needs one new package.' },
    ],
    bottom: [
      { rule: true },
      [[' Bash command', C.blue, true]],
      [],
      [['   pnpm add expo-notifications', C.fg]],
      [['   Install the notifications SDK', C.dim]],
      [],
      [[' Do you want to proceed?', C.fg]],
      [[' ❯ 1. Yes', C.blue]],
      [["   2. Yes, and don't ask again for pnpm add commands", C.fg]],
      [['   3. No, and tell Claude what to do differently (esc)', C.fg]],
    ],
  },
  docs: {
    title: 'API reference docs',
    project: 'docs',
    state: 'working',
    banner: true,
    items: [
      { user: 'Write the API reference pages from openapi.yaml.' },
      '',
      { tool: 'Write', arg: 'docs/api/authentication.md', out: 'Wrote 84 lines' },
      '',
      { tool: 'Write', arg: 'docs/api/projects.md', out: 'Wrote 132 lines' },
      '',
      { tool: 'Write', arg: 'docs/api/webhooks.md', running: true },
      '',
      { spin: 'Composing…', meta: '(6m 03s · ↓ 21.9k tokens)' },
    ],
  },
  release: {
    title: 'Release 2.4',
    project: 'cli-tool',
    state: 'attention',
    items: [
      { user: 'Get 2.4.0 ready to release.' },
      '',
      { ran: 'Ran 3 shell commands' },
      '',
      { tool: 'Bash', arg: 'npm test', out: '58 passed, 0 failed' },
      '',
      { tool: 'Update', arg: 'CHANGELOG.md', out: 'Added 14 lines' },
      '',
      { say: 'All 58 tests pass and the changelog is updated for 2.4.0. Want me to open the pull request?' },
      '',
      { done: 'Worked for 6m 41s' },
    ],
  },
  checkout: {
    title: 'Flaky checkout test',
    project: 'web-store',
    state: 'working',
    items: [
      { user: 'The checkout test fails about one run in five on CI. Find out why.' },
      '',
      { tool: 'Bash', arg: 'npx vitest run checkout --repeat 20', out: '4 of 20 runs failed' },
      '',
      { say: 'Every failure times out waiting for the payment mock. The mock resolves before the listener is attached.' },
      '',
      { tool: 'Update', arg: 'test/checkout.test.ts', running: true },
      '',
      { spin: 'Investigating…', meta: '(2m 51s · ↓ 9.3k tokens)' },
    ],
  },
  tooltips: {
    title: 'Chart tooltips',
    project: 'dashboard',
    state: 'standby',
    items: [
      { user: 'Make the chart tooltips follow the cursor.' },
      '',
      { tool: 'Bash', arg: 'npm run dev', out: 'Running in the background (↓ to manage)' },
      '',
      { tool: 'Update', arg: 'src/charts/Tooltip.tsx', out: 'Added 27 lines, removed 9 lines' },
      '',
      { say: 'The tooltips now follow the cursor and show both series. The dev server is still up at http://localhost:5173.' },
      '',
      { done: 'Worked for 4m 18s' },
    ],
    footer: [['  ', C.dim], ['1 shell', C.teal], [' · ? for shortcuts', C.dim]],
  },
}

// Claude Code's mascot, as a grid of cells; 'h' is a half-width cell.
const MASCOT = ['.#######.', '.#.###.#.', '#########', '.#######.', '..h.h.h.h']

function banner(p, x, y) {
  const out = []
  const s = 7
  MASCOT.forEach((row, r) => {
    ;[...row].forEach((ch, c) => {
      if (ch === '.') return
      const w = ch === 'h' ? s / 2 : s
      out.push(`<rect x="${x + c * s}" y="${y + r * s}" width="${w}" height="${s}" fill="${C.claude}"/>`)
    })
  })
  const tx = x + 9 * s + 18
  out.push(`<text x="${tx}" y="${y + 9}" fill="${C.bright}" font-weight="700">Claude Code <tspan fill="${C.dim}" font-weight="400">v2.1.321</tspan></text>`)
  out.push(`<text x="${tx}" y="${y + 9 + LH}" fill="${C.dim}">Opus 5.5 · Claude Pro</text>`)
  out.push(`<text x="${tx}" y="${y + 9 + LH * 2}" fill="${C.dim}">${esc('~\\Documents\\GitHub\\' + p.project)}</text>`)
  return out.join('\n')
}

function rowSvg(row, x, y, x2) {
  if (row.rule) return `<line x1="${x}" x2="${x2}" y1="${y - 4}" y2="${y - 4}" stroke="${C.rule}" stroke-width="1"/>`
  let pre = ''
  if (row.bar) {
    pre = `<rect x="${x - 8}" y="${y - LH + 5}" width="${x2 - x + 16}" height="${LH}" fill="#FFFFFF" fill-opacity="0.08"/>`
    row = row.bar
  }
  if (!row.length) return pre
  const spans = row.map(([t, color, bold]) => `<tspan fill="${color || C.fg}"${bold ? ' font-weight="700"' : ''}>${esc(t)}</tspan>`).join('')
  return pre + `<text x="${x}" y="${y}" xml:space="preserve">${spans}</text>`
}

function windowControls(x, y) {
  const out = []
  const st = `stroke="${C.dim}" stroke-width="1" fill="none"`
  const cy = y + 20
  const cx = [x - 118, x - 72, x - 26]
  out.push(`<line x1="${cx[0] - 5}" x2="${cx[0] + 5}" y1="${cy}" y2="${cy}" ${st}/>`)
  out.push(`<rect x="${cx[1] - 5}" y="${cy - 5}" width="10" height="10" ${st}/>`)
  out.push(`<path d="M${cx[2] - 5} ${cy - 5} L${cx[2] + 5} ${cy + 5} M${cx[2] + 5} ${cy - 5} L${cx[2] - 5} ${cy + 5}" ${st}/>`)
  return out.join('\n')
}

function tabStrip(p, x, y, pw) {
  const out = []
  const tw = Math.min(250, pw * 0.42)
  const tx = x + 8
  // The active tab: a lighter shape with rounded top corners.
  out.push(`<path d="M${tx} ${y + TAB} L${tx} ${y + 14} Q${tx} ${y + 8} ${tx + 6} ${y + 8} L${tx + tw - 6} ${y + 8} Q${tx + tw} ${y + 8} ${tx + tw} ${y + 14} L${tx + tw} ${y + TAB} Z" fill="#FFFFFF" fill-opacity="0.07"/>`)
  // PowerShell profile icon.
  out.push(`<rect x="${tx + 12}" y="${y + 18}" width="15" height="13" rx="2" fill="#2F6FB8"/>`)
  out.push(`<path d="M${tx + 15} ${y + 21.5} L${tx + 19} ${y + 24.5} L${tx + 15} ${y + 27.5} M${tx + 20} ${y + 28} L${tx + 24} ${y + 28}" stroke="#FFFFFF" stroke-width="1.3" fill="none"/>`)
  // Claude Code puts a spinner in the title while it works and ✳ when idle.
  const glyph = p.state === 'working' ? '◐' : '✳'
  const max = Math.floor((tw - 76) / 6.3)
  const title = p.title.length > max ? p.title.slice(0, max - 1) + '…' : p.title
  out.push(`<text x="${tx + 36}" y="${y + 29}" fill="${C.bright}" font-family="${UI}" font-size="12">${glyph} ${esc(title)}</text>`)
  out.push(`<path d="M${tx + tw - 20} ${y + 21} L${tx + tw - 12} ${y + 29} M${tx + tw - 12} ${y + 21} L${tx + tw - 20} ${y + 29}" stroke="${C.dim}" stroke-width="1" fill="none"/>`)
  const px = tx + tw + 20
  out.push(`<path d="M${px - 5} ${y + 25} L${px + 5} ${y + 25} M${px} ${y + 20} L${px} ${y + 30}" stroke="${C.dim}" stroke-width="1" fill="none"/>`)
  out.push(`<path d="M${px + 26} ${y + 23} L${px + 30} ${y + 27} L${px + 34} ${y + 23}" stroke="${C.dim}" stroke-width="1" fill="none"/>`)
  out.push(windowControls(x + pw, y))
  return out.join('\n')
}

function pane(p, x, y, pw, ph) {
  const out = []
  const clip = `clip-${x}-${y}`.replace(/\./g, '_')
  out.push(`<clipPath id="${clip}"><rect x="${x}" y="${y}" width="${pw}" height="${ph}" rx="6"/></clipPath>`)
  out.push(`<g clip-path="url(#${clip})">`)
  // The tint covers the tab row too, as it does in Windows Terminal.
  out.push(`<rect x="${x}" y="${y}" width="${pw}" height="${ph}" fill="${C[p.state]}"/>`)
  out.push(tabStrip(p, x, y, pw))
  const lx = x + 16
  const x2 = x + pw - 16
  const cols = Math.floor((x2 - lx) / CW)
  let ly = y + TAB + 24
  if (p.banner) {
    out.push(banner(p, lx, ly - 10))
    ly += LH * 3 + 14
  }
  for (const row of rows(p.items, cols)) {
    out.push(rowSvg(row, lx, ly, x2))
    ly += LH
  }
  // The prompt box, or a permission dialog, sits at the bottom of the window.
  const bottom = p.bottom || promptBox(p.footer)
  let by = y + ph - 16 - LH * (bottom.length - 1)
  for (const row of bottom) {
    out.push(rowSvg(row, lx, by, x2))
    by += LH
  }
  out.push('</g>')
  out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${pw - 1}" height="${ph - 1}" rx="6" fill="none" stroke="${C.border}"/>`)
  return out.join('\n')
}

// The Windows 11 taskbar: Start, Search, a few pinned apps with Terminal
// open, and the clock.
function taskbar(y) {
  const out = []
  const h = TASKBAR
  const cy = y + h / 2
  out.push(`<rect x="0" y="${y}" width="${W}" height="${h}" fill="#1C1C1C"/>`)
  out.push(`<line x1="0" x2="${W}" y1="${y + 0.5}" y2="${y + 0.5}" stroke="#2E2E2E"/>`)
  // Start.
  const sx = 14
  for (const [dx, dy] of [[0, 0], [10, 0], [0, 10], [10, 10]]) {
    out.push(`<rect x="${sx + dx}" y="${cy - 10 + dy}" width="9" height="9" fill="#4CC2FF"/>`)
  }
  // Search box.
  out.push(`<rect x="48" y="${cy - 16}" width="190" height="32" rx="16" fill="#2B2B2B" stroke="#3A3A3A"/>`)
  out.push(`<circle cx="68" cy="${cy - 1}" r="5.5" stroke="#CFCFCF" stroke-width="1.4" fill="none"/>`)
  out.push(`<line x1="72" y1="${cy + 3}" x2="76" y2="${cy + 7}" stroke="#CFCFCF" stroke-width="1.4"/>`)
  out.push(`<text x="86" y="${cy + 5}" fill="#CFCFCF" font-family="${UI}" font-size="13">Search</text>`)
  // Pinned apps: Task View, File Explorer, a browser, Settings, then Terminal
  // (running, with four windows: the active-app pill).
  let ix = 262
  const icon = (draw, running) => {
    out.push(draw(ix, cy))
    if (running) out.push(`<rect x="${ix - 8}" y="${y + h - 5}" width="16" height="3" rx="1.5" fill="#4CC2FF"/>`)
    ix += 44
  }
  icon((x, c) => `<rect x="${x - 9}" y="${c - 8}" width="8" height="16" rx="1.5" fill="#E6E6E6"/><rect x="${x + 1}" y="${c - 8}" width="8" height="16" rx="1.5" fill="none" stroke="#E6E6E6" stroke-width="1.4"/>`)
  icon((x, c) => `<path d="M${x - 11} ${c - 7} h8 l2 2 h12 v13 h-22 Z" fill="#F4C542"/><rect x="${x - 11}" y="${c - 3}" width="22" height="11" fill="#FFD966"/>`)
  icon((x, c) => `<circle cx="${x}" cy="${c}" r="11" fill="#2A8CF0"/><circle cx="${x}" cy="${c}" r="5" fill="#BFE3FF"/>`)
  icon((x, c) => `<circle cx="${x}" cy="${c}" r="9" fill="none" stroke="#B9B9B9" stroke-width="3" stroke-dasharray="3 2.2"/><circle cx="${x}" cy="${c}" r="3.5" fill="#B9B9B9"/>`)
  icon(
    (x, c) =>
      `<rect x="${x - 12}" y="${c - 10}" width="24" height="20" rx="3" fill="#2B2B2B" stroke="#6A6A6A"/><path d="M${x - 7} ${c - 4} L${x - 2} ${c} L${x - 7} ${c + 4} M${x} ${c + 5} L${x + 6} ${c + 5}" stroke="#FFFFFF" stroke-width="1.6" fill="none"/>`,
    true,
  )
  // Tray: hidden icons, network, volume, battery, clock.
  const tx = W - 210
  out.push(`<path d="M${tx - 4} ${cy + 3} L${tx} ${cy - 2} L${tx + 4} ${cy + 3}" stroke="#E6E6E6" stroke-width="1.3" fill="none"/>`)
  out.push(`<path d="M${tx + 26} ${cy + 1} q9 -8 18 0 M${tx + 29} ${cy + 4} q6 -5 12 0" stroke="#E6E6E6" stroke-width="1.4" fill="none"/><circle cx="${tx + 35}" cy="${cy + 7}" r="1.6" fill="#E6E6E6"/>`)
  out.push(`<path d="M${tx + 56} ${cy - 3} h4 l5 -4 v14 l-5 -4 h-4 Z" fill="#E6E6E6"/><path d="M${tx + 69} ${cy - 4} q4 4 0 8" stroke="#E6E6E6" stroke-width="1.4" fill="none"/>`)
  out.push(`<rect x="${tx + 82}" y="${cy - 5}" width="20" height="10" rx="2" fill="none" stroke="#E6E6E6" stroke-width="1.2"/><rect x="${tx + 84}" y="${cy - 3}" width="13" height="6" fill="#E6E6E6"/><rect x="${tx + 102}" y="${cy - 2}" width="2" height="4" fill="#E6E6E6"/>`)
  out.push(`<text x="${W - 16}" y="${cy - 3}" text-anchor="end" fill="#E6E6E6" font-family="${UI}" font-size="12">2:45 PM</text>`)
  out.push(`<text x="${W - 16}" y="${cy + 13}" text-anchor="end" fill="#E6E6E6" font-family="${UI}" font-size="12">2026-11-09</text>`)
  return out.join('\n')
}

function write(file, title, w, h, body) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Cascadia Mono, Consolas, Menlo, monospace" font-size="${FS}">
<title>${esc(title)}</title>
<rect width="${w}" height="${h}" fill="${C.backdrop}"/>
${body.join('\n')}
</svg>
`
  writeFileSync(new URL(`../${file}`, import.meta.url), svg)
  console.log('wrote', file, w, 'x', h)
}

// A 1600 x 900 Windows desktop: the Terminal windows snapped into a grid
// above the taskbar.
function desktop({ file, title, cols, panes }) {
  const nrows = Math.ceil(panes.length / cols)
  const pw = (W - GAP * (cols - 1)) / cols
  const ph = (H - TASKBAR - GAP * (nrows - 1)) / nrows
  const body = []
  panes.forEach((p, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    body.push(pane(p, col * (pw + GAP), row * (ph + GAP), pw, ph))
  })
  body.push(taskbar(H - TASKBAR))
  write(file, title, W, H, body)
}

const LEGEND = {
  working: ['Working', 'Claude, a subagent, or a scheduled run is busy'],
  standby: ['Standing by', 'only a background shell, such as a dev server, runs'],
  attention: ['Needs you', 'your normal background: a question, a prompt, or done'],
}

// One window per state in a row, each with its legend entry underneath.
function states({ file, title, panes }) {
  const pad = 20
  const gap = 14
  const pw = (W - pad * 2 - gap * (panes.length - 1)) / panes.length
  const ph = 400
  const body = []
  panes.forEach((p, i) => {
    const x = pad + i * (pw + gap)
    body.push(pane(p, x, pad, pw, ph))
    const [label, note] = LEGEND[p.state]
    const ly = pad + ph + 18
    body.push(`<rect x="${x}" y="${ly}" width="34" height="34" rx="6" fill="${C[p.state]}" stroke="#6A6A6A"/>`)
    body.push(`<text x="${x + 46}" y="${ly + 14}" fill="#EEEEEE" font-family="${UI}" font-size="15" font-weight="600">${label}</text>`)
    body.push(`<text x="${x + 46}" y="${ly + 32}" fill="#A8A8A8" font-family="${UI}" font-size="13">${esc(note)}</text>`)
  })
  const ny = pad + ph + 18 + 34 + 34
  body.push(`<text x="${pad}" y="${ny}" fill="#A8A8A8" font-family="${UI}" font-size="13">Pick your own colors with <tspan fill="#EEEEEE" font-family="Cascadia Mono, Consolas, monospace">/glance-color</tspan>, for example <tspan fill="#EEEEEE" font-family="Cascadia Mono, Consolas, monospace">/glance-color standby #3A2A55</tspan>. Needs you is always your terminal's own background.</text>`)
  write(file, title, W, ny + pad, body)
}

desktop({
  file: 'preview.svg',
  title: 'glance: four Claude Code sessions, one finished and waiting on you',
  cols: 2,
  panes: [P.rate, P.release, P.landing, P.docs],
})

desktop({
  file: 'preview-six.svg',
  title: 'glance: six Claude Code sessions, two waiting on you',
  cols: 3,
  panes: [P.rate, P.landing, P.push, P.docs, P.release, P.checkout],
})

states({
  file: 'states.svg',
  title: "glance's three states: working, standing by, and needs you",
  panes: [P.docs, P.tooltips, P.release],
})
