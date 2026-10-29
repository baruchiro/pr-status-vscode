import * as vscode from 'vscode';
import { StatusStore } from './discovery';
import { LocalChangesTracker } from './localChanges';
import { Refresher } from './refresh';

export function activate(context: vscode.ExtensionContext) {
	const store = new StatusStore();
	context.subscriptions.push(store, new Refresher(store), new LocalChangesTracker(store));
}

export function deactivate() {}
