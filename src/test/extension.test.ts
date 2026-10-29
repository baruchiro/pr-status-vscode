import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { candidateFolders, loadSection } from '../discovery';
import { findScript, prSpecs, runRefresh } from '../refresh';
import { RepoInfo, localChangesFor, parseRemote } from '../localChanges';
import { Pr, Section, countNeedsYou, parseStatusFile, pickNext, pillFor } from '../model';
import { buildState } from '../view';

export const pr = (o: Partial<Pr>): Pr => ({ repo: "o/r", number: 1, title: "t", url: "u", base: "main", phase: "ready", status: "ready:ready", next: "merge", hint: "", reviewOrder: null, ...o });
export const sec = (prs: Pr[], folder = "/w"): Section => ({ folder, file: { version: 1, generatedAt: "2026-10-29T09:00:00Z", prs } });

suite("model", () => {
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
		const file = (...prs: unknown[]) => JSON.stringify({ version: 1, generatedAt: "x", prs });
		assert.throws(() => parseStatusFile(file(pr({}), { ...pr({}), status: undefined })), /prs\[1\]/);
		assert.throws(() => parseStatusFile(file(null)), /prs\[0\]/);
		assert.throws(() => parseStatusFile(file({ ...pr({}), number: "1" })), /prs\[0\]/);
		assert.strictEqual(parseStatusFile(file({ ...pr({}), base: undefined, hint: undefined })).prs.length, 1);
		assert.strictEqual(parseStatusFile('{"version":1,"generatedAt":"x","prs":[]}').prs.length, 0);
	});
});

suite("discovery", () => {
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
});

suite("refresh", () => {
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

	test("prSpecs drops unsafe repos and numbers", () => {
		const prs = [pr({ repo: "-x/y" }), pr({ repo: "a/b;rm" }), pr({ number: 0 }), pr({ number: 1.5 }), pr({ repo: "ok/r-1.x", number: 3 })];
		assert.deepStrictEqual(prSpecs({ version: 1, generatedAt: "g", prs }), ["ok/r-1.x#3"]);
	});

	test("findScript ignores a relative setting", () => {
		assert.strictEqual(findScript("./evil.sh", undefined), undefined);
	});

	async function withFolder(scriptBody: string, run: (folder: string, script: string) => Promise<void>) {
		const folder = await fs.mkdtemp(path.join(os.tmpdir(), "pr-status-test-"));
		try {
			await fs.writeFile(path.join(folder, "pr-status.json"), '{"version":1,"generatedAt":"g1","prs":[]}');
			const script = path.join(folder, "fake.sh");
			await fs.writeFile(script, `#!/bin/bash\n${scriptBody}\n`);
			await fs.chmod(script, 0o755);
			await run(folder, script);
		} finally {
			await fs.rm(folder, { recursive: true, force: true });
		}
	}

	test("runRefresh replaces the files on success", async () => {
		await withFolder('echo \'{"version":1,"generatedAt":"g2","prs":[]}\' > "$PR_STATUS_JSON_FILE"; echo -n x > "$PR_STATUS_FILE"', async (folder, script) => {
			assert.deepStrictEqual(await runRefresh(folder, script, [], "/bin/bash"), { ok: true });
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(folder, "pr-status.json"), "utf8")).generatedAt, "g2");
			assert.strictEqual(await fs.readFile(path.join(folder, "pr-status.md"), "utf8"), "x");
			assert.deepStrictEqual((await fs.readdir(folder)).filter(f => f.endsWith(".tmp")), []);
		});
	});

	test("runRefresh discards its result when the file changed meanwhile", async () => {
		const body = 'echo \'{"version":1,"generatedAt":"g2","prs":[]}\' > "$PR_STATUS_JSON_FILE"; echo x > "$PR_STATUS_FILE"; echo \'{"version":1,"generatedAt":"agent","prs":[]}\' > "$(dirname "$0")/pr-status.json"';
		await withFolder(body, async (folder, script) => {
			const result = await runRefresh(folder, script, [], "/bin/bash");
			assert.strictEqual(result.ok === false && result.discarded, true);
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(folder, "pr-status.json"), "utf8")).generatedAt, "agent");
		});
	});

	test("runRefresh reports an old skill that writes no JSON", async () => {
		await withFolder('echo -n x > "$PR_STATUS_FILE"', async (folder, script) => {
			const result = await runRefresh(folder, script, [], "/bin/bash");
			assert.ok(!result.ok && /too old/.test(result.error));
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(folder, "pr-status.json"), "utf8")).generatedAt, "g1");
		});
	});

	test("runRefresh reports first stderr line on failure", async () => {
		await withFolder('echo; echo "gh: not logged in" >&2; echo more >&2; exit 1', async (folder, script) => {
			assert.deepStrictEqual(await runRefresh(folder, script, [], "/bin/bash"), { ok: false, error: "gh: not logged in" });
			assert.strictEqual(JSON.parse(await fs.readFile(path.join(folder, "pr-status.json"), "utf8")).generatedAt, "g1");
		});
	});
});

suite("localChanges", () => {
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
});

suite("view", () => {
	test("buildState picks next past local changes, labels several sections and attaches pills", () => {
		const a = pr({ repo: "o/a", number: 1, status: "ready:needs-you", next: "you" });
		const b = pr({ repo: "o/b", number: 2, status: "ready:needs-you", next: "you" });
		const state = buildState([sec([a], "/w/one"), { ...sec([b], "/w/two"), error: "bad" }], new Map([["o/a#1", "1 unpushed commits on x"]]), { scriptMissing: false });
		assert.deepStrictEqual(state.next, { key: "o/b#2", folder: "/w/two" });
		assert.deepStrictEqual(state.sections.map(s => [s.label, s.error, s.generatedAt]), [["one", undefined, "2026-10-29T09:00:00Z"], ["two", "bad", "2026-10-29T09:00:00Z"]]);
		assert.strictEqual(state.sections[0].prs[0].local, "1 unpushed commits on x");
		assert.deepStrictEqual(state.sections[1].prs[0].pill, { label: "Needs you", tone: "orange" });
		assert.strictEqual(buildState([sec([a])], new Map(), { scriptMissing: false }).sections[0].label, undefined);
	});
});
