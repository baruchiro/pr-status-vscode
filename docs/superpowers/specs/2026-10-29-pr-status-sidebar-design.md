# PR Status sidebar — VS Code extension design

Date: 2026-10-29
Repos: `baruchiro/pr-status-vscode` (new, public) and `baruchiro/skills` (skill side changes)
Mockup: https://claude.ai/artifact/BE7Tt6FspucAA2npR7wd8B (option **B · Webview cards** chosen)

## Intent

The `resolving-pr-review-comments` skill writes `pr-status.md`, a table of the user's PRs in review order with whose turn each one is. The user keeps it open all day to answer one question: **what is my next action?** The answer is the first PR, in review order, that needs them.

The Markdown table goes stale between agent passes and looks foreign in the editor. The extension shows the same data natively in a VS Code sidebar, refreshes on its own, and adds one new signal: a PR that has local changes on the way, so the user can skip reviewing it for now.

## Goals

- A sidebar panel that appears only when a `pr-status.json` exists in the workspace.
- At a glance: the "Next for you" PR, and every PR in review order with a status pill.
- Auto refresh: on file change, and on a timer that re-queries GitHub between agent passes.
- Look like VS Code (theme colors, codicons, native fonts) in every theme, light/dark/high contrast.
- Published to the VS Code Marketplace.

## Non-goals (v1)

- Editing the PR list (adding, removing, reordering PRs). The agent owns the list.
- Notifications or sounds when a PR changes state.
- Replying to or resolving review threads from the panel.
- Its own GitHub classification logic. The skill's `classify-pr-status.jq` stays the only place that decides a status.

## Anti-goals

- A panel that disagrees with `pr-status.md` / the skill's table for the same data.
- A panel that looks like a web page dropped into VS Code (custom fonts, brand colors, heavy cards).
- Silent staleness: if refresh fails, the panel must say so and show when the data is from.

## Data contract: `pr-status.json`

Written by the skill's `pr-status.sh` (already shipped, uncommitted) in the project folder chosen by `project-dir.sh` (the nearest folder with a `*.code-workspace`, else the git root, else cwd). Written via temp file + rename.

```json
{
  "version": 1,
  "generatedAt": "2026-10-29T09:10:04Z",
  "prs": [
    {
      "repo": "owner/name", "number": 3114, "title": "…", "url": "https://github.com/…",
      "base": "develop", "phase": "draft|ready", "status": "draft:needs-you", "next": "you|claude|wait|merge",
      "hint": "…", "reviewOrder": "https://…" | "stale" | null
    }
  ]
}
```

Order of `prs` is the review order and must be kept.

**Skill-side additions (part of this project, in `baruchiro/skills`):**

- `state` (`OPEN` | `MERGED` | `CLOSED`), `headRefName`, `headRefOid` added to each PR. Today a merged PR still reads `ready:ready`.
- `classifyPr` returns status `merged` / `closed` with `next: "none"` for non-open PRs, first match. This changes the skill's Markdown table too (intended). Add fixtures to the existing `test-classify-pr-status.sh`.
- `threads` (number of open threads for whoever's turn it is), for the "Needs you · N" pill.
- `version` stays `1` (fields are only added).
- The extension needs a plugin version that writes `pr-status.json`, so the skill changes ship first.
- Reference the extension in the repo `README.md` and in `SKILL.md` (Status report section: "the PR Status VS Code extension shows `pr-status.json` live").

## Skill packaging: its own plugin

`resolving-pr-review-comments` moves out of the `baruchiro` plugin into a new plugin **`pr-review-loop`** in the same `baruchiro/skills` marketplace (`pr-review-loop@skills`), so the extension can install just this skill.

- New folder `pr-review-loop/` with `.claude-plugin/plugin.json` (version `0.1.0`), `skills/resolving-pr-review-comments/` (moved with `git mv`, history kept) and `shared/agent-reply-marker.txt`.
- The `code-review-publish` agent stays in `baruchiro`: `pr-walkthrough` dispatches it. So the marker exists in both plugins (each plugin is installed as its own copy, a cross-plugin path can't work). The existing `baruchiro/shared/test-agent-reply-marker.sh` is extended to fail when the two marker files differ, and its skill-path checks point at the new location. `shared/README.md` and the SKILL.md/agent text that says "in this plugin" are updated to say where each copy lives.
- `marketplace.json` gains the `pr-review-loop` entry; `baruchiro` gets a minor version bump (a skill was removed). Root `README.md` gets a row and an install line for `pr-review-loop`, plus the extension link.
- Anyone on `baruchiro@skills` loses the skill on update until they also install `pr-review-loop@skills`. Accepted: the user is the main consumer; the README says so.

## "Install skill" button

The extension offers to install the plugin; it never installs silently.

- Shown in the panel's empty/"script not found" states and as a command, "PR Status: Install Claude Code skill".
- Clicking opens a VS Code terminal named "PR Status" and runs, visibly:
  `claude plugin marketplace add baruchiro/skills && claude plugin install pr-review-loop@skills`
- `claude` not on `PATH` → instead show the two commands with a Copy button and a link to Claude Code's install docs.
- Script discovery then looks for the `pr-review-loop@` entry in `installed_plugins.json` (falling back to `baruchiro@` for older installs).
- Panel visibility is unchanged: without a `pr-status.json` the view stays hidden, so the button is reachable from the command palette and from the "script not found" footer. (The empty state only appears when a file exists but has no PRs.)

## Where the file is found

Candidate folders: every workspace folder, plus the folder of `vscode.workspace.workspaceFile` when the workspace is a saved `.code-workspace` (that folder is often not itself a workspace folder, and it is where `project-dir.sh` writes in multi-repo workspaces).

- A `FileSystemWatcher` on `pr-status.json` in each candidate folder (create/change/delete).
- Context key `prStatus.hasFile` drives the view's `when` clause. No file anywhere → the view and its activity-bar container are hidden.
- More than one file found → one section per file, headed by its folder name. One file → no heading.
- Across files there is **one** "Next for you" card for the window: the first PR needing the user, walking the files in order (the workspace-file folder first, then workspace folders in their order) and each file's PRs in file order. Badges count each PR (`repo#number`) once across all files.
- Activation: `workspaceContains:**/pr-status.json` is not enough (misses the workspace-file folder), so activate `onStartupFinished` and set the context key.

## Refresh

1. **File watcher**: re-render immediately when the JSON changes.
2. **Timer**: every `prStatus.refreshIntervalSeconds` (default 300, `0` disables), run the skill's `pr-status.sh` with the PRs already in the file (`OWNER/REPO#N` in file order). The script itself rewrites the JSON; the watcher then re-renders.
   - Run it with `PR_STATUS_FILE`, `PR_STATUS_JSON_FILE`, `PR_REVIEW_LINKS_FILE` set to that file's folder, so output always lands next to the file it was read from, whatever `project-dir.sh` would pick.
   - Pass every PR in the file, merged/closed too, so the file stays complete.
   - The agent may rewrite the file while a timer run is in flight. The timer run writes to temp paths (`PR_STATUS_FILE`/`PR_STATUS_JSON_FILE`) and swaps them in only if the JSON's `generatedAt` is unchanged since it was read; otherwise it discards its result.
   - Pause while the VS Code window is not focused; on focus, refresh at once if the last check is older than the interval.
3. **Manual**: refresh button in the view title.

**Finding the script**: `prStatus.scriptPath` setting if set; else read `~/.claude/plugins/installed_plugins.json` (`.plugins["<name>@<marketplace>"]` is an array; use its first entry's `installPath`), take the `pr-review-loop@` entry (else `baruchiro@`), and use `<installPath>/skills/resolving-pr-review-comments/pr-status.sh`. Not found → no timer refresh; the panel footer says so with a link to the setting. File-watcher rendering still works.

**Environment**: the script needs `gh` and `jq`. VS Code launched from the Dock may not have Homebrew on `PATH`; run the script through the user's login shell (`$SHELL -lc`) so `PATH` matches the terminal.

**Failure**: a non-zero exit keeps the last good data on screen and shows the error's first stderr line in the footer, with the data's age.

## Local changes signal

Uses the built-in Git extension API (`vscode.git`, `getAPI(1)`). For each PR, find an open repository whose remote matches `repo` (owner/name, SSH or HTTPS) and has a local branch named `headRefName`:

- **Local changes** when that branch is checked out and has uncommitted changes, or the local branch has commits not in `headRefOid` (ahead > 0). A branch that is only behind (someone pushed from elsewhere) is **not** local changes: nothing is on the way.
- Shown as a purple "Local changes" pill with a sync codicon; tooltip says what was found (e.g. "3 uncommitted files on feat/hub-filter").
- Re-evaluated on Git API repository state change events, not on the timer.
- Known limits (accepted): cannot tell the user's edits from Claude's; worktrees or repos not open in the window are invisible.

## UI (option B)

A `WebviewView` in its own activity-bar container ("PR Status", codicon `git-pull-request`).

- **Styling**: only VS Code CSS variables (`--vscode-*`) and `@vscode/codicons` (bundled, no CDN). Font, sizes and focus rings from the theme. Works in light, dark and high-contrast themes.
- **"Next for you" card** at top: the first PR in order with `next == "you"` and no local changes. Shows `#N title`, pills (status, Draft, `repo → base`), the hint, and two buttons: **Open PR** (primary) and **Review order** (secondary; hidden when null, shown as "Review order (stale)" disabled-looking link when `stale`). No such PR → the card says "Nothing needs you" plus who is up next.
- **Review order list**: one compact row per PR: position number, `#N title` (ellipsis), one status pill. The Next PR row is highlighted. Click a row → expands inline to show hint, repo → base, and the same actions. Merged/closed PRs render dimmed with a "Merged"/"Closed" pill, keeping their position.
- **Pills** (status → label → theme color):
  - `*:needs-you` → "Needs you · N" → `charts.orange`
  - `*:needs-agent` → "Claude's turn" → `charts.purple`
  - `ready:ci-failing` → "CI failing" → `charts.red`
  - `ready:cr-pending` / `ready:ci-pending` → "CodeRabbit running" / "CI running" → `charts.yellow`
  - `ready:cr-not-triggered` / `ready:cr-no-activity` → "Check CodeRabbit" → `charts.yellow`
  - `ready:ready` → "Ready to merge" → `charts.green`
  - `draft:clean` → "Draft · review it" → neutral badge colors
  - `merged` / `closed` → neutral, dimmed row
  - Local changes → extra purple pill, shown before the status pill
- **Badges**: activity-bar badge (`webviewView.badge`) = number of PRs with `next == "you"`; a status-bar item "$(git-pull-request) N need you" that focuses the view (hidden at 0).
- **Footer**: "Updated 2m ago · next check in 3:00", or the refresh error.
- **Keyboard and screen readers**: rows are buttons in a list; Enter expands; actions are real buttons/links with labels.

## Settings

- `prStatus.refreshIntervalSeconds` (number, default 300, 0 = off)
- `prStatus.scriptPath` (string, default empty = auto-discover)

## Repo and tooling

- Scaffold with Microsoft's official generator (`yo code`, `generator-code` 1.12.0): TypeScript, esbuild bundler, npm. Use Microsoft's `webview-view-sample` (vscode-extension-samples) as the reference for the WebviewView wiring.
- Tests: the template's test setup (`@vscode/test-cli`). Pure logic (pill mapping, Next selection, remote matching, candidate folders) lives in plain modules and is tested in the template's existing test file.
- Publish: VS Code Marketplace via `@vscode/vsce`, publisher **`baruchiro`** (exists; extension ID `baruchiro.pr-status-vscode`). Copy the release setup from the user's `baruchiro/url-title-preview`: a `workflow_dispatch` "Release" workflow taking `newVersion`, which builds, runs the VS Code tests under `xvfb-run`, bumps the version, publishes with the `VSCE_PAT` secret, and creates a GitHub release; plus a `ci.yaml`. The user adds the `VSCE_PAT` secret to the new repo; the first release is triggered by the user, not the build.
- The builder creates the GitHub repo (`gh repo create baruchiro/pr-status-vscode --public`) and clones it to `~/source/pr-status-vscode`.
- README with a screenshot, and a link back to the skill as the data source.

## Decided by the user

- Option B webview cards, not the native tree.
- Local changes detected by the extension through local git, not by a skill marker.
- New public repo `baruchiro/pr-status-vscode`, cloned at `~/source/pr-status-vscode`.
- Published to the VS Code Marketplace.
- Sidebar appears only when a project in the (multi-root) workspace has `pr-status.json`.
- Auto refresh by timer and file watcher.
- One "Next for you" across all files in the window.
- Publisher `baruchiro`, same as `url-title-preview`.
- The skill moves to its own plugin; the extension offers an "Install skill" button.

## My calls (check these)

- A branch only behind the PR head is not "Local changes".
- The timer run only replaces the file if the agent hasn't rewritten it meanwhile.
- Skill adds a `threads` count to the JSON for the "Needs you · N" pill.
- New plugin name `pr-review-loop`. `code-review-publish` stays in `baruchiro`, and the marker is copied into both plugins, guarded by the existing marker test.
- The install button runs in a visible terminal, never in the background.

- Timer refresh runs the skill's script rather than calling GitHub from the extension, to keep one classifier.
- Default interval 5 minutes; paused while the window is unfocused.
- "Next for you" skips PRs with local changes.
- Merged/closed PRs stay in the list, dimmed, until the agent drops them.
- Several files → one section per folder.
- Extension name `pr-status-vscode`, display name "PR Status".

## Left to the builder

- Webview rendering approach (plain TS + DOM, no framework expected) and message protocol.
- Exact spacing, icon choices per pill, empty/loading states.
- How relative times update in the footer.
- Marketplace metadata (categories, icon, gallery banner).
