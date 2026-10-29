import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { StatusStore } from './discovery';
import { LocalChangesTracker } from './localChanges';
import { Pr, Section, Tone, countNeedsYou, pickNext, pillFor, prKey } from './model';
import { RefreshState, Refresher } from './refresh';

export interface ViewSection {
	folder: string;
	label?: string;
	error?: string;
	generatedAt?: string;
	prs: Array<Pr & { pill: { label: string; tone: Tone }; local?: string }>;
}

export interface StateMessage {
	type: "state";
	sections: ViewSection[];
	next?: { key: string; folder: string };
	refresh: RefreshState;
}

export function buildState(sections: Section[], local: ReadonlyMap<string, string>, refresh: RefreshState): StateMessage {
	const picked = pickNext(sections, new Set(local.keys()));
	return {
		type: "state",
		sections: sections.map(s => ({
			folder: s.folder,
			label: sections.length > 1 ? path.basename(s.folder) : undefined,
			error: s.error,
			generatedAt: s.file?.generatedAt,
			prs: (s.file?.prs ?? []).map(pr => ({ ...pr, pill: pillFor(pr), local: local.get(prKey(pr)) })),
		})),
		next: picked && { key: prKey(picked.pr), folder: sections[picked.sectionIndex].folder },
		refresh,
	};
}

export class PrStatusViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private readonly statusBar = vscode.window.createStatusBarItem("prStatus.needsYou", vscode.StatusBarAlignment.Left);
	private readonly disposables: vscode.Disposable[];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: StatusStore,
		private readonly refresher: Refresher,
		private readonly local: LocalChangesTracker,
	) {
		this.statusBar.name = "PR Status";
		this.statusBar.tooltip = "Show PR Status";
		this.statusBar.command = "prStatus.view.focus";
		this.disposables = [
			this.statusBar,
			vscode.window.registerWebviewViewProvider("prStatus.view", this, { webviewOptions: { retainContextWhenHidden: true } }),
			store.onDidChange(() => this.update()),
			local.onDidChange(() => this.update()),
			refresher.onDidChangeState(() => this.update()),
		];
		this.update();
	}

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, "media");
		const codicons = vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist");
		view.webview.options = { enableScripts: true, localResourceRoots: [media, codicons] };
		const asset = (base: vscode.Uri, file: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(base, file)).toString();
		const nonce = crypto.randomBytes(16).toString("hex");
		const src = view.webview.cspSource;
		view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${src}; font-src ${src}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset(codicons, "codicon.css")}">
<link rel="stylesheet" href="${asset(media, "view.css")}">
</head>
<body>
<main id="root"></main>
<footer id="footer"></footer>
<script nonce="${nonce}" src="${asset(media, "view.js")}"></script>
</body>
</html>`;
		const listener = view.webview.onDidReceiveMessage(m => this.onMessage(m));
		view.onDidDispose(() => {
			listener.dispose();
			this.view = undefined;
		});
		this.update();
	}

	private onMessage(m: { type?: string; url?: unknown }) {
		switch (m?.type) {
			case "ready":
				this.update();
				break;
			case "open":
				if (typeof m.url === "string" && /^https?:\/\//i.test(m.url)) {
					void vscode.env.openExternal(vscode.Uri.parse(m.url));
				}
				break;
			case "refresh":
				void vscode.commands.executeCommand("prStatus.refresh");
				break;
			case "installSkill":
				void vscode.commands.executeCommand("prStatus.installSkill");
				break;
			case "openSettings":
				void vscode.commands.executeCommand("workbench.action.openSettings", "prStatus");
				break;
		}
	}

	private update() {
		const sections = this.store.sections;
		const n = countNeedsYou(sections);
		this.statusBar.text = `$(git-pull-request) ${n} need you`;
		if (n) {
			this.statusBar.show();
		} else {
			this.statusBar.hide();
		}
		if (!this.view) {
			return;
		}
		this.view.badge = n ? { value: n, tooltip: n === 1 ? "1 PR needs you" : `${n} PRs need you` } : undefined;
		void this.view.webview.postMessage(buildState(sections, this.local.current, this.refresher.current));
	}

	dispose() {
		this.disposables.forEach(d => d.dispose());
	}
}
