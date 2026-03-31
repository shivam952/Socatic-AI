/**
 * Socratic AI — Trigger Classifier (V1)
 *
 * Decides whether a file save event represents a decision-like moment
 * worth running the two-stage pipeline for.
 *
 * 🏗️ ARCHITECTURE NOTE: The Proactivity Engine
 *
 * This is what separates Socratic AI from ChatGPT.
 * Instead of waiting for the user to ask, we WATCH their work
 * and classify saves into "decision events" vs. "noise."
 *
 * Design principles:
 *  - Most saves are noise. Silence is the default.
 *  - Keywords come from the expert rule pack, not hardcoded here.
 *    When a new rule pack is added in Phase 2, it brings its own keywords.
 *  - Debounce is ACCUMULATING: multiple events in 15s are merged into
 *    one pipeline run with unified evidence. "Last event wins" loses signal.
 *
 * Spec reference: V1_SPEC.md §3.1
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logError } from './notifications';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TriggerType =
    | 'new_dependency'
    | 'new_file'
    | 'new_service'
    | 'config_change'
    | 'new_infra'
    | 'new_test_for_new_module'
    | 'manual_checkpoint'
    | 'none';

export interface TriggerEvent {
    type: TriggerType;
    evidence: string[];       // ALL evidence accumulated in this debounce window
    diff_summary: string;     // Plain-English summary of what changed
    file_path: string;        // The file that triggered the event
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Config files that are "decision-like" when changed.
 * Changes here often mean a new dependency or infra decision.
 */
const CONFIG_FILES = new Set([
    'docker-compose.yml',
    'docker-compose.yaml',
    '.env',
    '.env.local',
    '.env.production',
    'pyproject.toml',
    'requirements.txt',
    'Dockerfile',
    'Makefile',
    'config.yaml',
    'config.yml',
    'config.json',
    'settings.py',
    'settings.yaml',
]);

/**
 * Directories that signal a new service/module being created.
 */
const SERVICE_DIRS = [
    'services/', 'service/', 'workers/', 'worker/',
    'agents/', 'agent/', 'queues/', 'queue/',
    'api/', 'infra/', 'k8s/', 'helm/', 'microservices/',
];

/**
 * File extensions worth analyzing. Everything else is structural noise.
 */
const ANALYZED_EXTENSIONS = new Set([
    '.py', '.ts', '.js', '.tsx', '.jsx',
    '.go', '.rs', '.java', '.rb', '.php',
    '.yaml', '.yml', '.json', '.toml',
    '.dockerfile', '.env',
]);

/**
 * File patterns that are always noise, regardless of extension.
 */
const ALWAYS_IGNORE_PATTERNS = [
    /\.css$/, /\.scss$/, /\.sass$/, /\.less$/,
    /\.svg$/, /\.png$/, /\.jpg$/, /\.gif$/, /\.ico$/,
    /\.md$/, /\.mdx$/, /\.txt$/, /\.rst$/,
    /\.lock$/, /package-lock\.json$/, /yarn\.lock$/,
    /\.map$/, /\.min\.(js|css)$/,
    /node_modules\//, /\.git\//,
    /out\//, /dist\//, /build\//,
    /\/__pycache__\//, /\.pytest_cache\//,
];

// ─── Workspace State Keys ─────────────────────────────────────────────────────

const STATE_KEY_KNOWN_DEPS = 'socratic.knownDependencies';
const STATE_KEY_KNOWN_SOURCE_FILES = 'socratic.knownSourceFiles';
const STATE_KEY_KNOWN_TEST_FILES = 'socratic.knownTestFiles';
const STATE_KEY_LAST_PACKAGE_JSON = 'socratic.lastPackageJsonHash';

// ─── Rule Pack Keyword Loader ─────────────────────────────────────────────────

interface RulePackKeywords {
    dependencies: string[];
    file_patterns: string[];
    infra_directories: string[];
}

let cachedKeywords: RulePackKeywords | null = null;

function getInfraKeywords(): RulePackKeywords {
    if (cachedKeywords) { return cachedKeywords; }
    try {
        // Import keywords directly from the expert rule pack.
        // This is the canonical source — trigger.ts never hardcodes keywords.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const rules = require('./expert-rules/premature-complexity.json');
        cachedKeywords = rules.trigger_keywords as RulePackKeywords;
        return cachedKeywords;
    } catch {
        logError('Could not load expert rule pack keywords. Using empty fallback.');
        cachedKeywords = { dependencies: [], file_patterns: [], infra_directories: [] };
        return cachedKeywords;
    }
}

// ─── Core Classification Logic ────────────────────────────────────────────────

/**
 * Returns true if the file should be ignored entirely — it's noise.
 */
function isNoise(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return ALWAYS_IGNORE_PATTERNS.some(pattern => pattern.test(normalized));
}

/**
 * Returns true if the file is a test file.
 */
function isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.(ts|js|tsx|jsx|py)$/.test(filePath) ||
           /_test\.(py|go)$/.test(filePath) ||
           /test_.*\.py$/.test(filePath);
}

/**
 * Returns true if this is a minor edit (< 20 lines, no new imports).
 */
function isMinorEdit(document: vscode.TextDocument): boolean {
    // Can't get diff directly in a VS Code extension without git API.
    // Heuristic: if the file is under 20 lines total OR already existed
    // in the known file set, treat saves of existing files as potentially minor.
    // The new_file check handles the "first creation" case.
    // For content: scan for import/require/from lines as a proxy for "new imports added."
    const content = document.getText();
    const importLines = (content.match(/^(import |from |require\(|import\()/gm) || []).length;
    // If the file has very few imports and is small, it's likely a minor edit.
    // This is intentionally permissive — we want to avoid false silences.
    return document.lineCount < 15 && importLines < 3;
}

/**
 * Detect if a new dependency was added to package.json or requirements.txt.
 * Compares current dep set against last known state in workspaceState.
 */
function detectNewDependency(
    document: vscode.TextDocument,
    workspaceState: vscode.Memento
): TriggerEvent | null {
    const fileName = path.basename(document.fileName);

    // ── package.json ──────────────────────────────────────────────────────────
    if (fileName === 'package.json') {
        let current: Record<string, string> = {};
        try {
            const parsed = JSON.parse(document.getText());
            current = { ...parsed.dependencies, ...parsed.devDependencies };
        } catch {
            return null; // JSON parse error during editing — skip
        }

        const known: Record<string, string> = workspaceState.get(STATE_KEY_KNOWN_DEPS, {});
        const newDeps = Object.keys(current).filter(dep => !known[dep]);

        // Always update known state
        workspaceState.update(STATE_KEY_KNOWN_DEPS, current);

        if (newDeps.length === 0) { return null; }

        // Check if any new dep matches infra keywords
        const keywords = getInfraKeywords().dependencies;
        const infraDeps = newDeps.filter(dep =>
            keywords.some(kw => dep.toLowerCase().includes(kw.toLowerCase()))
        );

        const evidence: string[] = newDeps.map(dep => `Added '${dep}' to package.json`);
        const isInfra = infraDeps.length > 0;

        return {
            type: isInfra ? 'new_infra' : 'new_dependency',
            evidence,
            diff_summary: `${newDeps.length} new package(s) added: ${newDeps.join(', ')}${isInfra ? ' (contains infra-related deps)' : ''}`,
            file_path: document.fileName,
        };
    }

    // ── requirements.txt / pyproject.toml ────────────────────────────────────
    if (fileName === 'requirements.txt' || fileName === 'pyproject.toml') {
        const keywords = getInfraKeywords().dependencies;
        const content = document.getText().toLowerCase();
        const foundInfra = keywords.filter(kw => content.includes(kw.toLowerCase()));

        if (foundInfra.length > 0) {
            return {
                type: 'new_infra',
                evidence: foundInfra.map(kw => `Found '${kw}' in ${fileName}`),
                diff_summary: `${fileName} contains infra-related packages: ${foundInfra.join(', ')}`,
                file_path: document.fileName,
            };
        }

        // Config file changed, even without infra keywords
        return {
            type: 'config_change',
            evidence: [`${fileName} was modified`],
            diff_summary: `${fileName} changed — dependency or config update`,
            file_path: document.fileName,
        };
    }

    return null;
}

/**
 * Detect if a new source file or test file was created.
 * Compares to the known file set stored in workspaceState.
 */
function detectNewFile(
    document: vscode.TextDocument,
    workspaceState: vscode.Memento
): TriggerEvent | null {
    const filePath = document.fileName;
    const ext = path.extname(filePath);

    if (!ANALYZED_EXTENSIONS.has(ext)) { return null; }

    const isTest = isTestFile(filePath);
    const stateKey = isTest ? STATE_KEY_KNOWN_TEST_FILES : STATE_KEY_KNOWN_SOURCE_FILES;
    const knownFiles: string[] = workspaceState.get(stateKey, []);

    if (knownFiles.includes(filePath)) {
        return null; // Already known — not a new file
    }

    // Register this file as known
    workspaceState.update(stateKey, [...knownFiles, filePath]);

    if (isTest) {
        // Check if the corresponding source file is also new (new_test_for_new_module)
        const knownSourceFiles: string[] = workspaceState.get(STATE_KEY_KNOWN_SOURCE_FILES, []);
        const baseName = path.basename(filePath)
            .replace(/\.(test|spec)\.(ts|js|tsx|jsx|py)$/, '')
            .replace(/test_/, '')
            .replace(/_test$/, '');

        const isForNewModule = !knownSourceFiles.some(sf =>
            path.basename(sf, path.extname(sf)) === baseName
        );

        if (isForNewModule) {
            return {
                type: 'new_test_for_new_module',
                evidence: [`New test file created: ${path.relative(getWorkspaceRoot(), filePath)}`, `No validated source module '${baseName}' found in project memory`],
                diff_summary: `Test file created for a module that may not be validated yet`,
                file_path: filePath,
            };
        }
        // Test for an existing module — not a decision event
        return null;
    }

    // Check if it's in a service/infra directory
    const normalized = filePath.replace(/\\/g, '/');
    const keywords = getInfraKeywords();
    const isInServiceDir = SERVICE_DIRS.some(dir => normalized.includes(dir)) ||
                           keywords.infra_directories.some(dir => normalized.includes(dir));

    return {
        type: isInServiceDir ? 'new_service' : 'new_file',
        evidence: [`New file created: ${path.relative(getWorkspaceRoot(), filePath)}`],
        diff_summary: `New ${isInServiceDir ? 'service/infra' : 'source'} file: ${path.basename(filePath)}`,
        file_path: filePath,
    };
}

/**
 * Detect if a key config file was changed (docker-compose, .env, etc.)
 */
function detectConfigChange(document: vscode.TextDocument): TriggerEvent | null {
    const fileName = path.basename(document.fileName);

    if (!CONFIG_FILES.has(fileName)) { return null; }

    // Also scan content for infra keywords
    const keywords = getInfraKeywords();
    const content = document.getText().toLowerCase();
    const foundInfra = keywords.dependencies.filter(kw => content.includes(kw.toLowerCase()));

    const evidence: string[] = [`Config file modified: ${fileName}`];
    if (foundInfra.length > 0) {
        evidence.push(`Contains infra references: ${foundInfra.join(', ')}`);
    }

    return {
        type: foundInfra.length > 0 ? 'new_infra' : 'config_change',
        evidence,
        diff_summary: `${fileName} changed${foundInfra.length > 0 ? ` (infra: ${foundInfra.join(', ')})` : ''}`,
        file_path: document.fileName,
    };
}

// ─── Main Classifier ──────────────────────────────────────────────────────────

/**
 * Classify a file save event. Returns a TriggerEvent or null (= noise).
 *
 * Classification order (first match wins):
 *  1. Noise filters (always ignore)
 *  2. Test file edit (not creation) → null
 *  3. package.json / requirements.txt → dependency detection
 *  4. Config file → config_change / new_infra
 *  5. New file → new_file / new_service / new_test_for_new_module
 *  6. Existing file, minor edit → null
 *  7. Existing file with new imports → new_infra check on content
 */
export function classifyTrigger(
    document: vscode.TextDocument,
    workspaceState: vscode.Memento
): TriggerEvent {
    const filePath = document.fileName;
    const fileName = path.basename(filePath);

    // 1. Noise filters
    if (isNoise(filePath)) {
        return none(filePath);
    }

    // 2. Existing test file edit → skip
    if (isTestFile(filePath)) {
        const knownTestFiles: string[] = workspaceState.get(STATE_KEY_KNOWN_TEST_FILES, []);
        if (knownTestFiles.includes(filePath)) {
            return none(filePath); // Editing an existing test — not a decision event
        }
        // Not in known list → falls through to new file detection below
    }

    // 3. Dependency files
    const depTrigger = detectNewDependency(document, workspaceState);
    if (depTrigger) { return depTrigger; }

    // 4. Config file changes (only if not already caught as dep file)
    const configTrigger = detectConfigChange(document);
    if (configTrigger) { return configTrigger; }

    // 5. New file detection
    const newFileTrigger = detectNewFile(document, workspaceState);
    if (newFileTrigger) { return newFileTrigger; }

    // 6. Minor edit to existing file → null
    if (isMinorEdit(document)) {
        return none(filePath);
    }

    // 7. Existing file — scan content for infra keyword additions
    const keywords = getInfraKeywords().dependencies;
    const content = document.getText().toLowerCase();
    const foundInfra = keywords.filter(kw => content.includes(kw.toLowerCase()));
    if (foundInfra.length > 0) {
        return {
            type: 'new_infra',
            evidence: foundInfra.map(kw => `Source file references '${kw}'`),
            diff_summary: `${fileName} now imports or references infra components: ${foundInfra.join(', ')}`,
            file_path: filePath,
        };
    }

    return none(filePath);
}

// ─── Debounce Accumulator ─────────────────────────────────────────────────────

/**
 * Merge multiple TriggerEvents from the same debounce window into one.
 * Evidence arrays are concatenated. Type is the "most significant" type
 * in the batch (new_infra > new_service > new_dependency > config_change > new_file).
 */
export function mergeTriggers(events: TriggerEvent[]): TriggerEvent {
    if (events.length === 0) {
        return none('');
    }
    if (events.length === 1) {
        return events[0];
    }

    const priority: TriggerType[] = [
        'new_infra', 'new_service', 'new_dependency',
        'new_test_for_new_module', 'config_change', 'new_file',
    ];

    const highestType = priority.find(t => events.some(e => e.type === t)) || events[0].type;

    const allEvidence = [...new Set(events.flatMap(e => e.evidence))];
    const filePaths = [...new Set(events.map(e => e.file_path))];

    return {
        type: highestType,
        evidence: allEvidence,
        diff_summary: `Batch (${events.length} events): ${events.map(e => e.diff_summary).join(' | ')}`,
        file_path: filePaths[0],
    };
}

// ─── Workspace State Initializer ─────────────────────────────────────────────

/**
 * Scan the workspace on activation to build the initial known file set.
 * Without this baseline, every existing file looks "new" on the first save.
 */
export async function initializeWorkspaceState(
    workspaceState: vscode.Memento
): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return; }

    const root = workspaceFolders[0].uri.fsPath;

    // Find all source files and test files
    const sourceFiles: string[] = [];
    const testFiles: string[] = [];

    try {
        const uris = await vscode.workspace.findFiles(
            '**/*.{ts,js,tsx,jsx,py,go,rs,java,rb}',
            '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/__pycache__/**}'
        );

        for (const uri of uris) {
            if (isTestFile(uri.fsPath)) {
                testFiles.push(uri.fsPath);
            } else {
                sourceFiles.push(uri.fsPath);
            }
        }

        await workspaceState.update(STATE_KEY_KNOWN_SOURCE_FILES, sourceFiles);
        await workspaceState.update(STATE_KEY_KNOWN_TEST_FILES, testFiles);

        // Initialize package.json dependency baseline
        const pkgPath = path.join(root, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                await workspaceState.update(STATE_KEY_KNOWN_DEPS, deps);
            } catch {
                logError('Could not parse package.json during workspace init.');
            }
        }
    } catch (err: any) {
        logError(`Workspace state initialization failed: ${err.message}`);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function none(filePath: string): TriggerEvent {
    return { type: 'none', evidence: [], diff_summary: '', file_path: filePath };
}

function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}
