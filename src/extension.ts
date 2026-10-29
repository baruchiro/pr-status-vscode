import * as vscode from 'vscode';
import { StatusStore } from './discovery';
import { LocalChangesTracker } from './localChanges';
import { installSkill } from './installSkill';
import { Refresher } from './refresh';
import { PrStatusViewProvider } from './view';

export function activate(context: vscode.ExtensionContext) {
	const store = new StatusStore();
	const refresher = new Refresher(store);
	const local = new LocalChangesTracker(store);
	context.subscriptions.push(store, refresher, local, new PrStatusViewProvider(context.extensionUri, store, refresher, local));
	context.subscriptions.push(vscode.commands.registerCommand('prStatus.installSkill', installSkill));
}

export function deactivate() {}
