// Builds .github/preview.svg, the README's picture of glance: six mock Windows
// Terminal panes in glance's three states, using the colors in CONFIG.
// Run: node .github/scripts/preview.mjs
import { writeFileSync } from 'node:fs'

import { CONFIG } from '../../glance.mjs'

const C = {
  working: CONFIG.workingColor,
  standby: CONFIG.standbyColor,
  // Needs you resets to the profile background; Windows Terminal's default.
  attention: '#0C0C0C',
  fg: '#CCCCCC',
  dim: '#8B8B8B',
  green: '#4EBA65',
  claude: '#D77757',
  blue: '#7AA2F7',
  rule: '#5A5A5A',
  backdrop: '#2B2B2B',
}

const W = 1600
const PAD = 20
const GAP = 14
const COLS = 3
const PW = (W - PAD * 2 - GAP * (COLS - 1)) / COLS
const PH = 335
const TAB = 34
const LH = 17
const FS = 12.5
const LEGEND = 70
const H = PAD * 2 + PH * 2 + GAP + LEGEND

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A line is a list of [text, color?, bold?] segments; '' is a blank line.
const promptBox = (text = '') => [
  { rule: true },
  [['> ', C.fg], [text, C.fg]],
  { rule: true },
  [['  ? for shortcuts', C.dim]],
]

const panes = [
  {
    title: 'Add rate limiting',
    project: 'api-server',
    state: 'working',
    lines: [
      [['● ', C.fg], ["I'll add a rate limiter to the public endpoints.", C.fg]],
      '',
      [['● ', C.green], ['Update', C.fg, true], ['(src/middleware/rateLimit.ts)', C.fg]],
      [['  └ ', C.dim], ['Added 18 lines', C.dim]],
      '',
      [['● ', C.green], ['Update', C.fg, true], ['(src/routes/public.ts)', C.fg]],
      [['  └ ', C.dim], ['Added 2 lines, removed 1 line', C.dim]],
      '',
      [['● ', C.dim], ['Bash', C.fg, true], ['(npm test -- rateLimit)', C.fg]],
      [['  └ ', C.dim], ['Running…', C.dim]],
      '',
      [['✻ ', C.claude], ['Brewing… ', C.claude], ['(1m 12s · ↓ 4.1k tokens)', C.dim]],
    ],
  },
  {
    title: 'Landing page refresh',
    project: 'marketing-site',
    state: 'working',
    lines: [
      [['● ', C.fg], ['Splitting the audit three ways so it goes faster.', C.fg]],
      '',
      [['● ', C.green], ['3 background agents launched', C.fg], [' (↓ to manage)', C.dim]],
      [['  ├ ', C.dim], ['Audit page speed', C.fg]],
      [['  ├ ', C.dim], ['Check copy for broken links', C.fg]],
      [['  └ ', C.dim], ['Review mobile layout', C.fg]],
      '',
      [['● ', C.fg], ['While they run, I\'m tightening the hero section.', C.fg]],
      '',
      [['● ', C.green], ['Read', C.fg, true], ['(src/components/Hero.astro)', C.fg]],
      '',
      [['✻ ', C.claude], ['Pondering… ', C.claude], ['(3m 40s · ↓ 12.6k tokens)', C.dim]],
    ],
  },
  {
    title: 'Push notifications',
    project: 'mobile-app',
    state: 'attention',
    lines: [
      [['● ', C.fg], ['The notification module needs one new package.', C.fg]],
      '',
      { rule: true },
      [[' Bash command', C.blue, true]],
      '',
      [['   pnpm add expo-notifications', C.fg]],
      [['   Install the notifications SDK', C.dim]],
      '',
      [[' Do you want to proceed?', C.fg]],
      [[' ❯ 1. Yes', C.blue]],
      [['   2. Yes, and don\'t ask again for pnpm add', C.fg]],
      [['   3. No, and tell Claude what to do differently', C.fg]],
      { rule: true },
    ],
    noPrompt: true,
  },
  {
    title: 'API reference docs',
    project: 'docs',
    state: 'working',
    lines: [
      [['● ', C.fg], ['Writing the reference pages from the OpenAPI spec.', C.fg]],
      '',
      [['● ', C.green], ['Write', C.fg, true], ['(docs/api/authentication.md)', C.fg]],
      [['  └ ', C.dim], ['Wrote 84 lines', C.dim]],
      '',
      [['● ', C.green], ['Write', C.fg, true], ['(docs/api/projects.md)', C.fg]],
      [['  └ ', C.dim], ['Wrote 132 lines', C.dim]],
      '',
      [['● ', C.dim], ['Write', C.fg, true], ['(docs/api/webhooks.md)', C.fg]],
      '',
      [['✻ ', C.claude], ['Composing… ', C.claude], ['(6m 03s · ↓ 21.9k tokens)', C.dim]],
    ],
  },
  {
    title: 'Chart tooltips',
    project: 'dashboard',
    state: 'standby',
    lines: [
      [['● ', C.green], ['Background command ', C.fg], ['"Start the dev server"', C.fg], [' running', C.dim]],
      [['  └ ', C.dim], ['Local: http://localhost:5173/', C.dim]],
      '',
      [['● ', C.fg], ['The tooltips now follow the cursor and show both', C.fg]],
      [['  series. The dev server is still up, so you can', C.fg]],
      [['  try it at http://localhost:5173.', C.fg]],
      '',
      [['✻ ', C.dim], ['Worked for 4m 18s', C.dim]],
    ],
  },
  {
    title: 'Release 2.4',
    project: 'cli-tool',
    state: 'attention',
    lines: [
      [['● ', C.green], ['Bash', C.fg, true], ['(npm test)', C.fg]],
      [['  └ ', C.dim], ['58 passed, 0 failed', C.dim]],
      '',
      [['● ', C.fg], ['All 58 tests pass and the changelog is updated', C.fg]],
      [['  for 2.4.0. Want me to open the pull request?', C.fg]],
      '',
      [['✻ ', C.dim], ['Worked for 6m 41s', C.dim]],
    ],
  },
]

function pane(p, x, y) {
  const bg = C[p.state]
  const out = []
  const clip = `clip-${x}-${y}`.replace(/\./g, '_')
  out.push(`<clipPath id="${clip}"><rect x="${x}" y="${y}" width="${PW}" height="${PH}" rx="8"/></clipPath>`)
  out.push(`<g clip-path="url(#${clip})">`)
  out.push(`<rect x="${x}" y="${y}" width="${PW}" height="${PH}" fill="${bg}"/>`)
  // Tab row: the tint covers it too, as in Windows Terminal.
  const tx = x + 10
  out.push(`<rect x="${tx}" y="${y + 6}" width="230" height="${TAB - 6}" rx="6" fill="#FFFFFF" fill-opacity="0.06"/>`)
  out.push(`<text x="${tx + 12}" y="${y + 25}" fill="${C.claude}" font-size="12">✻</text>`)
  out.push(`<text x="${tx + 28}" y="${y + 25}" fill="${C.fg}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12">${esc(p.title)}</text>`)
  out.push(`<text x="${tx + 212}" y="${y + 25}" fill="${C.dim}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="12">×</text>`)
  out.push(`<text x="${tx + 248}" y="${y + 25}" fill="${C.dim}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="14">+</text>`)
  for (const [i, ch] of ['–', '□', '×'].entries()) {
    out.push(`<text x="${x + PW - 84 + i * 30}" y="${y + 24}" fill="${C.dim}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13">${ch}</text>`)
  }
  let ly = y + TAB + 26
  const lx = x + 16
  const all = [...p.lines, '', ...(p.noPrompt ? [] : promptBox())]
  for (const line of all) {
    if (line === '') {
      ly += LH * 0.7
      continue
    }
    if (line.rule) {
      out.push(`<line x1="${lx}" x2="${x + PW - 16}" y1="${ly - 4}" y2="${ly - 4}" stroke="${C.rule}" stroke-width="1"/>`)
      ly += LH * 0.8
      continue
    }
    const spans = line
      .map(([t, color, bold]) => `<tspan fill="${color || C.fg}"${bold ? ' font-weight="700"' : ''}>${esc(t)}</tspan>`)
      .join('')
    out.push(`<text x="${lx}" y="${ly}" xml:space="preserve">${spans}</text>`)
    ly += LH
  }
  // Project name, bottom right, so each pane reads at a glance.
  out.push(`<text x="${x + PW - 16}" y="${y + PH - 14}" text-anchor="end" fill="${C.dim}">${esc(p.project)}</text>`)
  out.push('</g>')
  out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${PW - 1}" height="${PH - 1}" rx="8" fill="none" stroke="#000" stroke-opacity="0.5"/>`)
  return out.join('\n')
}

const body = []
panes.forEach((p, i) => {
  const col = i % COLS
  const row = Math.floor(i / COLS)
  body.push(pane(p, PAD + col * (PW + GAP), PAD + row * (PH + GAP)))
})

// Legend.
const legend = [
  ['working', 'Working', 'Claude, a subagent, or a scheduled run is busy'],
  ['standby', 'Standing by', 'only a background shell, such as a dev server, runs'],
  ['attention', 'Needs you', 'your normal background: a question, a prompt, or done'],
]
const ly = PAD * 2 + PH * 2 + GAP + 14
const colW = (W - PAD * 2) / 3
legend.forEach(([key, label, note], i) => {
  const lx = PAD + i * colW
  body.push(`<rect x="${lx}" y="${ly}" width="34" height="34" rx="6" fill="${C[key]}" stroke="#6A6A6A"/>`)
  body.push(`<text x="${lx + 46}" y="${ly + 14}" fill="#EEEEEE" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="15" font-weight="600">${label}</text>`)
  body.push(`<text x="${lx + 46}" y="${ly + 32}" fill="#A8A8A8" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="13">${esc(note)}</text>`)
})

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Cascadia Mono, Consolas, Menlo, monospace" font-size="${FS}">
<title>glance: six Claude Code sessions, tinted by state</title>
<rect width="${W}" height="${H}" fill="${C.backdrop}"/>
${body.join('\n')}
</svg>
`
writeFileSync(new URL('../preview.svg', import.meta.url), svg)
console.log('wrote', W, 'x', H)
