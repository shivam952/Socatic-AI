#!/usr/bin/env node
/**
 * Socratic AI — GitHub Action Entrypoint
 *
 * This script runs inside the GitHub Actions environment.
 * It:
 *   1. Gets the PR diff via the GitHub API
 *   2. Runs action-runner.js (the compiled headless LLM pipeline)
 *   3. Formats findings into a rich PR comment
 *   4. Posts the comment via the GitHub API
 *   5. Optionally fails the check if critical/high issues are found
 *
 * Inputs (from action.yml → env):
 *   GITHUB_TOKEN       — for PR comment API calls
 *   SOCRATIC_API_KEY   — for OpenRouter calls (set as secret)
 *   SOCRATIC_MODEL     — optional model override
 *   FAIL_ON_CRITICAL   — 'true' to fail CI on critical findings (default: false)
 *   GITHUB_REPOSITORY  — e.g. "shivam-ssg/my-project" (auto-set by GH)
 *   GITHUB_EVENT_PATH  — path to the event.json (auto-set by GH)
 *   GITHUB_WORKSPACE   — repo root (auto-set by GH)
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── GitHub API helpers ───────────────────────────────────────────────────────

function ghApiRequest(method, endpoint, body, token) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'api.github.com',
            path: endpoint,
            method,
            headers: {
                'User-Agent': 'socratic-ai-action/1.0',
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(payload ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                } : {}),
            },
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(data); }
            });
        });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

// ─── Comment Formatter ────────────────────────────────────────────────────────

const SEVERITY_EMOJI = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '⚪',
};

const CATEGORY_LABEL = {
    constraint_violation: '⛔ Constraint Violation',
    scope_creep:          '📈 Scope Creep',
    security:             '🔒 Security',
    architecture:         '🏗 Architecture',
    code_quality:         '🔧 Code Quality',
};

function formatPRComment(result, goal, constraints) {
    const lines = [];

    // Header
    const verdictBadge = result.verdict === 'concern'
        ? '🔴 **Needs Discussion**'
        : '✅ **Looking Good**';

    lines.push(`## 🧠 Socratic AI Review — ${verdictBadge}`);
    lines.push('');
    lines.push(`> ${result.summary}`);
    lines.push('');

    // Goal context box
    if (goal) {
        lines.push('<details>');
        lines.push(`<summary>📍 Reviewing against: <strong>${goal.milestone}</strong></summary>`);
        lines.push('');
        lines.push(`**Goal:** ${goal.goal}`);
        lines.push(`**Success metric:** ${goal.success_metric}`);
        lines.push(`**Time horizon:** ${goal.time_horizon}`);
        lines.push('</details>');
        lines.push('');
    }

    // Milestone alignment
    lines.push(`**Milestone alignment:** ${result.milestone_alignment}`);
    lines.push('');

    if (result.findings.length === 0) {
        lines.push('No issues found. This PR is aligned with your goal and constraints.');
    } else {
        // Group by severity
        for (const severity of ['critical', 'high', 'medium', 'low']) {
            const group = result.findings.filter(f => f.severity === severity);
            if (group.length === 0) { continue; }

            lines.push(`### ${SEVERITY_EMOJI[severity]} ${severity.charAt(0).toUpperCase() + severity.slice(1)}`);
            lines.push('');

            for (const f of group) {
                const categoryLabel = CATEGORY_LABEL[f.category] || f.category;
                lines.push(`**${categoryLabel}**`);
                lines.push(`- ⚠️ ${f.issue}`);
                lines.push(`- ✦ ${f.recommendation}`);
                if (f.evidence) {
                    lines.push(`\`\`\`\n${f.evidence}\n\`\`\``);
                }
                lines.push('');
            }
        }
    }

    // Constraint summary (always show — reminds the team what they agreed to)
    if (constraints && constraints.length > 0) {
        lines.push('<details>');
        lines.push('<summary>🚧 Active project constraints</summary>');
        lines.push('');
        for (const c of constraints) {
            lines.push(`- ${c}`);
        }
        lines.push('');
        lines.push('*Constraints are set via `Socratic: Add Constraint` in VS Code or directly in `.socratic/constraints.json`.*');
        lines.push('</details>');
        lines.push('');
    }

    lines.push('---');
    lines.push('*Powered by [Socratic AI](https://github.com/shivam952/Socatic-AI) — AI that questions your thinking, not writes your code.*');

    return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const failOnCritical = process.env.FAIL_ON_CRITICAL === 'true';

    if (!token || !repo || !eventPath) {
        console.error('Missing required GitHub environment variables.');
        process.exit(1);
    }

    // Parse the PR event to get PR number and diff URL
    let event;
    try {
        event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
    } catch (err) {
        console.error('Could not read GitHub event:', err.message);
        process.exit(1);
    }

    const prNumber = event.pull_request?.number;
    if (!prNumber) {
        console.log('Not a pull_request event — skipping Socratic review.');
        process.exit(0);
    }

    console.log(`🧠 Socratic AI: Reviewing PR #${prNumber}...`);

    // Get the PR diff
    let diff = '';
    try {
        const diffResponse = await ghApiRequest(
            'GET',
            `/repos/${repo}/pulls/${prNumber}`,
            null,
            token
        );
        // Get diff via Accept: application/vnd.github.diff header
        diff = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.github.com',
                path: `/repos/${repo}/pulls/${prNumber}`,
                method: 'GET',
                headers: {
                    'User-Agent': 'socratic-ai-action/1.0',
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.diff',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.end();
        });
    } catch (err) {
        console.error('Could not fetch PR diff:', err.message);
        process.exit(1);
    }

    const prTitle = event.pull_request?.title || '';
    const prBody = event.pull_request?.body || '';

    // Run the Socratic headless pipeline
    const runnerPath = path.join(__dirname, '..', 'out', 'action-runner.js');
    if (!fs.existsSync(runnerPath)) {
        console.error(`action-runner.js not found at ${runnerPath}. Make sure the extension is compiled.`);
        process.exit(1);
    }

    const runResult = spawnSync('node', [runnerPath], {
        env: {
            ...process.env,
            PR_DIFF: diff.slice(0, 10000), // Cap before passing via env
            PR_TITLE: prTitle,
            PR_BODY: prBody,
        },
        encoding: 'utf-8',
        timeout: 60000,
    });

    if (runResult.error) {
        console.error('action-runner failed to start:', runResult.error.message);
        process.exit(1);
    }

    // Parse the result — action-runner writes JSON to stdout
    let result;
    try {
        result = JSON.parse(runResult.stdout);
    } catch {
        console.error('action-runner output was not valid JSON:', runResult.stdout?.slice(0, 200));
        if (runResult.stderr) { console.error(runResult.stderr.slice(0, 500)); }
        process.exit(1);
    }

    // Read goal + constraints for the comment
    let goal = null;
    let constraints = [];
    try {
        goal = JSON.parse(fs.readFileSync(path.join(workspace, '.socratic', 'goal.json'), 'utf-8'));
    } catch {}
    try {
        const cm = JSON.parse(fs.readFileSync(path.join(workspace, '.socratic', 'constraints.json'), 'utf-8'));
        constraints = Array.isArray(cm) ? cm : (cm.constraints || []);
    } catch {}

    // Format and post the PR comment
    const comment = formatPRComment(result, goal, constraints);

    // Check if Socratic already commented on this PR — update instead of creating duplicate
    const existingComments = await ghApiRequest(
        'GET',
        `/repos/${repo}/issues/${prNumber}/comments`,
        null,
        token
    );

    const socraticComment = Array.isArray(existingComments)
        ? existingComments.find(c => c.body?.includes('Socratic AI Review'))
        : null;

    if (socraticComment) {
        await ghApiRequest(
            'PATCH',
            `/repos/${repo}/issues/comments/${socraticComment.id}`,
            { body: comment },
            token
        );
        console.log('✅ Socratic: Updated existing PR comment.');
    } else {
        await ghApiRequest(
            'POST',
            `/repos/${repo}/issues/${prNumber}/comments`,
            { body: comment },
            token
        );
        console.log('✅ Socratic: Posted PR comment.');
    }

    // Print summary to CI log
    console.log(`\nVerdict: ${result.verdict.toUpperCase()}`);
    console.log(`Summary: ${result.summary}`);
    if (result.findings.length > 0) {
        console.log(`Findings: ${result.findings.length} (${result.findings.filter(f => f.severity === 'critical').length} critical, ${result.findings.filter(f => f.severity === 'high').length} high)`);
    }

    // Optionally fail CI
    const hasCritical = result.findings.some(f => f.severity === 'critical');
    const hasConstraintViolation = result.findings.some(f => f.category === 'constraint_violation');

    if (failOnCritical && (hasCritical || hasConstraintViolation)) {
        console.error('\n🔴 Socratic: Failing CI — critical issues or constraint violations found.');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
