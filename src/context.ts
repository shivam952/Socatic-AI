/**
 * Socratic AI — Context Builder
 * 
 * Builds the context payload sent to the LLM for analysis.
 * Includes: project goal, file tree, changed file content, recent warnings.
 * 
 * 🏗️ ARCHITECTURE NOTE: Context is Everything
 * The quality of Socratic's questions depends entirely on context quality.
 * Bad context → generic questions (useless). 
 * Rich context → specific, actionable questions (the whole point).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectGoal } from './goal';

export interface AnalysisContext {
    goal: ProjectGoal;
    changedFile: {
        path: string;
        relativePath: string;
        content: string;
        language: string;
    };
    projectStructure: string;
    recentWarnings: string[];
}

/**
 * Build a compact file tree of the workspace, excluding noise.
 */
export function getProjectStructure(maxDepth: number = 3): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return '(no workspace)'; }

    const root = workspaceFolders[0].uri.fsPath;
    const lines: string[] = [];

    const IGNORE = new Set([
        'node_modules', '.git', '__pycache__', '.vscode', '.socratic',
        'out', 'dist', 'build', '.next', '.venv', 'venv', 'env',
        '.pytest_cache', '.mypy_cache', 'coverage', '.tox',
        '.idea', '.DS_Store', 'egg-info',
    ]);

    function walk(dir: string, depth: number, prefix: string): void {
        if (depth > maxDepth) { return; }
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const filtered = entries
                .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
                .sort((a, b) => {
                    // Directories first
                    if (a.isDirectory() && !b.isDirectory()) { return -1; }
                    if (!a.isDirectory() && b.isDirectory()) { return 1; }
                    return a.name.localeCompare(b.name);
                });

            for (const entry of filtered) {
                const isDir = entry.isDirectory();
                lines.push(`${prefix}${isDir ? '📁 ' : '  '}${entry.name}`);
                if (isDir) {
                    walk(path.join(dir, entry.name), depth + 1, prefix + '  ');
                }
            }
        } catch {
            // Permission error, skip
        }
    }

    walk(root, 0, '');
    return lines.join('\n');
}

/**
 * Read the content of key project files (configs, READMEs) for extra context.
 */
export function getKeyProjectFiles(rootPath: string): string {
    const keyFiles = [
        'README.md', 'requirements.txt', 'package.json',
        'docker-compose.yml', 'Dockerfile', '.env.example',
        'config.yaml', 'config.json', 'pyproject.toml',
    ];

    const found: string[] = [];
    for (const file of keyFiles) {
        const filePath = path.join(rootPath, file);
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                // Only include short config files (< 2KB)
                if (content.length < 2048) {
                    found.push(`--- ${file} ---\n${content}`);
                } else {
                    found.push(`--- ${file} --- (${(content.length / 1024).toFixed(0)}KB, truncated)\n${content.slice(0, 1024)}...`);
                }
            } catch { /* skip */ }
        }
    }

    return found.join('\n\n');
}

/**
 * Build the full analysis context for a saved file.
 */
export function buildContext(
    document: vscode.TextDocument,
    goal: ProjectGoal,
    recentWarnings: string[] = []
): AnalysisContext {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders?.[0]?.uri.fsPath || '';
    const relativePath = path.relative(rootPath, document.uri.fsPath);

    return {
        goal,
        changedFile: {
            path: document.uri.fsPath,
            relativePath,
            content: document.getText(),
            language: document.languageId,
        },
        projectStructure: getProjectStructure(),
        recentWarnings,
    };
}
