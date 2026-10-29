import * as vscode from 'vscode';
import { StatusStore } from './discovery';
import { Refresher } from './refresh';

export function activate(context: vscode.ExtensionContext) {
	const store = new StatusStore();
	context.subscriptions.push(store, new Refresher(store));
}

export function deactivate() {}
