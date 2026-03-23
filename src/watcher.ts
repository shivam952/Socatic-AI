/**
 * Socratic AI — File Watcher
 * 
 * 🏗️ ARCHITECTURE NOTE: Proactivity Engine
 * 
 * This is what makes Socratic AI different from ChatGPT.
 * Instead of waiting for the user to ask, we WATCH their work
 * and proactively intervene when something looks off.
 * 
 * The watcher triggers on file save (not on every keystroke — that
 * would be insanely annoying and expensive). It debounces to avoid
 * spamming the LLM on rapid saves.
 */
import * as vscode from 'vscode';
import { getGoal } from './goal';
import { buildContext } from './context';
import { analyzeCode, SocraticResponse } from './llm';
import { showAnalysisResult, setAnalyzing } from './notifications';

let debounceTimer: NodeJS.Timeout | undefined;
let recentWarnings: string[] = [];
const MAX_RECENT_WARNINGS = 5;

// File extensions worth analyzing
const SUPPORTED_LANGUAGES = new Set([
    'python', 'javascript', 'typescript', 'typescriptreact', 'javascriptreact',
    'go', 'rust', 'java', 'c', 'cpp', 'csharp',
    'ruby', 'php', 'swift', 'kotlin',
    'yaml', 'json', 'toml', 'dockerfile',
    'markdown', 'sql',
]);

/**
 * Register the file save watcher.
 */
export function registerWatcher(context: vscode.ExtensionContext): vscode.Disposable {
    const watcher = vscode.workspace.onDidSaveTextDocument((document) => {
        const config = vscode.workspace.getConfiguration('socratic');
        const enabled = config.get<boolean>('enabled', true);

        if (!enabled) { return; }

        // Skip unsupported file types
        if (!SUPPORTED_LANGUAGES.has(document.languageId)) { return; }

        // Skip very large files (> 50KB — too expensive for LLM)
        if (document.getText().length > 50000) { return; }

        // Skip files in .socratic directory
        if (document.uri.fsPath.includes('.socratic')) { return; }

        // Debounce
        const debounceSeconds = config.get<number>('debounceSeconds', 45);
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(async () => {
            await triggerAnalysis(document);
        }, debounceSeconds * 1000);
    });

    context.subscriptions.push(watcher);
    return watcher;
}

/**
 * Trigger analysis for a specific document (called by watcher or manually).
 */
export async function triggerAnalysis(document: vscode.TextDocument): Promise<SocraticResponse | undefined> {
    const goal = getGoal();
    if (!goal) {
        // No goal set — silently skip. Don't nag.
        return undefined;
    }

    const ctx = buildContext(document, goal, recentWarnings);

    setAnalyzing(true);

    try {
        const result = await analyzeCode(ctx);

        // Track recent warnings to avoid repeating
        if (result.severity !== 'lgtm') {
            recentWarnings.push(result.message);
            if (recentWarnings.length > MAX_RECENT_WARNINGS) {
                recentWarnings = recentWarnings.slice(-MAX_RECENT_WARNINGS);
            }
        }

        await showAnalysisResult(result, ctx.changedFile.relativePath);
        return result;
    } catch (err: any) {
        console.error('Socratic analysis error:', err);
        return undefined;
    } finally {
        setAnalyzing(false);
    }
}
