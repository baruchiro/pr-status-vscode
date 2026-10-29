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

function execScript(shell: string, script: string, specs: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stderr: string }> {
	return new Promise(resolve => {
		childProcess.execFile(shell, ["-lc", '"$0" "$@"', script, ...specs], { cwd, env }, (err, _stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
			resolve({ code, stderr: err && typeof err.code !== "number" ? `${err.message}\n${stderr}` : stderr });
		});
	});
}

export async function runRefresh(folder: string, script: string, specs: string[], shell = process.env.SHELL ?? "/bin/bash"): Promise<RefreshResult> {
	const jsonTarget = path.join(folder, "pr-status.json");
	const mdTarget = path.join(folder, "pr-status.md");
	const before = await generatedAt(jsonTarget);
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pr-status-"));
	try {
		const mdTmp = path.join(tmp, "pr-status.md");
		const jsonTmp = path.join(tmp, "pr-status.json");
		const { code, stderr } = await execScript(shell, script, specs, folder, {
			...process.env,
			PR_STATUS_FILE: mdTmp,
			PR_STATUS_JSON_FILE: jsonTmp,
			PR_REVIEW_LINKS_FILE: path.join(folder, "pr-review-links.json"),
		});
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
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

async function readInstalledPlugins(): Promise<string | undefined> {
	try {
		return await fs.readFile(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8");
	} catch {
		return undefined;
	}
}

export class Refresher implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<RefreshState>();
	readonly onDidChangeState = this.emitter.event;
	private state: RefreshState = { scriptMissing: false };
	private timer: NodeJS.Timeout | undefined;
	private readonly running = new Set<string>();
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
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule()),
			vscode.window.onDidChangeWindowState(w => {
				const interval = this.intervalMs();
				if (w.focused && vscode.workspace.isTrusted && interval && this.state.lastRun && Date.now() - this.state.lastRun.getTime() > interval) {
					void this.refreshNow();
				}
			}),
		);
		this.schedule();
	}

	private config() {
		return vscode.workspace.getConfiguration("prStatus");
	}

	private intervalMs(): number {
		return Math.max(0, this.config().get<number>("refreshIntervalSeconds", 300)) * 1000;
	}

	private set(patch: Partial<RefreshState>) {
		this.state = { ...this.state, ...patch };
		this.emitter.fire(this.state);
	}

	private schedule() {
		clearInterval(this.timer);
		this.timer = undefined;
		const interval = this.intervalMs();
		if (!interval) {
			this.set({ nextRun: undefined });
			return;
		}
		this.timer = setInterval(() => {
			if (vscode.window.state.focused && vscode.workspace.isTrusted) {
				void this.refreshNow();
			}
		}, interval);
		this.set({ nextRun: new Date(Date.now() + interval) });
	}

	async refreshNow(interactive = false): Promise<void> {
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
		const sections = this.store.sections.filter(s => s.file && !this.running.has(s.folder));
		const errors: string[] = [];
		await Promise.all(sections.map(async s => {
			this.running.add(s.folder);
			try {
				const result = await runRefresh(s.folder, script, prSpecs(s.file!));
				if (!result.ok && !result.discarded) {
					errors.push(result.error);
				}
			} finally {
				this.running.delete(s.folder);
			}
		}));
		const interval = this.intervalMs();
		this.set({
			scriptMissing: false,
			lastRun: new Date(),
			nextRun: interval ? new Date(Date.now() + interval) : undefined,
			error: errors[0],
		});
		if (interactive && errors[0]) {
			void vscode.window.showErrorMessage(`PR Status: ${errors[0]}`);
		}
	}

	dispose() {
		clearInterval(this.timer);
		this.disposables.forEach(d => d.dispose());
	}
}
