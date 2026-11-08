// Release versioning for glance, run by CI: no release pull request.
//
// `prepare` runs on the dev-to-main pull request. It reads the conventional
// commits since main, works out the next version, and writes it to
// plugin.json with a matching CHANGELOG.md section, so the version bump is
// part of what gets merged. `notes <version>` prints that version's section,
// which the release workflow publishes on main.
//
// The rules, for a version a.b.c: a `feat:` bumps b (and resets c); any other
// code change (`fix:`, `perf:`, `refactor:`, `revert:`) bumps c; `docs:`,
// `test:`, `ci:`, and `chore:` release nothing on their own. Nothing here
// bumps a: the maintainer raises it by hand in plugin.json on dev, and that
// version is kept. A breaking mark (`feat!:`, a `BREAKING CHANGE:` footer)
// only lists the commit under its own changelog heading.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const REPO_URL = 'https://github.com/rogadev/glance'
const PLUGIN = '.claude-plugin/plugin.json'
const CHANGELOG = 'CHANGELOG.md'
/** The subject of the commit `prepare` makes, so it never counts itself. */
export const RELEASE_SUBJECT = /^chore: release \d+\.\d+\.\d+$/

/**
 * Parses a commit into its conventional-commit parts, or null when the
 * subject isn't one.
 * @param {{ sha: string, subject: string, body: string }} commit
 */
export function parseCommit({ sha, subject, body }) {
  const m = /^(\w+)(?:\([^)]*\))?(!)?: (.+)$/.exec(subject)
  if (!m) return null
  const breaking = Boolean(m[2]) || /^BREAKING[ -]CHANGE: /m.test(body)
  return { sha, type: m[1].toLowerCase(), breaking, description: m[3] }
}

/** Commit types that change the code users run, short of a feature: each is a patch release. */
const PATCH_TYPES = new Set(['fix', 'perf', 'refactor', 'revert'])

/**
 * Gets the kind of bump a list of parsed commits calls for. Never the major
 * version: the maintainer sets that by hand (see `plan`).
 * @returns {'minor' | 'patch' | null}
 */
export function bumpOf(parsed) {
  if (parsed.some((c) => c.type === 'feat')) return 'minor'
  if (parsed.some((c) => PATCH_TYPES.has(c.type))) return 'patch'
  return null
}

/** Parses an `x.y.z` version into numbers, or throws. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (!m) throw new Error(`not an x.y.z version: ${JSON.stringify(v)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Applies a minor or patch bump to an `x.y.z` version. */
export function nextVersion(base, bump) {
  const [major, minor, patch] = parseVersion(base)
  if (!bump) return base
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** Checks whether version `a` is newer than version `b`. */
export function isNewer(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (const [i, n] of x.entries()) {
    const m = y[i]
    if (m !== undefined && n !== m) return n > m
  }
  return false
}

/** Builds the CHANGELOG.md section for one release. */
export function changelogSection(version, base, date, parsed) {
  const line = (c) => `* ${c.description} ([${c.sha.slice(0, 7)}](${REPO_URL}/commit/${c.sha}))`
  const groups = [
    ['⚠ BREAKING CHANGES', parsed.filter((c) => c.breaking)],
    ['Features', parsed.filter((c) => c.type === 'feat' && !c.breaking)],
    ['Bug Fixes', parsed.filter((c) => (c.type === 'fix' || c.type === 'perf') && !c.breaking)],
    ['Other changes', parsed.filter((c) => (c.type === 'refactor' || c.type === 'revert') && !c.breaking)],
  ]
  const parts = [`## [${version}](${REPO_URL}/compare/v${base}...v${version}) (${date})`]
  for (const [title, commits] of groups) {
    if (commits.length) parts.push(`### ${title}`, commits.map(line).join('\n'))
  }
  return parts.join('\n\n') + '\n'
}

/** Splits CHANGELOG.md into its header and its `## [x.y.z]` sections, newest first. */
function splitChangelog(text) {
  const starts = [...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)]
  const header = starts.length ? text.slice(0, starts[0].index) : text
  const sections = starts.map((m, i) => ({
    version: m[1],
    text: text.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : undefined),
  }))
  return { header, sections }
}

/**
 * Puts `section` (unless empty) at the top of the changelog, first dropping every section
 * newer than `base`: those were written for a version that never shipped (a
 * later commit on dev changed the bump).
 */
export function updateChangelog(text, base, section) {
  const { header, sections } = splitChangelog(text || '# Changelog\n\n')
  const kept = sections.filter((s) => !isNewer(s.version, base))
  const top = header.trimEnd() + '\n\n'
  const body = [section, ...kept.map((s) => s.text)].filter((s) => s.trim())
  return top + body.map((s) => s.trimEnd() + '\n').join('\n')
}

/** Gets one version's section from the changelog, without its heading, or ''. */
export function notesFor(text, version) {
  const s = splitChangelog(text).sections.find((x) => x.version === version)
  if (!s) return ''
  return s.text.replace(/^## .*\n/, '').trim() + '\n'
}

/**
 * Works out what `prepare` writes, from the version on main, the commits on
 * dev since main, today's date, and the version in dev's plugin.json. A major
 * version raised by hand on dev is kept as it is; any other version on dev is
 * replaced by the computed one. Returns null when nothing releases.
 */
export function plan(base, commits, date, current = base) {
  const parsed = commits
    .filter((c) => !RELEASE_SUBJECT.test(c.subject))
    .map(parseCommit)
    .filter((c) => c !== null)
  const byHand = parseVersion(current)[0] > parseVersion(base)[0]
  const version = byHand ? current : nextVersion(base, bumpOf(parsed))
  if (version === base) return null
  return { version, section: changelogSection(version, base, date, parsed) }
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

/** Reads the commits on HEAD since `ref`, oldest first, merges left out. */
function commitsSince(ref) {
  const out = git('log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', `${ref}..HEAD`)
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body = ''] = r.split('\x1f')
      return { sha, subject, body }
    })
}

function prepare(baseRef) {
  const base = JSON.parse(git('show', `${baseRef}:${PLUGIN}`)).version
  const since = git('merge-base', 'HEAD', baseRef).trim()
  const pluginText = readFileSync(PLUGIN, 'utf8')
  const current = JSON.parse(pluginText).version
  const result = plan(base, commitsSince(since), new Date().toISOString().slice(0, 10), current)
  const version = result?.version ?? base
  console.log(result ? `Release ${version} (main has ${base}).` : `Nothing to release (main has ${base}).`)
  if (current !== version) {
    writeFileSync(PLUGIN, pluginText.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`))
  }
  let changelog = ''
  try {
    changelog = readFileSync(CHANGELOG, 'utf8')
  } catch {
    console.log(`No ${CHANGELOG} yet; writing a new one.`)
  }
  // A section already written for this version with the same entries stays as
  // it is, so a rerun on a later day doesn't rewrite its date. With nothing to
  // release, this still drops a section written for a bump a later commit
  // took back.
  const same = result && notesFor(changelog, version) === notesFor(result.section, version)
  const next = same ? changelog : updateChangelog(changelog, base, result?.section ?? '')
  if (next.trim() !== changelog.trim()) writeFileSync(CHANGELOG, next)
}

function main([mode, arg]) {
  if (mode === 'prepare' && arg) return prepare(arg)
  if (mode === 'notes' && arg) {
    const notes = notesFor(readFileSync(CHANGELOG, 'utf8'), arg)
    if (!notes) throw new Error(`${CHANGELOG} has no section for ${arg}`)
    return process.stdout.write(notes)
  }
  throw new Error('usage: node .github/scripts/release.mjs prepare <base ref> | notes <version>')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`release: ${err.message}`)
    process.exit(1)
  }
}
