/**
 * Socratic AI — Goal Management
 * 
 * Stores the user's project goal per-workspace in a .socratic/goal.json file.
 * The goal is the north star that every code change is evaluated against.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ProjectGoal {
    goal: string;
    setAt: string;
    context?: string;  // Optional extra context like tech stack, constraints
}

function getGoalPath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    const socraticDir = path.join(workspaceFolders[0].uri.fsPath, '.socratic');
    return path.join(socraticDir, 'goal.json');
}

export function getGoal(): ProjectGoal | undefined {
    const goalPath = getGoalPath();
    if (!goalPath || !fs.existsSync(goalPath)) {
        return undefined;
    }
    try {
        const raw = fs.readFileSync(goalPath, 'utf-8');
        return JSON.parse(raw) as ProjectGoal;
    } catch {
        return undefined;
    }
}

export function saveGoal(goal: ProjectGoal): void {
    const goalPath = getGoalPath();
    if (!goalPath) {
        vscode.window.showErrorMessage('Socratic: No workspace folder open.');
        return;
    }
    const dir = path.dirname(goalPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(goalPath, JSON.stringify(goal, null, 2));
}

export async function promptSetGoal(): Promise<ProjectGoal | undefined> {
    const goal = await vscode.window.showInputBox({
        prompt: '🎯 What is your project goal?',
        placeHolder: 'e.g., Build a RAG evaluation pipeline using source documents and the RAG API',
        ignoreFocusOut: true,
    });

    if (!goal) {
        return undefined;
    }

    const context = await vscode.window.showInputBox({
        prompt: '📋 Any extra context? (tech stack, constraints, timeline — optional)',
        placeHolder: 'e.g., Python, 10 source PDFs, deadline in 2 weeks',
        ignoreFocusOut: true,
    });

    const projectGoal: ProjectGoal = {
        goal,
        setAt: new Date().toISOString(),
        context: context || undefined,
    };

    saveGoal(projectGoal);
    vscode.window.showInformationMessage(`🎯 Socratic: Goal set — "${goal}"`);
    return projectGoal;
}
