import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bumpOf,
  changelogSection,
  nextVersion,
  notesFor,
  parseCommit,
  plan,
  REPO_URL,
  updateChangelog,
} from '../.github/scripts/release.mjs'

const commit = (subject, body = '', sha = 'a'.repeat(40)) => ({ sha, subject, body })
const types = (...subjects) => subjects.map((s) => parseCommit(commit(s)))

test('parseCommit reads the type, a scope, and a breaking mark', () => {
  assert.deepEqual(parseCommit(commit('feat(mod): add a band')), {
    sha: 'a'.repeat(40),
    type: 'feat',
    breaking: false,
    description: 'add a band',
  })
  assert.equal(parseCommit(commit('fix!: drop Node 18')).breaking, true)
  assert.equal(parseCommit(commit('feat: new state file', 'BREAKING CHANGE: old files are ignored')).breaking, true)
  assert.equal(parseCommit(commit('Merge pull request #14 from rogadev/dev')), null)
  assert.equal(parseCommit(commit('update the readme')), null)
})

test('bumpOf picks the largest bump the commits call for', () => {
  assert.equal(bumpOf(types('docs: a', 'test: b', 'chore: c', 'ci: d')), null)
  assert.equal(bumpOf(types('docs: a', 'fix: b')), 'patch')
  assert.equal(bumpOf(types('perf: a')), 'patch')
  assert.equal(bumpOf(types('fix: a', 'feat: b')), 'minor')
  assert.equal(bumpOf(types('feat: a', 'refactor!: b')), 'major')
})

test('nextVersion bumps, and a breaking change before 1.0.0 is a minor bump', () => {
  assert.equal(nextVersion('0.3.0', 'patch'), '0.3.1')
  assert.equal(nextVersion('0.3.4', 'minor'), '0.4.0')
  assert.equal(nextVersion('0.3.4', 'major'), '0.4.0')
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0')
  assert.equal(nextVersion('1.2.3', null), '1.2.3')
  assert.throws(() => nextVersion('1.2', 'patch'), /not an x\.y\.z version/)
})

test('plan releases nothing for docs, tests, and chores, and never counts its own commit', () => {
  assert.equal(plan('0.3.0', [commit('docs: a'), commit('chore: release 0.3.1'), commit('test: b')], '2026-11-08'), null)
  assert.equal(plan('0.3.0', [], '2026-11-08'), null)
})

test('plan gives the next version and its changelog section', () => {
  const p = plan('0.3.0', [commit('fix: one', '', '1'.repeat(40)), commit('feat: two', '', '2'.repeat(40)), commit('docs: three')], '2026-11-08')
  assert.equal(p.version, '0.4.0')
  assert.equal(
    p.section,
    [
      `## [0.4.0](${REPO_URL}/compare/v0.3.0...v0.4.0) (2026-11-08)`,
      '### Features',
      `* two ([2222222](${REPO_URL}/commit/${'2'.repeat(40)}))`,
      '### Bug Fixes',
      `* one ([1111111](${REPO_URL}/commit/${'1'.repeat(40)}))`,
    ].join('\n\n') + '\n',
  )
})

test('a breaking change is listed under its own heading only', () => {
  const s = changelogSection('0.4.0', '0.3.0', '2026-11-08', types('feat!: new config', 'feat: other'))
  assert.match(s, /### ⚠ BREAKING CHANGES\n\n\* new config/)
  assert.match(s, /### Features\n\n\* other/)
  assert.equal(s.match(/new config/g).length, 1)
})

const LOG = `# Changelog

## [0.3.0](${REPO_URL}/compare/v0.2.0...v0.3.0) (2026-11-08)

### Features

* three

## [0.2.0](${REPO_URL}/compare/v0.1.0...v0.2.0) (2026-11-07)

### Bug Fixes

* two
`

test('updateChangelog puts the new section first and keeps the released ones', () => {
  const next = updateChangelog(LOG, '0.3.0', '## [0.3.1](x) (2026-11-09)\n\n### Bug Fixes\n\n* four\n')
  assert.ok(next.startsWith('# Changelog\n\n## [0.3.1](x)'))
  assert.ok(next.includes('## [0.3.0]') && next.includes('## [0.2.0]'))
  assert.equal(updateChangelog(next, '0.3.0', '## [0.3.1](x) (2026-11-09)\n\n### Bug Fixes\n\n* four\n'), next)
})

test('updateChangelog drops a section for a version that never shipped', () => {
  const patch = updateChangelog(LOG, '0.3.0', '## [0.3.1](x) (2026-11-09)\n\n* four\n')
  const minor = updateChangelog(patch, '0.3.0', '## [0.4.0](x) (2026-11-09)\n\n* five\n')
  assert.ok(!minor.includes('0.3.1'))
  assert.ok(minor.startsWith('# Changelog\n\n## [0.4.0](x)'))
  const none = updateChangelog(patch, '0.3.0', '')
  assert.ok(!none.includes('0.3.1'))
  assert.ok(none.startsWith('# Changelog\n\n## [0.3.0]'))
})

test('updateChangelog starts a changelog when there is none', () => {
  assert.equal(updateChangelog('', '0.0.0', '## [0.1.0](x) (d)\n\n* one\n'), '# Changelog\n\n## [0.1.0](x) (d)\n\n* one\n')
})

test('notesFor gives one version body, without its heading', () => {
  assert.equal(notesFor(LOG, '0.3.0'), '### Features\n\n* three\n')
  assert.equal(notesFor(LOG, '0.2.0'), '### Bug Fixes\n\n* two\n')
  assert.equal(notesFor(LOG, '9.9.9'), '')
})
