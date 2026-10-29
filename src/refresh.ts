import * as childProcess from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StatusStore } from './discovery';
import { StatusFile } from './model';

const SCRIPT_TAIL = "/skills/resolving-pr-review-comments/pr-status.sh";

export interface RefreshState {
	lastRun?: Date;
	nextRun?: Date;
	error?: string;
	scriptMissing: boolean;
	untrusted?: boolean;
}

export type RefreshResult = { ok: true } | { ok: false; error: string; discarded?: boolean };

export function findScript(setting: string, installedPluginsJson: string | undefined): string | undefined {
	if (path.isAbsolute(setting)) {
		return setting;
	}
	if (!installedPluginsJson) {
		return undefined;
	}
	let plugins: Record<string, { installPath?: string }[]>;
	try {
		plugins = JSON.parse(installedPluginsJson).plugins ?? {};
	} catch {
		return undefined;
	}
	for (const prefix of ["pr-review-loop@", "baruchiro@"]) {
		const key = Object.keys(plugins).find(k => k.startsWith(prefix));
		const installPath = key && plugins[key]?.[0]?.installPath;
		if (installPath) {
			return installPath + SCRIPT_TAIL;
		}
	}
	return undefined;
}

const SAFE_REPO = /^(?!-)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function prSpecs(file: StatusFile): string[] {
	return file.prs
		.filter(p => typeof p.repo === "string" && SAFE_REPO.test(p.repo) && Number.isInteger(p.number) && p.number > 0)
		.map(p => `${p.repo}#${p.number}`);
}

async function generatedAt(file: string): Promise<string | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8")).generatedAt;
	} catch {
		return undefined;
	}
}

function execScript(shell: string, script: string, specs: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string; timedOut: boolean }> {
	return new Promise(resolve => {
		childProcess.execFile(shell, ["-lc", '"$0" "$@"', script, ...specs], { cwd, env, timeout: 120_000 }, (err, _stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
			resolve({ code, stderr: err && typeof err.code !== "number" ? `${err.message}\n${stderr}` : stderr, timedOut: !!err?.killed });
		});
	});
}

export async function runRefresh(folder: string, script: string, specs: string[], shell = process.env.SHELL ?? "/bin/bash"): Promise<RefreshResult> {
	const jsonTarget = path.join(folder, "pr-status.json");
	const mdTarget = path.join(folder, "pr-status.md");
	let tmp: string | undefined;
	try {
		const before = await generatedAt(jsonTarget);
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pr-status-"));
		const mdTmp = path.join(tmp, "pr-status.md");
		const jsonTmp = path.join(tmp, "pr-status.json");
		const { code, stderr, timedOut } = await execScript(shell, script, specs, folder, {
			...process.env,
			PR_STATUS_FILE: mdTmp,
			PR_STATUS_JSON_FILE: jsonTmp,
			PR_REVIEW_LINKS_FILE: path.join(folder, "pr-review-links.json"),
		});
		if (timedOut) {
			return { ok: false, error: "pr-status.sh timed out after 2 minutes" };
		}
		if (code !== 0) {
			const line = stderr.split("\n").map(l => l.trim()).find(l => l);
			return { ok: false, error: line ?? `Script exited with code ${code}` };
		}
		if (!await fs.stat(jsonTmp).then(() => true, () => false)) {
			return { ok: false, error: "the installed skill is too old to write pr-status.json; update it with: claude plugin install pr-review-loop@skills" };
		}
		if (await generatedAt(jsonTarget) !== before) {
			return { ok: false, error: "file changed during refresh", discarded: true };
		}
		for (const [from, to] of [[mdTmp, mdTarget], [jsonTmp, jsonTarget]]) {
			await fs.rm(`${to}.tmp`, { force: true });
			await fs.copyFile(from, `${to}.tmp`, fs.constants.COPYFILE_EXCL);
			await fs.rename(`${to}.tmp`, to);
		}
		return { ok: true };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	} finally {
		if (tmp) {
			await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

async function readInstalledPlugins(): Promise<string | undefined> {
	try {
		return await fs.readFile(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8");
	} catch {
		return undefined;
	}
}

// setTimeout fires at once for delays past 2^31-1 ms.
const MAX_INTERVAL_SECONDS = 2147483;

export class Refresher implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<RefreshState>();
	readonly onDidChangeState = this.emitter.event;
	private state: RefreshState = { scriptMissing: false };
	private timer: NodeJS.Timeout | undefined;
	private busy = false;
	private due = false;
	private rerun = false;
	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly store: StatusStore) {
		this.disposables.push(
			this.emitter,
			vscode.commands.registerCommand("prStatus.refresh", () => this.refreshNow(true)),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration("prStatus")) {
					this.schedule();
				}
			}),
			vscode.workspace.onDidGrantWorkspaceTrust(() => {
				this.schedule();
				this.refreshIfOwed();
			}),
			vscode.window.onDidChangeWindowState(w => {
				if (w.focused) {
					this.refreshIfOwed();
				}
			}),
			// The activation run waits for the store's first load, which is async.
			store.onDidChange(() => {
				if (!this.state.lastRun) {
					this.refreshIfOwed();
				}
			}),
		);
		this.schedule();
	}

	get current(): RefreshState {
		return this.state;
	}

	private config() {
		return vscode.workspace.getConfiguration("prStatus");
	}

	private intervalMs(): number {
		return Math.min(MAX_INTERVAL_SECONDS, Math.max(0, this.config().get<number>("refreshIntervalSeconds", 300))) * 1000;
	}

	private set(patch: Partial<RefreshState>) {
		this.state = { ...this.state, ...patch };
		this.emitter.fire(this.state);
	}

	private schedule() {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed) {
			return;
		}
		const interval = this.intervalMs();
		const untrusted = !vscode.workspace.isTrusted;
		if (interval && !untrusted) {
			this.timer = setTimeout(() => this.onTimer(), interval);
		}
		this.set({ untrusted, nextRun: this.timer ? new Date(Date.now() + interval) : undefined });
	}

	private onTimer() {
		this.due = true;
		if (vscode.window.state.focused) {
			void this.refreshNow();
		} else {
			this.schedule();
		}
	}

	private refreshIfOwed() {
		const interval = this.intervalMs();
		const last = this.state.lastRun?.getTime();
		if (interval && vscode.workspace.isTrusted && vscode.window.state.focused && (last === undefined || this.due || Date.now() - last >= interval)) {
			void this.refreshNow();
		}
	}

	async refreshNow(interactive = false): Promise<void> {
		if (this.busy) {
			this.rerun ||= interactive;
			return;
		}
		this.busy = true;
		clearTimeout(this.timer);
		this.set({ nextRun: undefined });
		try {
			await this.run(interactive);
		} finally {
			this.busy = false;
			this.due = false;
			this.schedule();
		}
		if (this.rerun && !this.disposed) {
			this.rerun = false;
			await this.refreshNow(true);
		}
	}

	private async run(interactive: boolean): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			if (interactive) {
				void vscode.window.showWarningMessage("PR Status: trust this workspace to refresh");
			}
			return;
		}
		const script = findScript(this.config().inspect<string>("scriptPath")?.globalValue ?? "", await readInstalledPlugins());
		if (!script) {
			this.set({ scriptMissing: true });
			if (interactive) {
				void vscode.window.showWarningMessage("PR Status: refresh script not found. Install the pr-review-loop plugin or set prStatus.scriptPath.");
			}
			return;
		}
		const jobs = this.store.sections.flatMap(s => {
			const specs = s.file ? prSpecs(s.file) : [];
			return specs.length ? [{ folder: s.folder, specs }] : [];
		});
		const results = await Promise.all(jobs.map(j => runRefresh(j.folder, script, j.specs)));
		const error = results.flatMap(r => r.ok || r.discarded ? [] : [r.error])[0];
		this.set({ scriptMissing: false, lastRun: new Date(), error });
		if (interactive && error) {
			void vscode.window.showErrorMessage(`PR Status: ${error}`);
		}
	}

	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.disposables.forEach(d => d.dispose());
	}
}
