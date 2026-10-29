import * as vscode from 'vscode';
import { StatusStore } from './discovery';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(new StatusStore());
}

export function deactivate() {}
