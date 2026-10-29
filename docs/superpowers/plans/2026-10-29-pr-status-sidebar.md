# PR Status Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code sidebar (webview cards) that shows the `resolving-pr-review-comments` skill's `pr-status.json` live, plus the skill-side changes it needs: richer JSON, its own `pr-review-loop` plugin, and docs that point at the extension.

**Architecture:** Two repos. Part A changes `baruchiro/skills` (`~/source/skills`): the jq classifier gains `state`/`threads`/branch fields and `merged`/`closed` statuses, and the skill moves into a new `pr-review-loop` plugin. Part B builds `baruchiro/pr-status-vscode` (`~/source/pr-status-vscode`): pure TypeScript modules (model, discovery, refresh, local changes) under a thin VS Code layer (WebviewViewProvider, watchers, timer, status bar). Status classification stays in the skill's jq; the extension only reads JSON and re-runs the skill's script.

**Tech Stack:** bash + jq (skill); TypeScript, VS Code API ≥ 1.90, esbuild, mocha via `@vscode/test-cli`, `@vscode/codicons`, `@vscode/vsce` (extension).

**Spec:** `docs/superpowers/specs/2026-10-29-pr-status-sidebar-design.md` (this repo)

## Global Constraints

- Extension identity: `publisher: "baruchiro"`, `name: "pr-status-vscode"`, `displayName: "PR Status"`; extension ID `baruchiro.pr-status-vscode`.
- New plugin: `pr-review-loop`, version `0.1.0`, in the `skills` marketplace (`pr-review-loop@skills`). `baruchiro` plugin bumps `0.11.0` → `0.12.0`.
- JSON contract stays `version: 1`; fields are only added.
- Settings: `prStatus.refreshIntervalSeconds` (default `300`, `0` = off), `prStatus.scriptPath` (default `""`).
- Context key `prStatus.hasFile`; view container id `prStatus`; webview view id `prStatus.view`; commands `prStatus.refresh`, `prStatus.installSkill`.
- Install command text, verbatim: `claude plugin marketplace add baruchiro/skills && claude plugin install pr-review-loop@skills`.
- Styling: only `--vscode-*` CSS variables and bundled `@vscode/codicons`; no CDN, no custom fonts or brand colors.
- Tests: no new test files. Skill tests go in the existing `test-*.sh` scripts; extension tests go in the template's `src/test/extension.test.ts`.
- No code comments unless a non-obvious *why* (user rule).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A `pr-status.json` from an older plugin (no `state`, `threads`, `headRefName`) must still render: pills without a count, nothing treated as merged. → Task B2 test `pillFor tolerates old JSON`.
2. A malformed, half-written or `version: 2` file must not blank the panel: keep the last good data and show the error. → Task B3 test `loadSection keeps last good data on bad JSON`.
3. `gh`/`jq` missing or `gh` not logged in (script exits non-zero) must leave data on screen and surface the first stderr line. → Task B4 test `runRefresh reports first stderr line on failure`.
4. Claude rewrites `pr-status.json` while a timer run is in flight: the agent's newer file must win. → Task B4 test `runRefresh discards its result when the file changed meanwhile`.
5. Git remotes in every common form (`git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git`, mixed case) must match `o/r`. → Task B5 test `parseRemote handles ssh, https and case`.

---

## Part A — `baruchiro/skills` (`~/source/skills`)

Work on a branch `pr-review-loop-plugin` off `master`. The `pr-status.json` output change from the design session is already in the working tree, uncommitted (`pr-status.sh`, `project-dir.sh`, `test-project-dir.sh`).

### Task A1: Classifier fields and merged/closed statuses

**Files:**
- Modify: `baruchiro/skills/resolving-pr-review-comments/classify-pr-status.jq` (`classifyPr`)
- Modify: `baruchiro/skills/resolving-pr-review-comments/pr-status.sh` (GraphQL query)
- Modify: `baruchiro/skills/resolving-pr-review-comments/SKILL.md` (Status report section)
- Test: `baruchiro/skills/resolving-pr-review-comments/test-classify-pr-status.sh`

**Interfaces:**
- Produces: each PR object in `pr-status.json` and stdout gains `state` (`"OPEN"|"MERGED"|"CLOSED"`), `headRefName` (string), `headRefOid` (string), `threads` (number). New statuses `merged` and `closed` with `next: "none"`, `phase` unchanged.

- [ ] **Step 1: Commit the existing JSON-output change on the branch**

```bash
cd ~/source/skills && git checkout -b pr-review-loop-plugin
git add baruchiro/skills/resolving-pr-review-comments/{pr-status.sh,project-dir.sh,test-project-dir.sh}
git commit -m "feat(resolving-pr-review-comments): write pr-status.json beside pr-status.md"
```

- [ ] **Step 2: Write the failing tests**

In `pr()`, add `state: \"${STATE:-OPEN}\", headRefName: \"feat\"` to the fixture object. Add a `field()` helper like `classify()` that prints `classifyPr($marker) | .<name>`. Add:

```bash
STATE=MERGED check merged false "[$human]" "[]" "[]" "[]"
STATE=CLOSED check closed true "[]" "[]" "[]" "[]"
[ "$(STATE=MERGED field next false "[]" "[]" "[]" "[]")" = none ] || { echo "FAIL: merged next" >&2; exit 1; }
[ "$(field threads true "[$human,$human]" "[]" "[]" "[]")" = 2 ] || { echo "FAIL: threads agent" >&2; exit 1; }
[ "$(field threads true "[$answered]" "[]" "[]" "[]")" = 1 ] || { echo "FAIL: threads you" >&2; exit 1; }
[ "$(field threads false "[]" "[$ci_ok,$cr_done]" "$cr_review_head" "[]")" = 0 ] || { echo "FAIL: threads none" >&2; exit 1; }
[ "$(field headRefName true "[]" "[]" "[]" "[]")" = feat ] || { echo "FAIL: headRefName" >&2; exit 1; }
```

- [ ] **Step 3: Run to verify it fails**

Run: `baruchiro/skills/resolving-pr-review-comments/test-classify-pr-status.sh`
Expected: `FAIL: want merged, got draft:needs-agent` (or similar)

- [ ] **Step 4: Implement**

In `classifyPr`: `result()` adds `state: ($pr.state // "OPEN")`, `headRefName: $pr.headRefName`, `headRefOid: $pr.headRefOid`, and `threads` (count of `$owners` equal to `"you"` for needs-you, `"agent"` for needs-agent, else `0` — pass it as a 4th arg or compute inside). First match, before needs-you: `$pr.state == "MERGED"` → status `merged`, `next: "none"`, hint `"merged"`; `"CLOSED"` → `closed`, `"none"`, `"closed without merging"`. The status for these is the bare word, not `phase:` prefixed. In `pr-status.sh` add `state headRefName` to the `pullRequest` selection. In `SKILL.md`, add `merged` / `closed` to the status list, and mention `pr-status.json` (`PR_STATUS_JSON_FILE`) next to `pr-status.md` in the Status report paragraph.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd baruchiro/skills/resolving-pr-review-comments && ./test-classify-pr-status.sh && ./test-project-dir.sh`
Expected: ends with `ok` / all `ok …` lines

- [ ] **Step 6: Live check**

Run: `PR_STATUS_FILE=$TMPDIR/s.md PR_STATUS_JSON_FILE=$TMPDIR/s.json ./pr-status.sh baruchiro/skills#2 >/dev/null && jq -c '.prs[0] | {status,state,next,threads,headRefName}' $TMPDIR/s.json`
Expected: `{"status":"merged","state":"MERGED","next":"none","threads":0,"headRefName":"add-book-search-0.1.0"}`

- [ ] **Step 7: Commit**

```bash
git add baruchiro/skills/resolving-pr-review-comments
git commit -m "feat(resolving-pr-review-comments): report merged/closed PRs, thread counts and head branch"
```

### Task A2: Move the skill into the `pr-review-loop` plugin

**Files:**
- Move: `baruchiro/skills/resolving-pr-review-comments/` → `pr-review-loop/skills/resolving-pr-review-comments/` (`git mv`)
- Create: `pr-review-loop/.claude-plugin/plugin.json`, `pr-review-loop/shared/agent-reply-marker.txt` (byte-identical copy), `pr-review-loop/shared/README.md`
- Modify: `.claude-plugin/marketplace.json`, `baruchiro/.claude-plugin/plugin.json`, `baruchiro/shared/test-agent-reply-marker.sh`, `baruchiro/shared/README.md`, `baruchiro/agents/code-review-publish.md:73-75`, `pr-review-loop/skills/resolving-pr-review-comments/SKILL.md:14,66` (+ Status report section), `baruchiro/skills/pr-walkthrough/SKILL.md:93`, `README.md`

**Interfaces:**
- Consumes: Task A1's JSON fields.
- Produces: installable `pr-review-loop@skills`; script at `<installPath>/skills/resolving-pr-review-comments/pr-status.sh`.

- [ ] **Step 1: Extend the marker test first (failing)**

In `test-agent-reply-marker.sh`, point the SKILL.md and fetch-script paths at `$PLUGIN_DIR/../pr-review-loop/skills/resolving-pr-review-comments/…`, and add a check that fails with `FAIL: marker copies differ` unless `cmp -s "$SHARED_DIR/agent-reply-marker.txt" "$PLUGIN_DIR/../pr-review-loop/shared/agent-reply-marker.txt"`.

Run: `baruchiro/shared/test-agent-reply-marker.sh` → Expected: FAIL (paths missing)

- [ ] **Step 2: Move and create the plugin**

`git mv` the skill folder; copy the marker; `plugin.json` = `{"name":"pr-review-loop","version":"0.1.0","description":"Drain review threads on your own PRs and track each PR's status (pr-status.md / pr-status.json)","author":{"name":"baruchiro","email":"baruchiro@gmail.com"}}`. Marketplace entry with the same name/description/version and `"source": "./pr-review-loop"`; `baruchiro` version `0.12.0` in both its `plugin.json` and the marketplace entry. Scripts reach the marker via `$SCRIPT_DIR/../../shared/` — unchanged, now resolves inside `pr-review-loop`.

- [ ] **Step 3: Update cross-references**

- `pr-review-loop/shared/README.md`: the marker here is a copy of `baruchiro/shared/agent-reply-marker.txt`; both plugins must agree; `baruchiro/shared/test-agent-reply-marker.sh` checks it.
- `baruchiro/shared/README.md`, `code-review-publish.md:75`, skill `SKILL.md:14,66`: replace "in this plugin" with which plugin holds what (`code-review-publish` in `baruchiro`, the skill in `pr-review-loop`, one marker copy in each).
- `pr-walkthrough/SKILL.md:93`: `personal:code-review-publish` → `baruchiro:code-review-publish`.
- Skill `SKILL.md` Status report: one line — the [PR Status VS Code extension](https://marketplace.visualstudio.com/items?itemName=baruchiro.pr-status-vscode) shows `pr-status.json` live in a sidebar.
- Root `README.md`: `pr-review-loop` row in the plugin table + `/plugin install pr-review-loop@skills`; move the skill's row to a new "Contents — `pr-review-loop`" section with the extension link; a note that `baruchiro` no longer contains it, so existing users install `pr-review-loop@skills` too; update the Structure tree.

- [ ] **Step 4: Verify**

Run:
```bash
baruchiro/shared/test-agent-reply-marker.sh
pr-review-loop/skills/resolving-pr-review-comments/test-classify-pr-status.sh
pr-review-loop/skills/resolving-pr-review-comments/test-project-dir.sh
pr-review-loop/skills/resolving-pr-review-comments/test-slim-coderabbit-body.sh
claude plugin validate . && claude plugin validate pr-review-loop && claude plugin validate baruchiro
grep -rn "baruchiro/skills/resolving-pr-review-comments\|personal:code-review-publish" . --exclude-dir=.git
```
Expected: all tests `OK`/`ok`, validations pass, final grep prints nothing.

- [ ] **Step 5: Commit, then ask before pushing**

```bash
git add -A && git commit -m "feat: move resolving-pr-review-comments into its own pr-review-loop plugin"
```
Ask the user before `git push -u origin pr-review-loop-plugin` and `gh pr create`. After merge: `claude plugin marketplace update skills && claude plugin install pr-review-loop@skills`.

---

## Part B — `baruchiro/pr-status-vscode` (`~/source/pr-status-vscode`)

All extension code under `src/`; all tests in `src/test/extension.test.ts` (mocha `suite`/`test`, `assert`). Run tests with `npm test`.

### Task B1: Scaffold from the official generator, with CI and release workflows

**Files:**
- Create (generator): `package.json`, `tsconfig.json`, `esbuild.js`, `src/extension.ts`, `src/test/extension.test.ts`, `.vscode-test.mjs`, `.vscodeignore`, `eslint.config.mjs`, `.vscode/*`
- Create: `src/typings/git.d.ts` (copy of `extensions/git/src/api/git.d.ts` from microsoft/vscode `main`), `media/pr.svg` (activity-bar icon, `git-pull-request` shape, `currentColor`), `.github/workflows/ci.yaml`, `.github/workflows/publish.yaml`

**Interfaces:**
- Produces: `npm run compile`, `npm test`, `npm run package` working; `package.json` contributions every later task fills.

- [ ] **Step 1: Generate into the existing clone**

Run: `cd ~/source/pr-status-vscode && npx --yes --package yo --package generator-code -- yo code . --quick -t ts --extensionId pr-status-vscode --extensionDescription "Your PRs in review order and whose turn it is, live from the resolving-pr-review-comments Claude Code skill" --pkgManager npm --bundle esbuild --gitInit false`
Expected: files created; `docs/` untouched.

- [ ] **Step 2: Set identity and contributions in `package.json`**

`publisher`, `displayName`, `repository` (`https://github.com/baruchiro/pr-status-vscode`), `license` MIT (+ `LICENSE`), `engines.vscode: "^1.90.0"` (and matching `@types/vscode`), `activationEvents: ["onStartupFinished"]`, `extensionDependencies: ["vscode.git"]`, `contributes`: `viewsContainers.activitybar` `{id: "prStatus", title: "PR Status", icon: "media/pr.svg"}`; `views.prStatus` `[{type: "webview", id: "prStatus.view", name: "PR Status", when: "prStatus.hasFile"}]`; commands `prStatus.refresh` ("PR Status: Refresh", icon `$(refresh)`) and `prStatus.installSkill` ("PR Status: Install Claude Code skill"); `menus.view/title` refresh on `view == prStatus.view`; `configuration` with the two settings from Global Constraints. Add dependency `@vscode/codicons`; add `"package": "vsce package"` and `"deploy": "vsce publish"` scripts and `@vscode/vsce` devDependency. Replace the template's hello-world command with an empty `activate`.

- [ ] **Step 3: Workflows**

Adapt `baruchiro/url-title-preview`'s `.github/workflows/ci.yaml` and `publish.yaml` to npm: `npm ci`, `npm run compile`, `npm run lint`, `xvfb-run -a npm test`; publish is `workflow_dispatch` with `newVersion`, runs `npm version $newVersion --no-git-tag-version`, `npm run deploy` with `VSCE_PAT: ${{ secrets.VSCE_PAT }}`, then `gh release create v$newVersion --generate-notes`. Use `actions/setup-node` with `node-version: '20'`.

- [ ] **Step 4: Verify**

Run: `npm run compile && npm run lint && npm test && npx vsce package --out /tmp/pr-status.vsix`
Expected: tests pass (template sample test), `.vsix` created.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold extension with yo code"
```

### Task B2: Model — parse, pills, next, counts

**Files:**
- Create: `src/model.ts`
- Test: `src/test/extension.test.ts`

**Interfaces:**
- Produces:
  - `interface Pr { repo: string; number: number; title: string; url: string; base: string; phase: string; status: string; next: string; hint: string; reviewOrder: string | null; state?: "OPEN" | "MERGED" | "CLOSED"; headRefName?: string; headRefOid?: string; threads?: number }`
  - `interface StatusFile { version: 1; generatedAt: string; prs: Pr[] }`
  - `interface Section { folder: string; file?: StatusFile; error?: string }`
  - `type Tone = "orange" | "purple" | "red" | "yellow" | "green" | "neutral"`
  - `parseStatusFile(text: string): StatusFile` — throws `Error` with a readable message on bad JSON, missing `prs` array, or `version !== 1`.
  - `prKey(pr: Pr): string` → `` `${repo}#${number}` ``
  - `pillFor(pr: Pr): { label: string; tone: Tone }`
  - `pickNext(sections: Section[], localChanges: ReadonlySet<string>): { sectionIndex: number; pr: Pr } | undefined`
  - `countNeedsYou(sections: Section[]): number`

- [ ] **Step 1: Write the failing tests**

```ts
const pr = (o: Partial<Pr>): Pr => ({ repo: "o/r", number: 1, title: "t", url: "u", base: "main", phase: "ready", status: "ready:ready", next: "merge", hint: "", reviewOrder: null, ...o });
const sec = (prs: Pr[], folder = "/w"): Section => ({ folder, file: { version: 1, generatedAt: "2026-10-29T09:00:00Z", prs } });

test("pillFor maps every status", () => {
  assert.deepStrictEqual(pillFor(pr({ status: "draft:needs-you", threads: 2 })), { label: "Needs you · 2", tone: "orange" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:needs-agent" })), { label: "Claude's turn", tone: "purple" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:ci-failing" })), { label: "CI failing", tone: "red" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:cr-pending" })), { label: "CodeRabbit running", tone: "yellow" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:ci-pending" })), { label: "CI running", tone: "yellow" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:cr-not-triggered" })), { label: "Check CodeRabbit", tone: "yellow" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:cr-no-activity" })), { label: "Check CodeRabbit", tone: "yellow" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:ready" })), { label: "Ready to merge", tone: "green" });
  assert.deepStrictEqual(pillFor(pr({ status: "draft:clean" })), { label: "Draft · review it", tone: "neutral" });
  assert.deepStrictEqual(pillFor(pr({ status: "merged" })), { label: "Merged", tone: "neutral" });
  assert.deepStrictEqual(pillFor(pr({ status: "closed" })), { label: "Closed", tone: "neutral" });
  assert.deepStrictEqual(pillFor(pr({ status: "ready:something-new" })), { label: "ready:something-new", tone: "neutral" });
});

test("pillFor tolerates old JSON", () => {
  assert.deepStrictEqual(pillFor(pr({ status: "draft:needs-you" })), { label: "Needs you", tone: "orange" });
});

test("pickNext takes the first PR needing you, skipping local changes, across sections", () => {
  const a = pr({ number: 1, next: "claude" }), b = pr({ number: 2, next: "you" }), c = pr({ number: 3, next: "you" });
  assert.strictEqual(pickNext([sec([a, b, c])], new Set())?.pr.number, 2);
  assert.strictEqual(pickNext([sec([a, b, c])], new Set(["o/r#2"]))?.pr.number, 3);
  assert.deepStrictEqual(pickNext([sec([a]), sec([c], "/x")], new Set())?.sectionIndex, 1);
  assert.strictEqual(pickNext([sec([a])], new Set()), undefined);
});

test("countNeedsYou counts each PR once across files", () => {
  const y = pr({ number: 7, next: "you" });
  assert.strictEqual(countNeedsYou([sec([y]), sec([y], "/x"), { folder: "/z", error: "bad" }]), 1);
});

test("parseStatusFile rejects bad input", () => {
  assert.throws(() => parseStatusFile("{"));
  assert.throws(() => parseStatusFile('{"version":2,"generatedAt":"x","prs":[]}'), /version/);
  assert.throws(() => parseStatusFile('{"version":1,"generatedAt":"x"}'), /prs/);
  assert.strictEqual(parseStatusFile('{"version":1,"generatedAt":"x","prs":[]}').prs.length, 0);
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test` → FAIL, `model` not found.
- [ ] **Step 3: Implement `src/model.ts`** with the signatures above; `pickNext`/`countNeedsYou` skip sections without `file`.
- [ ] **Step 4: Run tests** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: status model, pills and next-for-you"` (add `src/model.ts`).

### Task B3: Discovery and the status store

**Files:**
- Create: `src/discovery.ts`
- Modify: `src/extension.ts`
- Test: `src/test/extension.test.ts`

**Interfaces:**
- Consumes: `parseStatusFile`, `Section` (B2).
- Produces:
  - `candidateFolders(workspaceFolders: string[], workspaceFile: string | undefined): string[]` — dir of `workspaceFile` first (only when it ends with `.code-workspace`), then folders in order, deduped.
  - `loadSection(folder: string, prev: Section | undefined, text: string): Section` — on parse error returns `{ folder, file: prev?.file, error: message }`.
  - `class StatusStore implements vscode.Disposable { readonly onDidChange: vscode.Event<Section[]>; get sections(): Section[]; constructor() }` — watches `pr-status.json` in each candidate folder (`createFileSystemWatcher(new RelativePattern(Uri.file(folder), "pr-status.json"))`), re-reads on create/change, drops on delete, recomputes candidates on `onDidChangeWorkspaceFolders`, and sets `setContext("prStatus.hasFile", sections.length > 0)`. A section exists only while its file exists.

- [ ] **Step 1: Write the failing tests**

```ts
test("candidateFolders puts the workspace-file folder first and dedupes", () => {
  assert.deepStrictEqual(candidateFolders(["/w/a", "/w"], "/w/team.code-workspace"), ["/w", "/w/a"]);
  assert.deepStrictEqual(candidateFolders(["/w/a"], undefined), ["/w/a"]);
  assert.deepStrictEqual(candidateFolders(["/w/a"], "/tmp/Untitled-1"), ["/w/a"]);
});

test("loadSection keeps last good data on bad JSON", () => {
  const good = loadSection("/w", undefined, '{"version":1,"generatedAt":"g1","prs":[]}');
  const bad = loadSection("/w", good, '{"version":1,');
  assert.strictEqual(bad.file?.generatedAt, "g1");
  assert.ok(bad.error);
});
```

- [ ] **Step 2: Run** — `npm test` → FAIL.
- [ ] **Step 3: Implement** `src/discovery.ts`; in `activate`, construct `StatusStore` and push it to `context.subscriptions`. Workspace file path: `vscode.workspace.workspaceFile?.scheme === "file" ? workspaceFile.fsPath : undefined`.
- [ ] **Step 4: Run** — `npm test` → PASS.
- [ ] **Step 5: Manual check** — F5 into the Extension Development Host with a folder containing `docs/fixtures/pr-status.json` copied to its root: the PR Status icon appears; delete the file: it disappears. (Create `docs/fixtures/pr-status.json` with six PRs, one per pill tone, including one `merged` and one with `threads`. It is also used by B6.)
- [ ] **Step 6: Commit** — `"feat: find pr-status.json in the workspace and watch it"`.

### Task B4: Refresh — find the script, run it safely, schedule it

**Files:**
- Create: `src/refresh.ts`
- Modify: `src/extension.ts`
- Test: `src/test/extension.test.ts`

**Interfaces:**
- Consumes: `StatusFile`, `Section`, `StatusStore` (B2, B3).
- Produces:
  - `findScript(setting: string, installedPluginsJson: string | undefined): string | undefined` — setting wins; else `.plugins` entries keyed `pr-review-loop@*` then `baruchiro@*`, first array element's `installPath` + `/skills/resolving-pr-review-comments/pr-status.sh`.
  - `prSpecs(file: StatusFile): string[]` — `` `${repo}#${number}` `` in file order.
  - `runRefresh(folder: string, script: string, specs: string[], shell?: string): Promise<{ ok: true } | { ok: false; error: string; discarded?: boolean }>` — reads `<folder>/pr-status.json`'s `generatedAt`, runs `shell -lc '"$0" "$@"' script ...specs` (default `process.env.SHELL ?? "/bin/bash"`) with `PR_STATUS_FILE`/`PR_STATUS_JSON_FILE` pointing at a fresh `fs.mkdtemp(os.tmpdir())` dir and `PR_REVIEW_LINKS_FILE=<folder>/pr-review-links.json`, cwd `folder`. On exit 0: if the real file's `generatedAt` is unchanged, copy each temp to `<target>.tmp` in `folder` and `rename` over `pr-status.md` / `pr-status.json`; else return `{ ok: false, error: "file changed during refresh", discarded: true }`. On non-zero: `{ ok: false, error: <first non-empty stderr line> }`. Always remove the temp dir.
  - `class Refresher implements vscode.Disposable { constructor(store: StatusStore); refreshNow(): Promise<void>; readonly onDidChangeState: vscode.Event<RefreshState> }` with `interface RefreshState { lastRun?: Date; nextRun?: Date; error?: string; scriptMissing: boolean }`. Timer from `prStatus.refreshIntervalSeconds` (re-read on config change; `0` = no timer); skips ticks while `!vscode.window.state.focused`; on focus regained runs at once if `lastRun` older than the interval; one run at a time per folder. Registers `prStatus.refresh`.

- [ ] **Step 1: Write the failing tests**

```ts
test("findScript prefers the setting, then pr-review-loop, then baruchiro", () => {
  const ip = JSON.stringify({ plugins: {
    "baruchiro@skills": [{ installPath: "/c/b" }],
    "pr-review-loop@skills": [{ installPath: "/c/p" }] } });
  const tail = "/skills/resolving-pr-review-comments/pr-status.sh";
  assert.strictEqual(findScript("/x.sh", ip), "/x.sh");
  assert.strictEqual(findScript("", ip), "/c/p" + tail);
  assert.strictEqual(findScript("", JSON.stringify({ plugins: { "baruchiro@skills": [{ installPath: "/c/b" }] } })), "/c/b" + tail);
  assert.strictEqual(findScript("", undefined), undefined);
  assert.strictEqual(findScript("", "{"), undefined);
});

test("prSpecs keeps file order", () => {
  assert.deepStrictEqual(prSpecs({ version: 1, generatedAt: "g", prs: [pr({ number: 9 }), pr({ repo: "a/b", number: 1 })] }), ["o/r#9", "a/b#1"]);
});
```

Three `runRefresh` tests use a temp folder holding `pr-status.json` (`generatedAt: "g1"`) and a fake script written to that folder (`chmod 755`), run with `shell = "/bin/bash"`:
- `runRefresh replaces the files on success` — script writes `{"version":1,"generatedAt":"g2","prs":[]}` to `$PR_STATUS_JSON_FILE` and `x` to `$PR_STATUS_FILE`; expect `{ ok: true }`, real JSON has `g2`, `pr-status.md` is `x`, no `*.tmp` left in the folder.
- `runRefresh discards its result when the file changed meanwhile` — script also overwrites `<folder>/pr-status.json` with `generatedAt: "agent"`; expect `discarded: true` and the real file still says `agent`.
- `runRefresh reports first stderr line on failure` — script `echo; echo "gh: not logged in" >&2; echo more >&2; exit 1`; expect `{ ok: false, error: "gh: not logged in" }` and the real file still `g1`.

- [ ] **Step 2: Run** — `npm test` → FAIL.
- [ ] **Step 3: Implement** `src/refresh.ts`; wire `Refresher` in `activate` (reads `~/.claude/plugins/installed_plugins.json` with `fs.readFile`, `undefined` if missing).
- [ ] **Step 4: Run** — `npm test` → PASS.
- [ ] **Step 5: Commit** — `"feat: refresh pr-status.json on a timer through the skill's script"`.

### Task B5: Local changes from the Git extension

**Files:**
- Create: `src/localChanges.ts`
- Modify: `src/extension.ts`
- Test: `src/test/extension.test.ts`

**Interfaces:**
- Consumes: `Pr`, `prKey` (B2); `src/typings/git.d.ts` (B1).
- Produces:
  - `parseRemote(url: string): string | undefined` — lower-cased `owner/name` for github.com remotes, else `undefined`.
  - `interface RepoInfo { remotes: string[]; head?: string; dirty: number; branches: { name: string; ahead?: number }[] }`
  - `localChangesFor(prs: Pr[], repos: RepoInfo[]): Map<string, string>` — key `prKey`, value the tooltip text: `"N uncommitted files on <branch>"` when `head === headRefName && dirty > 0`; else `"N unpushed commits on <branch>"` when that branch's `ahead > 0`. Behind-only, no match, or no `headRefName` → absent. Repo match: `parseRemote` of any remote equals `pr.repo.toLowerCase()`.
  - `class LocalChangesTracker implements vscode.Disposable { constructor(store: StatusStore); get current(): Map<string, string>; readonly onDidChange: vscode.Event<void> }` — adapts `vscode.git` `getAPI(1)` repositories (`state.HEAD?.name`, `state.workingTreeChanges.length + state.indexChanges.length`, `getBranch(name)`'s `ahead` vs upstream for each PR's `headRefName`) to `RepoInfo`, recomputing on `repository.state.onDidChange`, `onDidOpenRepository`, `onDidCloseRepository` and store changes.

- [ ] **Step 1: Write the failing tests**

```ts
test("parseRemote handles ssh, https and case", () => {
  for (const u of ["git@github.com:Owner/Repo.git", "https://github.com/owner/repo", "https://github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
    assert.strictEqual(parseRemote(u), "owner/repo", u);
  }
  assert.strictEqual(parseRemote("git@gitlab.com:owner/repo.git"), undefined);
});

test("localChangesFor flags dirty or ahead branches only", () => {
  const p = pr({ repo: "o/r", number: 5, headRefName: "feat" });
  const repo = (o: Partial<RepoInfo>): RepoInfo => ({ remotes: ["git@github.com:o/r.git"], dirty: 0, branches: [], ...o });
  assert.strictEqual(localChangesFor([p], [repo({ head: "feat", dirty: 3 })]).get("o/r#5"), "3 uncommitted files on feat");
  assert.strictEqual(localChangesFor([p], [repo({ branches: [{ name: "feat", ahead: 2 }] })]).get("o/r#5"), "2 unpushed commits on feat");
  assert.strictEqual(localChangesFor([p], [repo({ head: "main", dirty: 3, branches: [{ name: "feat", ahead: 0 }] })]).size, 0);
  assert.strictEqual(localChangesFor([p], [repo({ remotes: ["git@github.com:x/y.git"], head: "feat", dirty: 1 })]).size, 0);
  assert.strictEqual(localChangesFor([pr({ number: 5 })], [repo({ head: "feat", dirty: 1 })]).size, 0);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `"feat: flag PRs with local changes on the way"`.

### Task B6: The webview view, badges and status bar

**Files:**
- Create: `src/view.ts`, `media/view.css`, `media/view.js`
- Modify: `src/extension.ts`, `package.json` (`.vscodeignore` must keep `node_modules/@vscode/codicons/dist`)
- Test: manual, with `docs/fixtures/pr-status.json`

**Interfaces:**
- Consumes: `StatusStore`, `Refresher`, `LocalChangesTracker`, `pillFor`, `pickNext`, `countNeedsYou`, `prKey`.
- Produces: `class PrStatusViewProvider implements vscode.WebviewViewProvider` registered for `prStatus.view` (`retainContextWhenHidden: true`). Message protocol:
  - extension → webview: `{ type: "state", sections: Array<{ folder: string; label?: string; error?: string; prs: Array<Pr & { pill: { label: string; tone: Tone }; local?: string }> }>, next?: { key: string; folder: string }, refresh: RefreshState }`. `label` (folder basename) only when there is more than one section.
  - webview → extension: `{ type: "open", url: string }` (→ `vscode.env.openExternal`), `{ type: "refresh" }`, `{ type: "installSkill" }`, `{ type: "openSettings" }` (→ `workbench.action.openSettings`, `prStatus`).

Layout and copy follow the spec's UI section and mockup B:
- "NEXT FOR YOU" card: `#N title`, pills (status, "Draft" when `phase === "draft"`, `repo → base`), hint, **Open PR** primary button, **Review order** secondary (hidden when `null`; text "Review order (stale)" and no link when `"stale"`).
- No next PR: the card reads "Nothing needs you" plus "Up next: #N title — <pill label>" for the first PR whose `next` is not `"none"`, if any.
- "REVIEW ORDER · N" list: position, `#N title`, a purple "Local changes" pill (codicon `sync`, `title` = tooltip text) before the status pill. Merged/closed rows at reduced opacity. Clicking a row (a `<button>`) toggles inline details: hint, `repo → base`, Open PR / Review order. Highlight the next PR's row with `--vscode-list-activeSelectionBackground`.
- Pill tones map to `--vscode-charts-<tone>` text on that color at ~16% background (`color-mix`); `neutral` uses `--vscode-badge-background`/`--vscode-badge-foreground`.
- Footer: "Updated 2m ago · next check in 3:00" (relative times computed in the webview every second from `generatedAt` and `refresh.nextRun`), or the error text; when `scriptMissing`: "Auto refresh off: skill not found · Install skill · Settings".
- Activity-bar badge `view.badge = n ? { value: n, tooltip: "N PRs need you" } : undefined`; status-bar item `$(git-pull-request) N need you` (command focuses `prStatus.view`, hidden at 0), `n = countNeedsYou`.
- Strict CSP with a nonce; `localResourceRoots`: `media`, `node_modules/@vscode/codicons/dist`.

- [ ] **Step 1: Implement** the provider, CSS and script.
- [ ] **Step 2: Manual check** in the Extension Development Host with the fixture, in Dark Modern, Light Modern and a High Contrast theme: next card shows the first `next: "you"` PR; badge and status bar show the count; Open PR opens the browser; Tab/Enter reach every row and button; editing the fixture's JSON on disk re-renders within a second; breaking the JSON shows the error and keeps the cards.
- [ ] **Step 3: Run** `npm run compile && npm run lint && npm test` → PASS.
- [ ] **Step 4: Commit** — `"feat: PR Status webview with next-for-you card, pills and badges"`.

### Task B7: Install-skill command

**Files:**
- Create: `src/installSkill.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Produces: `installSkill(): Promise<void>` registered as `prStatus.installSkill`. Checks `claude` with `$SHELL -lc 'command -v claude'`. Found → `vscode.window.createTerminal({ name: "PR Status" })`, `show()`, `sendText(<install command from Global Constraints>)`. Not found → `showInformationMessage("Claude Code CLI not found. Install it, then run: <command>", "Copy command", "Install Claude Code")`; "Copy command" → `env.clipboard.writeText(command)`; "Install Claude Code" → open `https://docs.claude.com/en/docs/claude-code/setup`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Manual check** — run the command from the palette: a "PR Status" terminal opens with the exact command. Then launch the Extension Development Host with `SHELL=/bin/sh PATH=/usr/bin:/bin` so `claude` is not found: the message shows and "Copy command" puts the exact command on the clipboard.
- [ ] **Step 3: Commit** — `"feat: offer to install the pr-review-loop Claude Code plugin"`.

### Task B8: README, packaging and end-to-end check

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `package.json` (`icon: media/icon.png` 128×128, `categories: ["Other"]`, `keywords`, `galleryBanner` dark)
- Create: `media/icon.png`, `media/screenshot.png`

- [ ] **Step 1: README** — what it shows, the screenshot, requirements (`gh` logged in, `jq`, the `pr-review-loop@skills` Claude Code plugin; the Install skill command), the two settings, how the file is found (workspace-file folder, then workspace folders), the local-changes rule and its limits, link to `baruchiro/skills`.
- [ ] **Step 2: End-to-end with the real skill** (after Part A is merged and `pr-review-loop@skills` is installed): in a workspace, run the skill's status report on 2+ real PRs; install the `.vsix` (`npm run package && code --install-extension pr-status-vscode-*.vsix`); the panel appears, matches `pr-status.md`, and after setting `prStatus.refreshIntervalSeconds` to `60` the footer's "Updated" resets within a minute.
- [ ] **Step 3: Commit and push** — `"docs: README, icon and marketplace metadata"`; `git push`.
- [ ] **Step 4: Hand off release** — tell the user to add the `VSCE_PAT` secret to `baruchiro/pr-status-vscode` and run the "Release" workflow with `newVersion` `0.1.0`. Do not publish from here.
