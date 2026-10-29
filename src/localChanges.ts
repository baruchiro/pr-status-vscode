import * as vscode from 'vscode';
import { StatusStore } from './discovery';
import { Pr, prKey } from './model';
import { API, GitExtension, Repository } from './typings/git';

export interface RepoInfo {
	remotes: string[];
	head?: string;
	dirty: number;
	branches: { name: string; ahead?: number }[];
}

export function parseRemote(url: string): string | undefined {
	const m = /^(?:[\w+]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

export function localChangesFor(prs: Pr[], repos: RepoInfo[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const pr of prs) {
		const branch = pr.headRefName;
		if (!branch) {
			continue;
		}
		const slug = pr.repo.toLowerCase();
		for (const repo of repos.filter(r => r.remotes.some(u => parseRemote(u) === slug))) {
			const ahead = repo.branches.find(b => b.name === branch)?.ahead ?? 0;
			if (repo.head === branch && repo.dirty > 0) {
				result.set(prKey(pr), `${repo.dirty} uncommitted files on ${branch}`);
				break;
			}
			if (ahead > 0) {
				result.set(prKey(pr), `${ahead} unpushed commits on ${branch}`);
				break;
			}
		}
	}
	return result;
}

const DEBOUNCE_MS = 300;

export class LocalChangesTracker implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private map = new Map<string, string>();
	private subscriptions: vscode.Disposable[] = [];
	private repoListeners = new Map<Repository, vscode.Disposable>();
	private timer: NodeJS.Timeout | undefined;
	private generation = 0;
	private disposed = false;

	constructor(private readonly store: StatusStore) {
		this.subscriptions.push(store.onDidChange(() => this.schedule()));
		this.connect().catch(() => undefined);
	}

	get current(): Map<string, string> {
		return this.map;
	}

	private async connect() {
		const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
		if (!ext) {
			return;
		}
		const exports = ext.isActive ? ext.exports : await ext.activate();
		if (this.disposed || !exports.enabled) {
			return;
		}
		const api = exports.getAPI(1);
		this.subscriptions.push(
			api.onDidOpenRepository(r => this.watch(r)),
			api.onDidCloseRepository(r => this.unwatch(r)),
		);
		api.repositories.forEach(r => this.watch(r));
		this.api = api;
		this.schedule();
	}

	private api: API | undefined;

	private watch(repo: Repository) {
		this.repoListeners.get(repo)?.dispose();
		this.repoListeners.set(repo, repo.state.onDidChange(() => this.schedule()));
		this.schedule();
	}

	private unwatch(repo: Repository) {
		this.repoListeners.get(repo)?.dispose();
		this.repoListeners.delete(repo);
		this.schedule();
	}

	private schedule() {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.recompute().catch(() => undefined), DEBOUNCE_MS);
	}

	private async recompute() {
		const api = this.api;
		if (!api) {
			return;
		}
		const generation = ++this.generation;
		const prs = this.store.sections.flatMap(s => s.file?.prs ?? []);
		const branchNames = [...new Set(prs.flatMap(p => p.headRefName ?? []))];
		const repos = await Promise.all(api.repositories.map(r => toRepoInfo(r, branchNames)));
		if (this.disposed || generation !== this.generation) {
			return;
		}
		const next = localChangesFor(prs, repos);
		if (!sameMap(next, this.map)) {
			this.map = next;
			this.emitter.fire();
		}
	}

	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.subscriptions.forEach(s => s.dispose());
		this.repoListeners.forEach(l => l.dispose());
		this.emitter.dispose();
	}
}

async function toRepoInfo(repo: Repository, branchNames: string[]): Promise<RepoInfo> {
	const branches = await Promise.all(branchNames.map(async name => {
		try {
			return { name, ahead: (await repo.getBranch(name)).ahead };
		} catch {
			return { name };
		}
	}));
	return {
		remotes: repo.state.remotes.flatMap(r => [r.fetchUrl, r.pushUrl].filter((u): u is string => !!u)),
		head: repo.state.HEAD?.name,
		dirty: repo.state.workingTreeChanges.length + repo.state.indexChanges.length,
		branches,
	};
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
	return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}
