export interface Pr {
	repo: string;
	number: number;
	title: string;
	url: string;
	base: string;
	phase: string;
	status: string;
	next: string;
	hint: string;
	reviewOrder: string | null;
	state?: "OPEN" | "MERGED" | "CLOSED";
	headRefName?: string;
	headRefOid?: string;
	threads?: number;
	ci?: "pending" | "failing" | "ok" | "none";
}

export interface StatusFile {
	version: 1;
	generatedAt: string;
	prs: Pr[];
}

export interface Section {
	folder: string;
	file?: StatusFile;
	error?: string;
}

export type Tone = "orange" | "purple" | "red" | "yellow" | "green" | "neutral";

const PILLS: Record<string, { label: string; tone: Tone }> = {
	"needs-you": { label: "Needs you", tone: "orange" },
	"needs-agent": { label: "Claude's turn", tone: "purple" },
	"ci-failing": { label: "CI failing", tone: "red" },
	"cr-pending": { label: "CodeRabbit running", tone: "yellow" },
	"ci-pending": { label: "Waiting", tone: "neutral" },
	"cr-not-triggered": { label: "Check CodeRabbit", tone: "yellow" },
	"cr-no-activity": { label: "Check CodeRabbit", tone: "yellow" },
	"ready": { label: "Ready to merge", tone: "green" },
	"clean": { label: "Draft · review it", tone: "neutral" },
	"merged": { label: "Merged", tone: "neutral" },
	"closed": { label: "Closed", tone: "neutral" },
};

const REQUIRED_STRINGS = ["repo", "title", "url", "status", "next"];

export function parseStatusFile(text: string): StatusFile {
	let data: any;
	try {
		data = JSON.parse(text);
	} catch (e) {
		throw new Error(`Invalid JSON: ${(e as Error).message}`);
	}
	if (!data || data.version !== 1) {
		throw new Error(`Unsupported pr-status.json version: ${data?.version}`);
	}
	if (!Array.isArray(data.prs)) {
		throw new Error("pr-status.json has no prs array");
	}
	const bad = data.prs.findIndex((p: any) => !(p && typeof p === "object" && Number.isInteger(p.number) && REQUIRED_STRINGS.every(k => typeof p[k] === "string")));
	if (bad >= 0) {
		throw new Error(`pr-status.json prs[${bad}] needs string repo, title, url, status and next, and an integer number`);
	}
	return data as StatusFile;
}

export function prKey(pr: Pr): string {
	return `${pr.repo}#${pr.number}`;
}

export function pillFor(pr: Pr): { label: string; tone: Tone } {
	const status = pr.status.slice(pr.status.indexOf(":") + 1);
	const pill = PILLS[status];
	if (!pill) {
		return { label: pr.status, tone: "neutral" };
	}
	if (status === "needs-you" && pr.threads) {
		return { label: `${pill.label} · ${pr.threads}`, tone: pill.tone };
	}
	return pill;
}

export function ciPillFor(pr: Pr): { label: string; tone: Tone } | undefined {
	return pr.ci === "pending" || pr.status.endsWith(":ci-pending") ? { label: "CI running", tone: "yellow" } : undefined;
}

export function pickNext(sections: Section[], localChanges: ReadonlySet<string>): { sectionIndex: number; pr: Pr } | undefined {
	for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
		const pr = sections[sectionIndex].file?.prs.find(p => p.next === "you" && !localChanges.has(prKey(p)));
		if (pr) {
			return { sectionIndex, pr };
		}
	}
	return undefined;
}

export function countNeedsYou(sections: Section[], localChanges: ReadonlySet<string>): number {
	const keys = new Set<string>();
	for (const s of sections) {
		for (const p of s.file?.prs ?? []) {
			if (p.next === "you" && !localChanges.has(prKey(p))) {
				keys.add(prKey(p));
			}
		}
	}
	return keys.size;
}
