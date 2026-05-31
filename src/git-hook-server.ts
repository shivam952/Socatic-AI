/**
 * Socratic AI — Git Hook HTTP Server (Track 1.3)
 *
 * Listens on localhost:27341 for pre-commit payloads from the git hook.
 * Uses Node's built-in http module — no new dependencies.
 *
 * Security: bound to 127.0.0.1 only — never reachable from outside the machine.
 * Port conflict: EADDRINUSE is silently swallowed — another VS Code window
 * owns the port. File-save triggers still work for this workspace.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const MAX_BODY_BYTES = 100_000; // 100KB ceiling — prevents memory bomb from huge diffs

// Minimum interval between processed commits — prevents interactive rebase
// (20+ rapid commits) from firing 20 concurrent LLM pipeline calls.
const COMMIT_RATE_LIMIT_MS = 5_000; // 5 seconds

export class GitHookServer {
    private server: http.Server | null = null;
    private lastCommitProcessedAt = 0;
    private portFilePath: string | null = null;

    /**
     * Start the server. onCommit is called with decoded stat and diff strings.
     * Idempotent — calling start() twice is a no-op if already running.
     * onError is called for unexpected server errors (not EADDRINUSE).
     */
    start(
        workspaceRoot: string,
        onCommit: (stat: string, diff: string) => Promise<void>,
        onError?: (msg: string) => void
    ): void {
        if (this.server) { return; }
        
        const gitDir = path.join(workspaceRoot, '.git');
        // If it's a git repository, determine the path for the port file
        if (fs.existsSync(gitDir)) {
            const stat = fs.statSync(gitDir);
            if (stat.isDirectory()) {
                this.portFilePath = path.join(gitDir, 'socratic-hook-port');
            }
        }

        this.server = http.createServer((req, res) => {
            // Health check — the hook calls this first to see if VS Code is open
            if (req.method === 'GET' && req.url === '/health') {
                res.writeHead(200);
                res.end('ok');
                return;
            }

            // Commit payload
            if (req.method === 'POST' && req.url === '/commit') {
                let body = '';
                let byteCount = 0;
                // Guard flag: set to true when req.destroy() is called.
                // Prevents req.on('end') from writing to an already-destroyed response.
                let oversized = false;

                req.on('data', (chunk: Buffer) => {
                    byteCount += chunk.length;
                    if (byteCount > MAX_BODY_BYTES) {
                        oversized = true;
                        req.destroy(); // Drop oversized payload
                        return;
                    }
                    body += chunk.toString();
                });

                req.on('end', () => {
                    // req.destroy() causes 'end' to fire — guard against writing
                    // to a destroyed response socket, which throws "write after end".
                    if (oversized) { return; }

                    res.writeHead(200);
                    res.end('ok');

                    // Rate limit: skip if a commit was processed too recently.
                    const now = Date.now();
                    if (now - this.lastCommitProcessedAt < COMMIT_RATE_LIMIT_MS) { return; }
                    this.lastCommitProcessedAt = now;

                    try {
                        const payload = JSON.parse(body);
                        const stat = Buffer.from(payload.stat_b64 ?? '', 'base64').toString('utf8');
                        const diff = Buffer.from(payload.diff_b64 ?? '', 'base64').toString('utf8');
                        onCommit(stat, diff).catch(() => { /* errors logged inside callback */ });
                    } catch {
                        // Malformed JSON — ignore silently
                    }
                });

                req.on('error', () => { /* ignore — can fire after destroy */ });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        this.server.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                // Another VS Code window owns this port — fine, just skip git triggers
                this.server = null;
            } else {
                // Other errors (EACCES, etc.) — log via callback, don't swallow silently.
                onError?.(`Git hook server error (${err.code ?? 'unknown'}): ${err.message}`);
            }
        });

        // Listen on port 0 to let the OS assign an available port dynamically
        this.server.listen(0, '127.0.0.1', () => {
            const address = this.server?.address();
            if (address && typeof address === 'object' && this.portFilePath) {
                try {
                    fs.writeFileSync(this.portFilePath, address.port.toString(), 'utf8');
                } catch (err: any) {
                    onError?.(`Failed to write socratic-hook-port file: ${err.message}`);
                }
            }
        });
    }

    stop(): void {
        this.server?.close();
        this.server = null;
        if (this.portFilePath && fs.existsSync(this.portFilePath)) {
            try {
                fs.unlinkSync(this.portFilePath);
            } catch {
                // Ignore cleanup errors
            }
        }
        this.portFilePath = null;
    }
}
