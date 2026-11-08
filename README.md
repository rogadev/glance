# glance

glance tints your terminal pane while Claude Code is working and puts it back to normal the moment Claude needs you, so you can tell from across the room which sessions are waiting on you.

- **Working** (Claude, or background work it started, is busy: a subagent, a background shell such as a CI watch, or a `/loop` wakeup or cron job due within the hour): slate background `#1F2D3D`.
- **Needs you** (turn finished, permission prompt, question, error): your normal terminal background.

The rule is lopsided on purpose. A pane that looks busy when it's really waiting on you is the failure that matters, so every doubtful case falls back to "needs you".

## Requirements

- A terminal that honors the color codes `OSC 11` (set the background) and `OSC 111` (reset it), on Windows, macOS, or Linux, or the Claude desktop app. See [Where it works](#where-it-works), and run `/glance-check` to find out for yours.
- **Node.js 20 or later** on `PATH`. glance's hook script runs on Node.
- **Claude Code 2.1.319 or later.**

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install glance --marketplace rogadev/glance
```

Answer `y` to add the marketplace, then pick a scope (the user scope tints every session). From a shell instead:

```
claude plugin install glance --marketplace rogadev/glance
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `rogadev/glance`, then **Add plugin**. There, glance shows its band above the prompt while Claude works, and `/glance-fix` works the same way.

Sessions you start after the install are tinted.

## Stay up to date: `/glance-update`

Claude Code's docs say it updates plugins on its own only for marketplaces that have auto-update turned on, and that it's off by default for a third-party marketplace like glance's. To turn it on: run `/plugin`, open **Marketplaces**, select **glance**, then **Enable auto-update**. Per the same docs, Claude Code then updates glance shortly after the first message of a session and tells you to run `/reload-plugins`. glance hasn't tested this itself yet (see "Open questions").

Without auto-update, glance tells you itself. At the start of a session it checks whether a newer release is out, at most once a day across all your windows, and while yours is behind, each new session shows a notice naming both versions. Run `/glance-update` to update (it runs `claude plugin update` for you), then `/reload-plugins`.

The check reads one small file from GitHub and sends nothing about you. It stays off when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_AUTOUPDATER`, or `DISABLE_UPDATES` is set, the settings that turn off Claude Code's own update checks, and when glance runs from a folder of its own (`--plugin-dir`) instead of a marketplace install.

## Where it works

glance paints the terminal window Claude Code runs in, so what matters is the window (and anything in between, such as tmux), not your shell: PowerShell, cmd, Git Bash, zsh, and fish inside the same window all behave the same.

| Where | Status |
|---|---|
| Windows Terminal (Windows 10 and 11) | Confirmed |
| macOS and Linux: iTerm2, Ghostty, kitty, WezTerm, Alacritty, Konsole, GNOME Terminal and other VTE terminals | Expected: they document both color codes, and CI proves glance sends the codes to a real pseudo-terminal on macOS and Linux. Not yet confirmed on screen |
| VS Code's terminal | Expected (its terminal supports both codes); not yet confirmed |
| macOS Terminal | Unknown: it may not support the reset code, so the tint may not clear |
| tmux, GNU screen | Unknown: a multiplexer may keep the codes to itself rather than pass them to your window |
| Git Bash's own window (mintty), ConEmu, the legacy Windows console, JetBrains terminals | Unknown. On Windows, glance paints through the console Claude runs in; whether these windows show it is untested |
| Claude desktop app | Draws a slate "Claude is working" band above the prompt instead of a tint (no terminal to paint). Tested with the mod test kit, not yet confirmed in the app |
| WSL | Runs the macOS and Linux painter inside WSL, so it should behave like the window WSL runs in. Untested |

If yours is unknown or doesn't work, run `/glance-check` and open an issue with its report. See [Report an issue](#report-an-issue).

## Check it works: `/glance-check`

Type `/glance-check` in a session. glance shows the working color for 1.5 seconds, then puts the pane back, and prints a report: the terminal it detected and what's known about it, whether painting succeeded, the current state, and your glance, Node, and system versions. If the painting succeeded but you didn't see the color change, your terminal ignores the codes; the report is what an issue needs. It changes no state.

## Fix a stuck tint: `/glance-fix`

If a pane stays slate while Claude is plainly waiting on you, type `/glance-fix` in that session. It:

1. Asks Claude Code which subagents are still running, and keeps those.
2. Drops every tracked background shell and scheduled run. glance can't check whether those are still alive, and a stale one, such as a dev server left running, is what usually holds a tint.
3. Repaints the pane as "needs you" and prints what it dropped.
4. Says what it found before the reset, and whether that was a glance bug: background work glance never heard finish (designed: a shell holds the tint for up to an hour), subagents still running (the tint was right), subagents Claude Code no longer lists, a working pane with nothing running (glance missed the end of a turn), or a pane glance already had as needs you (the color didn't reach the terminal). It saves this, with the session's recent log lines, to `~/.claude/state/glance/fix-<session id>.json`. When it looks like a bug, it suggests `/glance-report`.

It runs even while a turn is in progress, and it changes nothing in your conversation.

## Report an issue

Right after `/glance-fix`, type `/glance-report`: it asks Claude to report what `/glance-fix` found, starting from its saved snapshot. Otherwise, run `/glance:report-issue` with a few words on what went wrong. Claude gathers glance's versions and log lines, checks the docs and existing issues, reads glance's code to explain what likely happened, and drafts the issue. It shows you the draft and files only when you say so. To file by hand, or to see what a good report includes, read [How to report a glance issue](.github/CONTRIBUTING.md#reporting-an-issue).

## How it works

The glance mod (`hooks/register.tsx`) hands each event glance decides on to `glance.mjs`:

- The settings-hook events, through the mod's `classic.*` hooks, so an install needs no `settings.json` edits.
- Each tool call, as `PreToolUse`.
- Esc, which fires no settings hook. The engine's `turn.complete` with `reason: 'aborted'` becomes a `TurnAborted` event.
- `/glance-fix`, as `GlanceReset`.

Each run of `glance.mjs`:

1. Reads the event JSON from stdin.
2. Under a per-session lock, loads `~/.claude/state/glance/<session_id>.json`, runs the pure `decide()` function, and saves the result.
3. Runs `paint.exe`, which writes `OSC 11;<color>` (working) or `OSC 111` (reset to the profile background, needs you) to the pane.
4. Appends one line to `~/.claude/state/glance/events.log` (rotates at 512 KB). A line ending `ok` means `paint.exe` exited 0; otherwise it ends `paint-failed:<reason>` or `paint-skipped:<reason>`.

Claude Code starts hooks with their own hidden console, so writing to it reaches nothing. `paint.exe` (built from `paint.cs` by `build.ps1`) walks up to the nearest `claude.exe` ancestor, attaches to that process's console (the visible pane), and writes there. A run takes about 80 ms: about 40 for Node and about 40 for `paint.exe`.

There's also a long-lived **title watcher** (`paint.exe --watch`), **off** by default (`CONFIG.titleWatcher: false`) since the mod catches Esc without polling. When it's on, it polls the pane title (a spinner while Claude works, `✳` when idle) every 750 ms, and reports `TitleIdle` to `glance.mjs` after 2.5 idle seconds while the state still says working. It logs to `~/.claude/state/glance/watch.log`.

## Event table

| Event | Result |
|---|---|
| `SessionStart` | Needs you; forgets subagents (kept on `compact`, which also ends a manual `/compact` like `PostCompact`) |
| `PreCompact` (main thread) | Working (`compact-manual` for `/compact`, `compact` for an automatic one) |
| `PostCompact` | After `/compact`: needs you (`compact-done`), unless background work is still live. After an automatic compact: nothing, since the turn goes on and ends with its own `Stop` |
| `UserPromptSubmit` | Working; clears background work named in any `<task-notification>` in the prompt; a prompt that matches a scheduled run's prompt means it fired (a recurring cron moves to its next run, anything else ends) |
| `PreToolUse` (main thread) | Working, except `AskUserQuestion` and `ExitPlanMode`, which mean needs you |
| `PostToolUse`, `PostToolUseFailure`, `ElicitationResult` | Working (main thread, or a subagent clearing its own permission prompt); a `tool_response.backgroundTaskId` adds a background shell; `ScheduleWakeup` and `CronCreate` add a scheduled run, and `ScheduleWakeup` with `stop` or `CronDelete` removes it |
| `PermissionRequest`, `Elicitation` | Needs you |
| `Notification` | Needs you for `permission_prompt`, `idle_prompt`, `elicitation_*dialog`, `agent_needs_input`; `idle_prompt` with live background work stays working |
| `SubagentStart` / `SubagentStop` | Add / remove the agent; no color change |
| `Stop` (main thread) | Needs you, unless background work is still live (`background-running`) |
| `UiWorking` (from the mod) | The engine's `isWorking` turned true and stayed true for 1.5 s. Working (`ui-working`), but only when the pane is on needs-you because something finished (a stop, an Esc, a session start); never over a question, a permission prompt, or a dialog. This is what tints bash mode (`! command`), which sends no hook |
| `UiIdle` (from the mod) | The engine's `isWorking` turned false. After 2.5 s with no hook since: needs you (`ui-idle`) if working and no background work runs; otherwise nothing. This catches a `/compact` cancelled with Esc, which sends no `PostCompact` |
| `TitleIdle` (from the watcher) | Needs you (`title-idle`) if working, no background work, and the title has been idle 2.5 s since the last hook; otherwise nothing. It never turns a pane to working. |
| `StopFailure` | Needs you |
| `TurnAborted` (from the mod) | Needs you (`aborted`), unless background work is still live |
| `GlanceCheck` (from `/glance-check`) | Shows the working color for 1.5 s, then repaints the current state and reports; changes no state |
| `GlanceReset` (from `/glance-fix`) | Needs you (`reset`); keeps only agents the engine still lists as running, drops every shell and scheduled run; saves a diagnosis to `fix-<session id>.json` |
| `SessionEnd` | Reset to the profile background; delete the state file |

Events from inside a subagent never cover up a question the main thread is waiting on.

## Safety nets

- Every mod hook fails open: if `glance.mjs` errors, hangs, or Node is missing, Claude carries on as if glance weren't installed. A missing Node shows one notice per session; everything else, including a run that takes over 5 seconds on a busy machine, goes to the debug log only (`claude --debug`), and the next event repaints.
- Background work with no end signal expires: agents after 4 hours (`CONFIG.agentTtlMs`), shells after 1 hour (`CONFIG.shellTtlMs`), so a dev server left running can't hold the tint for long. `/glance-fix` clears it at once.
- Scheduled runs count only when due within an hour (`SCHEDULE_HORIZON_MS` in `schedule.mjs`), so a job set for tomorrow morning doesn't keep the pane tinted overnight. A run that's later than its allowance (2 minutes, or up to half the period plus 2 minutes for a recurring cron) counts as missed: a recurring cron moves on, anything else ends.
- (With `CONFIG.titleWatcher` on.) The title watcher clears a working pane that is really idle (Esc, or any other missed end of turn) within about 3 seconds.
- `idle_prompt` (Claude waiting 60+ seconds) forces needs-you when no subagents are live.
- A lock left behind by a dead hook is broken after 3 seconds; after 2 seconds of waiting the hook paints anyway rather than drop the event.
- State files untouched for 7 days are pruned on the next `SessionStart`.

## Things verified by experiment (2026-11-07, Claude Code 2.1.319)

- Windows Terminal applies `OSC 11` and `OSC 111` written by the program that owns the pane (tested with `[Console]::Out.Write` in a fresh window).
- Hooks run with their **own hidden console**, not the pane's. Writing to `CONOUT$` from a hook appears to succeed, but it paints an invisible window. What works is `FreeConsole`, then `AttachConsole(<claude.exe pid>)`, then `CreateFile("CONOUT$", GENERIC_READ | GENERIC_WRITE, ...)`, confirmed by screenshot. The process chain is `claude.exe`, then `cmd.exe`, then the hook.
- Node can't open the console device itself: `\\.\CONOUT$` fails with `EPERM` (write-only) or `ENOENT` (read-write). A bare `CONOUT$` creates an ordinary file in the working directory. The first version did that and left stray files in several repos (since removed).
- A background agent killed with `TaskStop` gets **no** `SubagentStop`. Its end arrives only as a `UserPromptSubmit` whose prompt holds `<task-notification>` with `<task-id>` (the same value as the hook's `agent_id`) and `<status>killed</status>`. glance clears agents from that.
- Two hooks for one session can fire in the same millisecond (`SubagentStart` and the Agent tool's `PostToolUse`), hence the lock. A 20-way concurrent test kept all 20 agents.
- Hook config changes apply to running sessions without a restart.
- **Esc fires no hook.** Not `Stop`, not anything. An Esc after the reply starts writes a transcript line with `interruptedMessageId`; an Esc before any reply pulls the prompt back into the input box and writes nothing. The pane title flips to `✳` in both cases, hence the title watcher, and later the mod's `TurnAborted`.
- A background shell's `PostToolUse` has `tool_response.backgroundTaskId` (for example `b37q4qei1`); its end arrives as a `<task-notification>` prompt with the same id and `<status>completed</status>`.
- `ScheduleWakeup`'s `PostToolUse` has `tool_response.scheduledFor` (epoch ms); `CronCreate`'s has `tool_response.id`, `nextFireAt` (epoch ms, including the scheduler's shift), `recurring`, and `humanSchedule`.
- Live `/loop` test (18:27 to 18:33Z): the pane stayed working through an untracked cron fire, a tracked wakeup fire, and the wait for a tracked one-shot cron. `idle_prompt` does fire while scheduled work is pending; glance keeps the tint, as designed. The count went 2, then 1, then 0 as each tracked run fired.
- Node misreads some Windows time zones: on the test machine it reported GMT-8 for a GMT-7 clock. Claude Code and .NET read it correctly. Cron math therefore uses the offset from `paint.exe --utc-offset`, stored on each cron entry as `offsetMin`.
- `AttachConsole` plus `GetConsoleTitleW` reads another Claude pane's title (idle `✳ Auditfix ...`, working `◑ Next 10 GitHub issues`).
- A detached process started by a hook survives the hook's exit (the watchers keep running).
- The watcher's reports reached `glance.mjs` but were dropped: .NET's `Process.StandardInput` prefixes a UTF-8 byte-order mark, `JSON.parse` rejected it, and the hook returned silently. That made Esc look unfixed in the first real test (18:46Z). `glance.mjs` now strips the mark, and it logs `input-unreadable` or `input-unparsable` instead of exiting silently.
- Titles track state: sampled side by side, a working session showed `◑`/`◐`, and finished or background-waiting sessions showed `✳`. Reading your own pane's title from inside a tool call returns an empty string, which the watcher treats as not idle (safe).
- A mod loaded through `CLAUDE_CODE_PLUGIN_DIRS` doesn't hot-reload into sessions that are already open: `/glance-fix` was "Unknown command" in one, even after `/reload-skills`, and worked in a fresh `claude -p "/glance-fix"` (`GlanceReset -> attention [reset] ... ok`). Start slash commands from PowerShell when testing with `claude -p`: Git Bash rewrites a leading `/` into a path.
- The mod's `classic.*` hooks receive the same events as settings hooks, in the same order and about 200 ms earlier. Two `claude -p` runs with both in place logged every event twice (once marked `via:mod`) with the same result, for a main-thread turn (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) and for a subagent (SubagentStart, its own PreToolUse and PostToolUse with its `agent_id`, SubagentStop). `tool.call` carries no `agent_type`, so the mod's PreToolUse lines omit it; `decide()` doesn't use it. Children of `$.process.run` have `claude.exe` as an ancestor, so `paint.exe` paints from the mod too.
- Two plugins with the same name don't both load: the second reports "another plugin of that name loads first".
- The mod catches `AskUserQuestion`, confirmed live by the user (19:30Z): `tool.call` sent it as `PreToolUse` (`attention [asking]`), then `classic.PermissionRequest` and a `permission_prompt` notification kept the pane on needs-you until the answer's `PostToolUse` switched it back to working.
- Removing the settings hooks cuts glance off from sessions that are already open, and the mod doesn't load into them (see above). Each such pane froze on whatever it showed last: one stayed working while it asked a question. Restart open sessions after switching from settings hooks to the mod.
- `/compact` runs no turn: it sends no `UserPromptSubmit` and no tool events, so before glance handled `PreCompact` the pane showed needs-you for the whole compaction (19:37 to 19:39Z, user's screenshot). The log showed `SessionStart` with `source: compact` and a `SubagentStop` for the summarizer at the end.
- The first release run (2026-11-07, release-please-action 5.0.0): GitHub held the release pull request's `pull_request` CI run as `action_required`, because the built-in token opened the pull request. A `workflow_dispatch` CI run on the same commit passed, but the pull request listed only the newest run (the held one), so `main`'s required `ci ok` check stayed missing and the pull request stayed blocked. Approving the held run (`POST /actions/runs/<id>/approve`) ran CI and unblocked it.
- `/glance-check` keeps the engine busy (`isWorking`) for about 1.6 s, which alone tripped `UiWorking` and turned the pane working (live harness, 20:15Z). The mod now ignores `isWorking` while its own commands run.
- Live harness (`test/live/run.mjs`, 19:56 to 20:11Z): the mod receives `classic.PreCompact`. Esc during a `/compact` sends nothing at all: no `PostCompact`, no `TurnAborted`, and no `idle_prompt` within two minutes, so the pane stayed working while the window sat idle. In one run a `PostCompact` came 2.5 minutes after the Esc. The engine's `isWorking` (on the `AbovePrompt` band's props) does go false at the Esc, hence `UiIdle`. Bash mode (`! sleep 20`) sends no `UserPromptSubmit` or tool event either, only a `Stop` when the command ends, but `isWorking` is true while it runs, hence `UiWorking`. Esc during a normal turn sends `TurnAborted`, as before. `/exit` also sets `isWorking` for a moment, hence the 1.5 s wait before `UiWorking` counts.
- (2026-11-08, 2.1.319) `$.process.run` rejects with a `HooksError` that has no `code`, only a message. A command that isn't found: `$.process.run(<cmd>) failed to start: ENOENT: Command '<cmd>' not found or is in an unsafe location (current directory)`. A run past `timeoutMs`: `$.process.run(<cmd>) aborted: still running after <n>ms`. The mod tells a missing Node from a slow run by that message (a probe mod run with `claude -p --plugin-dir`). In `claude plugin test`, a `process.run` hook that throws is skipped and the call rejects with `no implementation for process.run`; return `{ deny: <message> }` to make it reject with a given message.
- (2026-11-08, 2.1.319) A mod can't submit a prompt from its own `command.run` hook: `$.prompt.submit` rejects with "called from a command.run hook, it would wait on the turn this hook is holding". A mod command's turn sends no `turn.complete` either, though that error suggests it. `/glance-report` queues its prompt and submits it at the next draw of the prompt area (`ui.render` of `AbovePrompt`) with `isWorking` false, about a second after the command (live harness, `report` scenario).
- (2026-11-08, 2.1.319) From a mod in a running session (a probe mod run with `claude -p --plugin-dir`): `$.http.fetch` of `https://raw.githubusercontent.com/rogadev/glance/main/.claude-plugin/plugin.json` returns 200 with the file, `$.process.run(['claude', 'plugin', 'list', '--json'])` exits 0, and `$.fs.read` reads the plugin's own `plugin.json`. `$.plugin.root` is the plugin's folder in the platform's own form (backslashes on Windows); a marketplace install lives under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>`. `claude plugin update <plugin>@<marketplace> --json` that fails prints one line, `{"command":"update","outcome":"failed",...,"message":"...","failureCode":"..."}`, and exits 1.

## Open questions

- The update notice is a toast raised about three seconds after a session starts. No one has seen it on screen yet in a marketplace install, in the terminal or the desktop app.
- Marketplace auto-update is described above from Claude Code's docs, not by experiment: whether it's off by default for glance's marketplace, and when an update lands once it's on.
- A schedule due more than an hour out shows needs-you until something else fires a hook (there's no timer to re-tint the pane as the run approaches).
- The cron offset is taken once, when the job is created, so a recurring cron that crosses a daylight-saving change is off by an hour until it's recreated (jobs expire after 7 days anyway).
- A background dev server left running holds the tint for up to an hour after the turn ends (the shell TTL), unless you run `/glance-fix`.
- After you approve a permission prompt, the pane stays on needs-you until that tool finishes, so a long approved command looks idle. No event marks the approval: `tool.check` runs before the prompt, and `ui.press` and `ui.select` only cover components a plugin draws.
- Agent teams are untested: whether teammates send `SubagentStart`, and what `TeammateIdle` should mean for the lead's pane. `TaskCreated` and `TaskCompleted` are task-list events, not busy signals, so glance ignores them. `PermissionDenied` (a rule or auto mode refusing a tool) needs nothing: Claude keeps working.
- The title watcher depends on Claude Code's title glyphs. If a release changes them, `TitleIdle` stops firing. The log shows whether `TitleIdle` lines still appear.

## Contributing

Work happens on `dev`. `main` only takes pull requests from `dev` (a CI check enforces it), and every change that reaches `main` goes through Release Please, which turns conventional commit messages into the next version, `CHANGELOG.md`, and a GitHub release.

1. Commit to `dev`, or branch from it. Write commit messages as conventional commits: `feat:` for new behavior (minor version), `fix:` for a bug fix (patch), and `docs:`, `test:`, `ci:`, or `chore:` for the rest (no release on their own). Mark a breaking change with `!`, for example `feat!:`.
2. Before you push, run what CI runs:
   - `node --test test/glance.test.mjs test/schedule.test.mjs test/smoke.test.mjs test/terminal.test.mjs`
   - `claude plugin validate .` and `claude plugin test .`
   - On Windows, `pwsh -File build.ps1 -Check`. After editing `paint.cs`, run `pwsh -File build.ps1` and commit the new `paint.exe`.
   - The mod's type-check, `npx -p typescript tsc -p .`, needs the types the engine writes to `.claude-plugin/types/` when it loads the mod, so it runs locally, not in CI.
3. Open a pull request from `dev` to `main` and merge it with a merge commit. Squashing would make `dev` and `main` drift apart.
4. Release Please opens or updates a release pull request on `main`, and CI runs on it. Wait for `ci ok`, then merge it when you want to ship: that tags `vX.Y.Z`, publishes the GitHub release, and merges the release commit back into `dev`.

Release Please acts as a GitHub App, so CI runs on its pull request without approval. GitHub holds CI on a pull request the workflow's built-in token opens until a maintainer approves it. To set the app up (once, in a fork or a new copy of the repo):

1. Create a GitHub App (**Settings**, **Developer settings**, **GitHub Apps**, **New GitHub App**) with no webhook, and the repository permissions **Contents: Read and write** and **Pull requests: Read and write**. Install it on the repository.
2. In the repository's **Settings**, **Secrets and variables**, **Actions**: add the app's client ID as the variable `RELEASE_APP_CLIENT_ID`, and a private key you generate for it as the secret `RELEASE_APP_PRIVATE_KEY`.

Without the variable, the release workflow falls back to the built-in token. CI on the release pull request then waits for approval: click **Approve and run** on the pull request (or `gh api -X POST repos/rogadev/glance/actions/runs/<run id>/approve`).

CI (`.github/workflows/ci.yml`) runs the Node tests on Windows, macOS, and Linux with Node 20 and 22, including `test/terminal.test.mjs`, which paints for real: into a pseudo-terminal on macOS and Linux (checking the exact bytes the terminal receives, through both `/dev/tty` and the ancestor fallback) and into a hidden console of its own on Windows; validates and tests the plugin; rebuilds `paint.exe` from `paint.cs` and checks that the committed `paint.exe` was built from that source (`paint.exe --source-hash`); checks `paint.exe`'s exit codes; and reports one `ci ok` check, which the branch rules require.

### Testing

Each layer has its own test, from the rules out to the screen:

| Layer | What it catches | Where | Runs in |
|---|---|---|---|
| Rules | The wrong state for a sequence of events | `test/glance.test.mjs`, `test/schedule.test.mjs` | CI, every system |
| Script end to end | State file, log, and `/glance-fix` output | `test/smoke.test.mjs` | CI, every system |
| Painters | The color code not reaching a terminal | `test/terminal.test.mjs` | CI, every system |
| Mod | An event not forwarded, the Desktop band, `isWorking` reporting | `test/register.test.tsx` (`claude plugin test .`) | CI |
| What Claude Code sends | Keys and commands whose events nobody knows yet | `test/live/run.mjs` | Locally, on Windows |
| What a terminal shows | A terminal that ignores the color code | You, looking at the pane | By hand |

`node test/live/run.mjs` runs a real, interactive Claude Code session for each scenario in a minimized window, types into it without taking focus (`test/live/console.cs`, built on the fly with the `csc.exe` that ships with Windows), and checks the lines glance logged for that session. It signs in as you and spends a few cents of tokens per scenario, so CI doesn't run it. Add a scenario when you want to know what Claude Code does for some key or command, and record what you learn under "Things verified by experiment". Now and then a harness session ends on its own a second or two after its first prompt (twice in about fifteen runs, cause unknown); the scenario then fails with `SessionEnd` in its lines and prints the window's last screen, and a rerun passes. Each run removes its scratch folder and the transcript Claude Code saved for it.

### Developing locally

- Load your working copy instead of the installed plugin: point `CLAUDE_CODE_PLUGIN_DIRS` at this folder (in the `env` block of `~/.claude/settings.json`), or use `claude --plugin-dir .` for one session. Disable an installed `glance` first, since two plugins named `glance` don't load together. New sessions pick up mod edits; `glance.mjs` edits apply on the next event in every session.
- `decide()` is pure, and every rule has a test in `test/glance.test.mjs`. The cron math in `schedule.mjs` is covered by `test/schedule.test.mjs`. `test/smoke.test.mjs` runs `glance.mjs` end to end against a throwaway home folder with painting off (`GLANCE_NO_PAINT`).
- Debug: create an empty file `~/.claude/state/glance/debug` to capture raw hook inputs to `debug.jsonl` beside it. It records prompt text, so delete both when you're done.
- Change colors in `CONFIG` at the top of `glance.mjs`.
- Read a pane's title: `paint.exe --title <claude.exe pid>`. Stop running watchers: `Get-Process paint | Stop-Process`.

## Uninstall

Run `/plugin uninstall glance`. A pane that's tinted at that moment keeps its tint until you close it. To reset it right away, run ``[Console]::Out.Write("`e]111`a")`` in that pane.

## License

MIT. See [LICENSE](LICENSE).
