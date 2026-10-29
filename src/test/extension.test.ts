import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';
import { candidateFolders, loadSection } from '../discovery';
import { Pr, Section, countNeedsYou, parseStatusFile, pickNext, pillFor } from '../model';

export const pr = (o: Partial<Pr>): Pr => ({ repo: "o/r", number: 1, title: "t", url: "u", base: "main", phase: "ready", status: "ready:ready", next: "merge", hint: "", reviewOrder: null, ...o });
export const sec = (prs: Pr[], folder = "/w"): Section => ({ folder, file: { version: 1, generatedAt: "2026-10-29T09:00:00Z", prs } });

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

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
