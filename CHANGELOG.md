# Change Log

All notable changes to the "pr-review-loop" extension will be documented in this file.

## 0.1.0

- Sidebar showing the `pr-status.json` from the `resolving-pr-review-comments` skill.
- "Next for you" card and review-order list with status pills.
- "Local changes" pill for PRs whose branch has uncommitted or unpushed work.
- Activity-bar badge and status-bar count.
- Auto refresh on a timer (`prStatus.refreshIntervalSeconds`) plus a file watcher.
- `PR Status: Refresh` and `PR Status: Install Claude Code skill` commands.
- Workspace Trust: refreshing is off in untrusted workspaces.
- `prStatus.scriptPath` is machine-scoped.
