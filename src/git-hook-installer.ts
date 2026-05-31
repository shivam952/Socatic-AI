/**
 * Socratic AI — Git Hook Installer (Track 1.3)
 *
 * Writes a pre-commit shell script to .git/hooks/pre-commit.
 * - If the file doesn't exist: writes fresh with shebang + Socratic block.
 * - If it exists but has no Socratic block: APPENDS (never overwrites existing hooks).
 * - If it already has the Socratic block: shows "already installed" and returns.
 *
 * The hook itself ALWAYS exits 0 — Socratic never blocks a commit.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const HOOK_START_MARKER = '# SOCRATIC_HOOK_START';
const HOOK_END_MARKER = '# SOCRATIC_HOOK_END';

function getHookBlock(): string {
    return `
${HOOK_START_MARKER}
# Socratic AI pre-commit hook — do not edit this block manually.
# To uninstall: delete everything between SOCRATIC_HOOK_START and SOCRATIC_HOOK_END.
if [ -f .git/socratic-hook-port ]; then
  SOCRATIC_PORT=$(cat .git/socratic-hook-port)
else
  exit 0
fi
curl -sf --max-time 1 "http://127.0.0.1:\${SOCRATIC_PORT}/health" > /dev/null 2>&1 || exit 0
STAT_B64=$(git diff --cached --stat 2>/dev/null | base64 | tr -d '\\n')
DIFF_B64=$(git diff --cached 2>/dev/null | head -c 6000 | base64 | tr -d '\\n')
curl -sf --max-time 2 \\
  -X POST "http://127.0.0.1:\${SOCRATIC_PORT}/commit" \\
  -H "Content-Type: application/json" \\
  -d "{\\"stat_b64\\":\\"$\{STAT_B64}\\",\\"diff_b64\\":\\"$\{DIFF_B64}\\"}" \\
  > /dev/null 2>&1 || true
exit 0
${HOOK_END_MARKER}`;
}

export async function installGitHook(workspaceRoot: string): Promise<void> {
    const gitDir = path.join(workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
        vscode.window.showWarningMessage(
            'Socratic: No .git directory found. Initialize a git repo first.'
        );
        return;
    }

    // In git worktrees, .git is a FILE (not a directory) containing a gitdir
    // pointer like "gitdir: ../../.git/worktrees/branch". Attempting to create
    // .git/hooks/ when .git is a file would fail or corrupt the worktree state.
    const gitStat = fs.statSync(gitDir);
    if (!gitStat.isDirectory()) {
        vscode.window.showWarningMessage(
            'Socratic: This appears to be a git worktree (the .git entry is a file, not a directory). ' +
            'Please install the hook in the main repository instead.'
        );
        return;
    }

    const hooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
    }

    const hookPath = path.join(hooksDir, 'pre-commit');

    try {
        if (fs.existsSync(hookPath)) {
            const existing = fs.readFileSync(hookPath, 'utf-8');

            if (existing.includes(HOOK_START_MARKER)) {
                vscode.window.showInformationMessage(
                    'Socratic: Git hook already installed. ✅'
                );
                return;
            }

            // Append to existing hook — never overwrite
            fs.appendFileSync(hookPath, '\n' + getHookBlock() + '\n', 'utf-8');
        } else {
            // Fresh install
            fs.writeFileSync(hookPath, '#!/bin/sh\n' + getHookBlock() + '\n', 'utf-8');
        }

        // Make executable (no-op on Windows but harmless)
        fs.chmodSync(hookPath, 0o755);

        vscode.window.showInformationMessage(
            '✅ Socratic: Git hook installed. Socratic will now analyze your commits.'
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(
            `Socratic: Failed to install git hook — ${err.message}`
        );
    }
}
