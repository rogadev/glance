---
name: deep-review
description: Deep review of a branch or range in glance (a Claude Code mod: a Node hook script, a TypeScript hooks module, and a Windows console painter), sized to what changed. Use when the user says "/deep-review", "review my branch", "review dev before the PR", or "is this ready to merge".
argument-hint: "[ref | a..b | #PR | working] [quick | full] [auto]"
based-on: orc-review@1.22.0
template: 4
template-reviewed: 4
---

# Deep review: glance

This is a project profile for orc-pack's `orc-review` skill. Invoke the `orc-review` skill with `$ARGUMENTS (profile: .claude/skills/deep-review/SKILL.md)` and run its workflow with the profile below. Edit only the profile; the workflow lives in `orc-review` and updates with the pack. The pack's generic lanes are the base; **Repo lanes** adds this project's specialists only where the base is thin.

## Stack

- **Framework:** none. Plain Node ES modules (`glance.mjs`, `schedule.mjs`, Node 20 and 22 in CI), a Claude Code hooks module in TypeScript (`hooks/register.tsx`, engine 2.1.319), and a C# console helper (`paint.cs`, built with the .NET Framework `csc.exe`). No framework playbook.
- **Platform:** none (a Claude Code plugin installed from this repo through `.claude-plugin/marketplace.json`). No platform playbook.
- **Run locally:** there is no app to serve. On the maintainer's machine this folder is the live install (`CLAUDE_CODE_PLUGIN_DIRS`), so a new Claude Code session runs the working copy.

## Checks

| Check     | Command                                                                                          | When                                                                         |
| --------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| install   | none (no dependencies)                                                                           | worktree                                                                     |
| test      | `node --test test/glance.test.mjs test/schedule.test.mjs test/smoke.test.mjs test/terminal.test.mjs test/release.test.mjs` | always                                                                       |
| mod tests | `claude plugin test .`                                                                           | always                                                                       |
| validate  | `claude plugin validate .`                                                                       | always                                                                       |
| typecheck | `npx -y -p typescript@5.6.3 tsc -p . --noEmit`                                                   | the range ends at `HEAD` (it needs `.claude-plugin/types/`, which the engine writes and git ignores, so it can't run in a worktree) |
| paint     | `pwsh -File build.ps1 -Check`                                                                    | `paint.cs`, `paint.exe`, or `build.ps1` changed (Windows only)               |
| live      | `node test/live/run.mjs`                                                                         | remind: `glance.mjs`, `hooks/register.tsx`, or `test/live/**` changed        |

**Never run:** `build.ps1` without `-Check` (it swaps in a new `paint.exe`); `node test/live/run.mjs` (it opens real Claude Code windows signed in as the user and spends tokens, so it's a reminder only); `gh workflow run` or anything that dispatches CI.

## Platform constraints

- `glance.mjs` runs as a separate Node process for every hook event, on the user's machine. Its edits take effect in every open Claude Code session at once on the maintainer's machine, so a syntax error stops tinting everywhere until fixed.
- The hooks module runs in the engine's own environment: no Node, no DOM, no `setTimeout`; timers go through `$.clock`. A function that receives `$` must be declared at the top level of the module, or the engine refuses to load it. Mod edits load only in new sessions.
- `$.process.run` calls into `glance.mjs` time out at 5 seconds; `UiIdle` and `GlanceCheck` sleep about 2.6 and 1.5 seconds inside that budget.
- Windows: hooks run with their own hidden console. Painting goes through `paint.exe`, which attaches to the `claude.exe` ancestor's console; writing `CONOUT$` from Node paints nothing or creates a stray file.
- macOS and Linux: painting writes OSC 11 and OSC 111 to `/dev/tty`, or to the nearest ancestor's terminal found with `ps`.

## Risk map

| Surface          | Paths                                                                                                                                                                                  | Extra lanes |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Trust boundary   | `glance.mjs` (parses hook JSON from stdin, builds file paths from `session_id`, spawns `paint.exe` and `ps`), `hooks/register.tsx` (`$.process.run`), `paint.cs` (attaches to another process's console) |             |
| Logic            | `glance.mjs`, `schedule.mjs`, `hooks/register.tsx`, `paint.cs`                                                                                                                          |             |
| Server           | None: no server, routes, or jobs.                                                                                                                                                       |             |
| Data             | None: no database. Per-session state files under `~/.claude/state/glance/` are Logic.                                                                                                   |             |
| UI               | None as files: the Claude Desktop band and the command output text live in `hooks/register.tsx` and are classified by hunk.                                                             |             |
| Tests            | `test/**`                                                                                                                                                                               |             |
| Config and infra | `.github/workflows/*.yml`, `.github/dependabot.yml`, `.claude-plugin/*.json`, `hooks/hooks.json`, `.github/scripts/release.mjs`, `tsconfig.json`, `.gitattributes`, `build.ps1`, `types/index.d.ts` |             |

## Repo lanes

None: the generic lanes cover this project. The reliability rules that matter most are in **Extra focus** for `quality-reviewer` and `test-coverage-reviewer`.

| Lane | Owns | Runs when | Standards |
| ---- | ---- | --------- | --------- |

## Ignore

Paths left out of the diff the reviewers read: `paint.exe` (a committed binary; CI checks it was built from `paint.cs`), `.claude-plugin/types/` (written by the engine, gitignored), `CHANGELOG.md` (written by Release Please; none yet).

## Architecture

- `glance.mjs` is the whole decision path: `decide(prev, input, now)` is pure (state in, state out, `now` passed in), and `main()` / `apply()` do the I/O: read stdin, take a per-session lock, read and write `~/.claude/state/glance/<session>.json`, paint, and append to `events.log`.
- `schedule.mjs` holds the cron and `/loop` wakeup math that `decide()` uses; it's pure too.
- `hooks/register.tsx` (the mod) only forwards events to `glance.mjs` through `$.process.run` and draws the Desktop band from the state line `glance.mjs` prints. It holds no rules of its own beyond what to forward and when (the `isWorking` settle wait, ignoring its own commands).
- Painting: `paint.exe` (from `paint.cs`) on Windows, the tty painter in `glance.mjs` on macOS and Linux. `paint.exe` is committed and rebuilt only with `build.ps1`.
- `test/live/` drives real interactive sessions on Windows and is never part of CI.
- Release flow: work lands on `dev`, `main` takes pull requests from `dev` only, CI's `version` job versions from conventional commits on the `dev` to `main` pull request, and the merge publishes the release. Commit subjects decide the version, so a mislabeled `feat:` or `fix:` is a real defect.

## Intentional non-issues

- `paint.exe` is a committed binary: it lets users install without a compiler, and CI's `build.ps1 -Check` proves it matches `paint.cs`.
- The mod's `classic.*` hooks await `glance()` before `next(e)`: events must reach `glance.mjs` in order, as a settings hook would. Each has `.catch(failOpen)`, so a failure never holds Claude up.
- `void glance(...)` in `turn.complete` and `void noteWorking(...)` in the render hook are unawaited on purpose: the turn's end and drawing must not wait on painting. Both log their own failures.
- One `on('classic.<Event>', ...)` line per event instead of a loop: a loop over names loses the hook's types (comment in `hooks/register.tsx`).
- `sleep()` in `glance.mjs` blocks with `Atomics.wait`: the hook process is short-lived and single-purpose, and the waits (lock retry, `UiIdle`, `GlanceCheck`) are bounded.
- The empty `catch` in `log()`: logging must never break the hook (comment in the code).
- The title watcher (`ensureWatcher`, `paint.exe --watch`) is kept but off (`CONFIG.titleWatcher: false`), for sessions that can't load the mod.

## Extra focus

### quality-reviewer, test-coverage-reviewer: reliability

- Blocker: a change that can leave a pane showing working while Claude waits on the user (a question, a permission prompt, an elicitation, or an idle prompt) with no event that would clear it. Uncertain cases must fall back to needs-you.
- Blocker: `decide()` doing I/O or reading the clock itself.
- Blocker: a mod hook that can hold up an event without `.catch(failOpen)` or an equivalent catch.
- Blocker: a function that receives `$` declared anywhere but the top level of `hooks/register.tsx`.
- Blocker: Node code that opens or writes `CONOUT$`.
- Warning: a rule change in `decide()` without a test in `test/glance.test.mjs`.
- Warning: bad input dropped with a silent `return` or an empty `catch` instead of a `log()` line.
- Warning: new work on every hook event (a spawn, a sync wait, a file scan) beyond today's budget of about 80 ms per event.

### security-reviewer: trust model

- Hook stdin comes from Claude Code on the same machine, as the same user, but its fields carry model- and user-controlled text (`prompt`, `tool_name`, `tool_input`, `session_id`).
- Blocker: a spawn with `shell: true`, or a command string built from event fields. Every spawn today passes an argv array.
- Blocker: a file path built from an event field without `safeId()`.
- Warning: anything written outside `~/.claude/state/glance/`, or painted anywhere but the session's own pane.
- `debug.jsonl` records prompt text, but only while the user has created the `debug` file; that opt-in is deliberate.

### comment-reviewer: README as the record

- Warning: a behavior change without the matching update to the README's event table, or a finding about Claude Code's behavior without a dated entry (with the Claude Code version) under "Things verified by experiment".
