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
import * as crypto from 'crypto';
import { logError } from './notifications';
// Track 1.2: Load all rule packs — trigger keywords are aggregated from every pack
// so the classifier catches events from any mistake family.
import { ALL_RULE_PACKS } from './expert-rules/index';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TriggerType =
    | 'new_dependency'
    | 'new_file'
    | 'new_service'
    | 'config_change'
    | 'new_infra'
    | 'new_test_for_new_module'
    | 'manual_checkpoint'
    | 'git_commit'
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
const STATE_KEY_KNOWN_PYTHON_DEPS = 'socratic.knownPythonDeps';
// 7.1: Per-file import line fingerprint — keyed by file path suffix to keep keys short
const STATE_KEY_IMPORT_FINGERPRINTS = 'socratic.importFingerprints';
// 7.2: Per-file config content hash — only fires when content actually changes
const STATE_KEY_CONFIG_HASHES = 'socratic.configHashes';

// ─── Rule Pack Keyword Loader ─────────────────────────────────────────────────

interface RulePackKeywords {
    dependencies: string[];
    file_patterns: string[];
    infra_directories: string[];
}

// Track 1.2: Aggregate keywords from ALL rule packs with dedup.
// A single getInfraKeywords() call returns the union of every pack's trigger_keywords.
function getInfraKeywords(): RulePackKeywords {
    const deps = new Set<string>();
    const patterns = new Set<string>();
    const dirs = new Set<string>();

    for (const pack of ALL_RULE_PACKS) {
        const kw = (pack as any).trigger_keywords;
        if (kw?.dependencies) { for (const d of kw.dependencies) { deps.add(d); } }
        if (kw?.file_patterns) { for (const p of kw.file_patterns) { patterns.add(p); } }
        if (kw?.infra_directories) { for (const dir of kw.infra_directories) { dirs.add(dir); } }
    }

    return {
        dependencies: [...deps],
        file_patterns: [...patterns],
        infra_directories: [...dirs],
    };
}

// ─── Python Dependency Parsing ────────────────────────────────────────────────

/**
 * Parse requirements.txt into a normalized set of package names.
 * Strips version specifiers, comments, and empty lines.
 * Exported so initializeWorkspaceState can use it for baseline seeding.
 */
export function parsePythonDeps(content: string): Set<string> {
    return new Set(
        content.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(l => l.split(/[>=<!~\[]/)[0].trim().toLowerCase())
    );
}

/**
 * Parse [project] or [tool.poetry.dependencies] section from pyproject.toml
 * into a normalized set of package names.
 * Exported so initializeWorkspaceState can use it for baseline seeding.
 */
export function parsePyprojectDeps(content: string): Set<string> {
    const deps = new Set<string>();
    let inDepsSection = false;

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (/^\[(tool\.poetry\.dependencies|project)\]/.test(line)) {
            inDepsSection = true;
            continue;
        }
        if (inDepsSection && line.startsWith('[')) {
            inDepsSection = false; // Entered a new section
            continue;
        }
        if (inDepsSection && line && !line.startsWith('#')) {
            const name = line.split(/[=<>!\s,"']/)[0].trim().toLowerCase();
            if (name) { deps.add(name); }
        }
    }
    return deps;
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
 * Detect if a new dependency was added to package.json, requirements.txt, or pyproject.toml.
 * Diffs current dep set against last known state in workspaceState.
 * Only fires on NEW additions — not on every save.
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
            return null; // JSON is mid-edit — skip
        }

        const known: Record<string, string> = workspaceState.get(STATE_KEY_KNOWN_DEPS, {});
        const newDeps = Object.keys(current).filter(dep => !known[dep]);

        workspaceState.update(STATE_KEY_KNOWN_DEPS, current); // Always update baseline

        if (newDeps.length === 0) { return null; }

        const keywords = getInfraKeywords().dependencies;
        const infraDeps = newDeps.filter(dep =>
            keywords.some(kw => dep.toLowerCase().includes(kw.toLowerCase()))
        );
        const evidence = newDeps.map(dep => `Added '${dep}' to package.json`);

        return {
            type: infraDeps.length > 0 ? 'new_infra' : 'new_dependency',
            evidence,
            diff_summary: `${newDeps.length} new package(s): ${newDeps.join(', ')}${
                infraDeps.length > 0 ? ' (contains infra-related deps)' : ''
            }`,
            file_path: document.fileName,
        };
    }

    // ── requirements.txt — Fix 1: diff against known state, not content scan ──
    if (fileName === 'requirements.txt') {
        const current = parsePythonDeps(document.getText());
        const knownRaw: string[] = workspaceState.get(
            `${STATE_KEY_KNOWN_PYTHON_DEPS}.requirements`, []
        );
        const known = new Set(knownRaw);
        const newDeps = [...current].filter(dep => !known.has(dep));

        // Always update baseline
        workspaceState.update(
            `${STATE_KEY_KNOWN_PYTHON_DEPS}.requirements`,
            [...current]
        );

        if (newDeps.length === 0) { return null; } // Nothing new — silence

        const keywords = getInfraKeywords().dependencies;
        const infraDeps = newDeps.filter(dep =>
            keywords.some(kw => dep.includes(kw.toLowerCase()))
        );
        const evidence = newDeps.map(dep => `Added '${dep}' to requirements.txt`);

        return {
            type: infraDeps.length > 0 ? 'new_infra' : 'new_dependency',
            evidence,
            diff_summary: `${newDeps.length} new Python package(s): ${newDeps.join(', ')}${
                infraDeps.length > 0 ? ' (contains infra-related deps)' : ''
            }`,
            file_path: document.fileName,
        };
    }

    // ── pyproject.toml — Fix 1: diff against known state ─────────────────────
    if (fileName === 'pyproject.toml') {
        const current = parsePyprojectDeps(document.getText());
        const knownRaw: string[] = workspaceState.get(
            `${STATE_KEY_KNOWN_PYTHON_DEPS}.pyproject`, []
        );
        const known = new Set(knownRaw);
        const newDeps = [...current].filter(dep => !known.has(dep));

        workspaceState.update(
            `${STATE_KEY_KNOWN_PYTHON_DEPS}.pyproject`,
            [...current]
        );

        if (newDeps.length === 0) { return null; } // Nothing new — silence

        const keywords = getInfraKeywords().dependencies;
        const infraDeps = newDeps.filter(dep =>
            keywords.some(kw => dep.includes(kw.toLowerCase()))
        );
        const evidence = newDeps.map(dep => `Added '${dep}' to pyproject.toml`);

        return {
            type: infraDeps.length > 0 ? 'new_infra' : 'new_dependency',
            evidence,
            diff_summary: `${newDeps.length} new Python package(s): ${newDeps.join(', ')}${
                infraDeps.length > 0 ? ' (contains infra-related deps)' : ''
            }`,
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
 * 7.2: Diffs content hash against known baseline — only fires when something
 * actually changed. Saves with no content changes (e.g. re-saving without edits)
 * are silenced.
 */
function detectConfigChange(
    document: vscode.TextDocument,
    workspaceState: vscode.Memento
): TriggerEvent | null {
    const fileName = path.basename(document.fileName);

    if (!CONFIG_FILES.has(fileName)) { return null; }

    // Hash the current content — only proceed if it differs from last known hash
    const content = document.getText();
    const currentHash = crypto.createHash('md5').update(content).digest('hex');
    const knownHashes: Record<string, string> = workspaceState.get(STATE_KEY_CONFIG_HASHES, {});

    if (knownHashes[document.fileName] === currentHash) {
        return null; // Content unchanged — silence
    }
    // Update baseline immediately so next identical save is also silenced
    knownHashes[document.fileName] = currentHash;
    workspaceState.update(STATE_KEY_CONFIG_HASHES, knownHashes);

    // Scan content for infra keywords (import-aware: already a config file, full scan is fine)
    const keywords = getInfraKeywords();
    const contentLower = content.toLowerCase();
    const foundInfra = keywords.dependencies.filter(kw => contentLower.includes(kw.toLowerCase()));

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
 * Classify a file save event. Returns a TriggerEvent — type 'none' means silence.
 *
 * Classification order (first match wins):
 *  1. Noise filters (always ignore)
 *  2. Existing test file edit → none
 *  3. Dependency files (package.json, requirements.txt, pyproject.toml)
 *  4. Config file changes (docker-compose, .env, etc.)
 *  5. New file detection
 *  6. Existing file — import-lines-only infra keyword scan
 *     (Fix 2: scoped to import statements, not comments or full content)
 */
export function classifyTrigger(
    document: vscode.TextDocument,
    workspaceState: vscode.Memento
): TriggerEvent {
    const filePath = document.fileName;
    const fileName = path.basename(filePath);

    // ── HIGH-SIGNAL CHECKS FIRST ──────────────────────────────────────────────
    // These run BEFORE the noise filter because dep files like requirements.txt
    // match /\.txt$/ and would be silenced otherwise. A new Redis dependency
    // is never noise, regardless of file extension.

    // 1. Dependency files (highest signal)
    const depTrigger = detectNewDependency(document, workspaceState);
    if (depTrigger) { return depTrigger; }

    // 2. Config file changes (high signal)
    const configTrigger = detectConfigChange(document, workspaceState);
    if (configTrigger) { return configTrigger; }

    // ── NOISE FILTER ──────────────────────────────────────────────────────────
    // Now safe to filter — we've already checked the files that matter.

    // 3. Noise filters
    if (isNoise(filePath)) {
        return none(filePath);
    }

    // 4. Existing test file edit → skip
    if (isTestFile(filePath)) {
        const knownTestFiles: string[] = workspaceState.get(STATE_KEY_KNOWN_TEST_FILES, []);
        if (knownTestFiles.includes(filePath)) {
            return none(filePath);
        }
        // Not known → new test file, falls through to detectNewFile below
    }

    // 5. New file detection
    const newFileTrigger = detectNewFile(document, workspaceState);
    if (newFileTrigger) { return newFileTrigger; }

    // 6. Existing file — import-lines-only infra keyword scan.
    // 7.1: Fingerprint the import lines. Only fire when the fingerprint changes
    // (i.e. an import was added or removed). Editing a function body while
    // already having `import redis from 'redis'` must NOT re-trigger.
    const importLines = document.getText()
        .split('\n')
        .filter(l => /^\s*(import |from .+ import|require\(|import\()/.test(l))
        .sort() // Normalise order so reordering imports doesn't count as a change
        .join('\n')
        .toLowerCase();

    if (importLines.length > 0) {
        const currentFingerprint = crypto.createHash('md5').update(importLines).digest('hex');
        const knownFingerprints: Record<string, string> = workspaceState.get(
            STATE_KEY_IMPORT_FINGERPRINTS, {}
        );

        const unchanged = knownFingerprints[filePath] === currentFingerprint;
        // Always update baseline so next save compares against current state
        knownFingerprints[filePath] = currentFingerprint;
        workspaceState.update(STATE_KEY_IMPORT_FINGERPRINTS, knownFingerprints);

        if (unchanged) {
            return none(filePath); // Import set unchanged — silence
        }

        const keywords = getInfraKeywords().dependencies;
        const foundInfra = keywords.filter(kw => importLines.includes(kw.toLowerCase()));
        if (foundInfra.length > 0) {
            return {
                type: 'new_infra',
                evidence: foundInfra.map(kw => `'${kw}' appears in import statements of ${fileName}`),
                diff_summary: `${fileName} imports infra component(s): ${foundInfra.join(', ')}`,
                file_path: filePath,
            };
        }
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

        // Baseline package.json dependencies
        const pkgPath = path.join(root, 'package.json');
        try {
            const content = await fs.promises.readFile(pkgPath, 'utf-8');
            const pkg = JSON.parse(content);
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            await workspaceState.update(STATE_KEY_KNOWN_DEPS, deps);
        } catch { /* skip if missing or unreadable */ }

        // Fix 4: Baseline Python dep files so first save doesn't fire false positives.
        const reqPath = path.join(root, 'requirements.txt');
        try {
            const content = await fs.promises.readFile(reqPath, 'utf-8');
            const deps = [...parsePythonDeps(content)];
            await workspaceState.update(`${STATE_KEY_KNOWN_PYTHON_DEPS}.requirements`, deps);
        } catch { /* skip */ }

        const pyprojectPath = path.join(root, 'pyproject.toml');
        try {
            const content = await fs.promises.readFile(pyprojectPath, 'utf-8');
            const deps = [...parsePyprojectDeps(content)];
            await workspaceState.update(`${STATE_KEY_KNOWN_PYTHON_DEPS}.pyproject`, deps);
        } catch { /* skip */ }
    } catch (err: any) {
        logError(`Workspace state initialization failed: ${err.message}`);
    }
}

// ─── Git Diff Parser (Track 1.3) ─────────────────────────────────────────────

/**
 * Parse a git diff (stat + content) into a TriggerEvent.
 * Called by the GitHookServer callback in extension.ts.
 *
 * Returns type 'none' if the diff contains nothing worth analysing
 * (e.g. only deletions, only docs, no new deps or files found).
 */
export function parseDiffToTriggers(stat: string, diff: string): TriggerEvent {
    if (!stat && !diff) {
        return none('');
    }

    const evidence: string[] = [];
    const newDeps: string[] = [];
    const newFiles: string[] = [];
    let primaryFile = '';

    const keywords = getInfraKeywords();

    // Split into per-file sections on "diff --git" boundary
    const sections = diff.split(/(?=^diff --git )/m).filter(s => s.trim());

    for (const section of sections) {
        // Extract "b/<path>" from "diff --git a/foo b/foo"
        const fileMatch = section.match(/^diff --git a\/.+ b\/(.+)$/m);
        const filePath = fileMatch ? fileMatch[1].trim() : '';
        if (!primaryFile && filePath) { primaryFile = filePath; }

        const isNewFile = /^new file mode/m.test(section);
        if (isNewFile && filePath) {
            newFiles.push(filePath);
            evidence.push(`New file created: ${filePath}`);
        }

        // Added lines only (skip the +++ header line)
        const addedLines = section
            .split('\n')
            .filter(l => l.startsWith('+') && !l.startsWith('+++'))
            .map(l => l.slice(1).trim());

        const fileName = path.basename(filePath);

        // Parse new deps from dep files
        if (fileName === 'requirements.txt' || fileName === 'pyproject.toml') {
            for (const line of addedLines) {
                if (!line || line.startsWith('#')) { continue; }
                const pkgName = line.split(/[>=<!~\[]/)[0].trim().toLowerCase();
                if (pkgName.length > 1) {
                    newDeps.push(pkgName);
                    evidence.push(`Added '${pkgName}' to ${fileName}`);
                }
            }
        } else if (fileName === 'package.json') {
            for (const line of addedLines) {
                const depMatch = line.match(/"([\w\-@/]+)"\s*:/);
                if (depMatch && depMatch[1] !== 'name' && depMatch[1] !== 'version') {
                    newDeps.push(depMatch[1]);
                    evidence.push(`Added '${depMatch[1]}' to package.json`);
                }
            }
        }

        // Infra keyword scan across ALL added lines in this file
        const addedContent = addedLines.join(' ').toLowerCase();
        const foundInfra = keywords.dependencies.filter(kw =>
            addedContent.includes(kw.toLowerCase())
        );
        if (foundInfra.length > 0) {
            evidence.push(`Infra keywords in ${fileName}: ${foundInfra.join(', ')}`);
        }
    }

    // Bail if nothing meaningful was found — but for git commits, check if the
    // diff touches core source files with real substance. Git commits are decisions,
    // not noise. Let the LLM decide if it's worth flagging.
    if (evidence.length === 0) {
        const touchesCoreSource = sections.some(s => {
            const fileMatch = s.match(/^diff --git a\/.+ b\/(.+)$/m);
            const fp = fileMatch ? fileMatch[1] : '';
            const ext = fp.split('.').pop();
            return ['py', 'ts', 'js', 'go', 'rs', 'tsx', 'jsx'].includes(ext ?? '');
        });

        const addedLineCount = diff.split('\n').filter(l =>
            l.startsWith('+') && !l.startsWith('+++')
        ).length;

        if (touchesCoreSource && addedLineCount >= 8) {
            const diffSnippet = diff.slice(0, 1500);
            const statLines = stat.trim().split('\n').filter(Boolean);
            return {
                type: 'git_commit' as TriggerType,
                evidence: [`GIT DIFF:\n${diffSnippet}${diff.length > 1500 ? '\n...(truncated)' : ''}`],
                diff_summary: `[git commit] ${statLines[statLines.length - 1] ?? 'code change'}`,
                file_path: primaryFile,
            };
        }

        return none(primaryFile);
    }

    // Append raw diff snippet as the last evidence item (lowest priority)
    const diffSnippet = diff.slice(0, 1500);
    evidence.push(`GIT DIFF:\n${diffSnippet}${diff.length > 1500 ? '\n...(truncated)' : ''}`);

    // Determine the highest-priority type
    const infraDeps = newDeps.filter(dep =>
        keywords.dependencies.some(kw => dep.includes(kw.toLowerCase()))
    );
    const infraFiles = newFiles.filter(f => {
        const normalized = f.replace(/\\/g, '/');
        return SERVICE_DIRS.some(dir => normalized.includes(dir)) ||
               keywords.infra_directories.some(dir => normalized.includes(dir));
    });

    let type: TriggerType;
    if (infraDeps.length > 0)        { type = 'new_infra'; }
    else if (infraFiles.length > 0)  { type = 'new_service'; }
    else if (newDeps.length > 0)     { type = 'new_dependency'; }
    else if (newFiles.length > 0)    { type = 'new_file'; }
    else                             { type = 'git_commit'; }

    // Use the last line of stat as summary ("N files changed, X insertions")
    const statLines = stat.trim().split('\n').filter(Boolean);
    const statSummary = statLines[statLines.length - 1] ?? 'git commit';

    return {
        type,
        evidence,
        diff_summary: `[git commit] ${statSummary}`,
        file_path: primaryFile,
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function none(filePath: string): TriggerEvent {
    return { type: 'none', evidence: [], diff_summary: '', file_path: filePath };
}

function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}
