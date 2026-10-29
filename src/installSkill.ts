import * as childProcess from 'child_process';
import * as vscode from 'vscode';

const INSTALL_COMMAND = "claude plugin marketplace add baruchiro/skills && claude plugin install pr-review-loop@skills";
const SETUP_URL = "https://docs.claude.com/en/docs/claude-code/setup";

function hasClaude(shell: string): Promise<boolean> {
	return new Promise(resolve => {
		childProcess.execFile(shell, ["-lc", "command -v claude"], err => resolve(!err));
	});
}

export async function installSkill(): Promise<void> {
	if (await hasClaude(process.env.SHELL ?? "/bin/bash")) {
		const terminal = vscode.window.createTerminal({ name: "PR Status" });
		terminal.show();
		terminal.sendText(INSTALL_COMMAND);
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		`Claude Code CLI not found. Install it, then run: ${INSTALL_COMMAND}`,
		"Copy command",
		"Install Claude Code",
	);
	if (choice === "Copy command") {
		await vscode.env.clipboard.writeText(INSTALL_COMMAND);
	} else if (choice === "Install Claude Code") {
		await vscode.env.openExternal(vscode.Uri.parse(SETUP_URL));
	}
}
