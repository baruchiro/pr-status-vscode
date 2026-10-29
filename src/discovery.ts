import * as path from 'path';
import * as vscode from 'vscode';
import { Section, parseStatusFile } from './model';

const FILE_NAME = "pr-status.json";

export function candidateFolders(workspaceFolders: string[], workspaceFile: string | undefined): string[] {
	const first = workspaceFile?.endsWith(".code-workspace") ? [path.dirname(workspaceFile)] : [];
	return [...new Set([...first, ...workspaceFolders])];
}

export function loadSection(folder: string, prev: Section | undefined, text: string): Section {
	try {
		return { folder, file: parseStatusFile(text) };
	} catch (e) {
		return { folder, file: prev?.file, error: (e as Error).message };
	}
}

export class StatusStore implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<Section[]>();
	readonly onDidChange = this.emitter.event;
	private current = new Map<string, Section>();
	private watchers: vscode.Disposable[] = [];
	private readonly foldersListener: vscode.Disposable;
	private folders: string[] = [];
	private generation = 0;

	constructor() {
		this.foldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.watchAll());
		this.watchAll();
	}

	get sections(): Section[] {
		return this.folders.flatMap(f => this.current.get(f) ?? []);
	}

	private watchAll() {
		this.watchers.forEach(w => w.dispose());
		this.watchers = [];
		const generation = ++this.generation;
		const workspaceFile = vscode.workspace.workspaceFile;
		const folders = candidateFolders(
			(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
			workspaceFile?.scheme === "file" ? workspaceFile.fsPath : undefined,
		);
		this.folders = folders;
		this.current = new Map([...this.current].filter(([folder]) => folders.includes(folder)));
		for (const folder of folders) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), FILE_NAME));
			const reload = () => this.reload(folder, generation);
			watcher.onDidCreate(reload);
			watcher.onDidChange(reload);
			watcher.onDidDelete(() => this.set(folder, undefined, generation));
			this.watchers.push(watcher);
			reload();
		}
		this.publish();
	}

	private async reload(folder: string, generation: number) {
		let text: string;
		try {
			text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(folder, FILE_NAME)))).toString("utf8");
		} catch {
			this.set(folder, undefined, generation);
			return;
		}
		this.set(folder, loadSection(folder, this.current.get(folder), text), generation);
	}

	private set(folder: string, section: Section | undefined, generation: number) {
		if (generation !== this.generation) {
			return;
		}
		if (section) {
			this.current.set(folder, section);
		} else if (!this.current.delete(folder)) {
			return;
		}
		this.publish();
	}

	private publish() {
		void vscode.commands.executeCommand("setContext", "prStatus.hasFile", this.current.size > 0);
		this.emitter.fire(this.sections);
	}

	dispose() {
		this.watchers.forEach(w => w.dispose());
		this.foldersListener.dispose();
		this.emitter.dispose();
	}
}
