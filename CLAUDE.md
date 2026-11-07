# glance

A Claude Code mod that tints a Windows Terminal pane while Claude works, so the user can tell from across the room which sessions need them. Read `README.md` first: it has the event table, what has been verified by experiment, the open questions, and the release workflow.

Repo: `rogadev/glance` (public). Work on `dev`; `main` takes pull requests from `dev` only, merged with a merge commit, and Release Please cuts releases from `main`. Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`): they decide the next version.

On the maintainer's machine this folder is also the live install: `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` loads it, so **every `glance.mjs` edit takes effect in every open Claude session right away**, and mod edits (`hooks/register.tsx`) load in new sessions. A syntax error stops tinting everywhere (the mod's hooks fail open, so Claude itself keeps working).

## Rules

- The top requirement is reliability: a pane must never show "working" while it's waiting on the user. When a case is uncertain, fall back to the needs-you state.
- Keep `decide()` pure and add a test in `test/glance.test.mjs` for every rule change. Before you finish, run `node --test test/glance.test.mjs test/schedule.test.mjs test/smoke.test.mjs test/terminal.test.mjs`, `claude plugin validate .`, `claude plugin test .`, and `npx -p typescript tsc -p .` (the last needs `.claude-plugin/types/`, which the engine writes when it loads the mod).
- Prove hook behavior by experiment (the event log, or debug capture), not from the docs alone. Record each finding under "Things verified by experiment" in `README.md` with the date and Claude Code version. `claude -p --plugin-dir <copy>` from PowerShell runs a session against a scratch copy; every line the mod sends is marked `via:mod` in the log. For keys and commands (Esc, `/compact`, `! command`), add a scenario to `test/live/run.mjs` and run it: it drives a real interactive session on Windows without taking focus.
- Never fail silently: log it. A silent `return` on bad input hid a broken watcher for the whole first Esc test.
- Hooks must stay fast (about 80 ms per run today: 40 for Node, 40 for `paint.exe`) and must never throw where it could matter: catch and log instead. Every mod hook that can hold up an event has `.catch(failOpen)`.
- A function in `hooks/register.tsx` that receives `$` must be declared at the top level of the file, or the engine refuses to load the module.
- Painting goes through `paint.exe` (source `paint.cs`, rebuild with `build.ps1`, then commit `paint.exe`; CI's `build.ps1 -Check` fails if the committed binary wasn't built from the committed source). Hooks have their own hidden console, so never write to `CONOUT$` from Node: it either fails or paints nothing, and a bare `CONOUT$` creates a stray file in the session's working directory.
- A log line ending `ok` means `paint.exe` exited 0. Anything else is `paint-failed:<reason>`, with the exit codes listed in `paint.cs`, or `paint-skipped:<reason>` (not Windows, or `GLANCE_NO_PAINT` set by the tests). Hooks can't see the screen, so confirm visual changes with a screenshot or by asking the user.

## Where things are

- `glance.mjs`: the hook script (pure `decide()` plus I/O). `schedule.mjs`: cron parsing and the rules for `/loop` wakeups and cron jobs.
- `hooks/register.tsx`: the mod. Forwards the settings-hook events (`classic.*`), tool calls (as `PreToolUse`), Esc (`TurnAborted`), and `/glance-fix` (`GlanceReset`) to `glance.mjs`.
- `test/`: `glance.test.mjs` and `schedule.test.mjs` (unit), `smoke.test.mjs` (runs `glance.mjs` end to end in a throwaway home), `register.test.tsx` (the mod, run by `claude plugin test .` only).
- `paint.cs`: source of `paint.exe`, the console painter and the per-session title watcher (`--watch`). `build.ps1`: rebuilds it with the `csc.exe` that ships with Windows.
- `.claude-plugin/`: `plugin.json` (Release Please bumps its version) and `marketplace.json` (what `/plugin install glance --marketplace rogadev/glance` reads).
- `.github/workflows/`: `ci.yml` (tests on three systems, plugin checks, `paint.exe` check, the dev-only-into-main guard, and the `ci ok` check the branch rules require) and `release.yml` (Release Please, then syncing `main` back into `dev`).
- State and log: `~/.claude/state/glance/` (`<session_id>.json`, `<session_id>.watch` with the watcher pid, `events.log`).

## History

- 2026-11-07: built. The first version wrote to a bare `CONOUT$` (stray files in several repos, since removed). The fix also added the lock and task-notification agent tracking. Nothing painted yet, though: hooks have their own hidden console. `paint.exe`, which attaches to the `claude.exe` console, fixed that, confirmed by screenshot and by the user. Later the same day: Esc turned out to fire no hook, so the title watcher was added; background shells (for example `/land` watching CI) were added to the tracked background work. The mod (`TurnAborted`) replaced it for Esc, confirmed live by the user; the watcher is kept but off (`CONFIG.titleWatcher`). Then `/loop` wakeups and `CronCreate` jobs were added as scheduled background work, which turned up Node's wrong time zone (hence `paint.exe --utc-offset`). After rebuilding `paint.exe`, stop the running watchers (`Get-Process paint | Stop-Process`) so new ones use the new build.
- 2026-11-07, later: `/glance-fix` added after a pane stayed working for 12 minutes on two stale background shells. Then glance became a public plugin: the mod took over the 14 settings-hook registrations (verified by experiment to see the same events), the folder became the `rogadev/glance` repo, and CI plus Release Please were added.
