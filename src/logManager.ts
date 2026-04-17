import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface LogSession {
  sessionId: string;
  sessionName: string;
  logFile: string;
  startedAt: string;
  isActive: boolean;
}

/**
 * Manages debug log files: creation, writing, cleanup, and size limits.
 */
export class LogManager {
  private logDir: string = "";
  private activeSessions: Map<string, LogSession> = new Map();
  private writeStreams: Map<string, fs.WriteStream> = new Map();
  // childSessionId → rootSessionId. Subprocess DAP sessions are routed into
  // their parent's log file instead of getting a dedicated file.
  private sessionAliases: Map<string, string> = new Map();

  constructor(private outputChannel: vscode.OutputChannel) {}

  /** Resolve a session id, following any alias chain to the root session. */
  private resolveSessionId(sessionId: string): string {
    let current = sessionId;
    const seen = new Set<string>();
    while (this.sessionAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.sessionAliases.get(current)!;
    }
    return current;
  }

  // ── Configuration helpers ───────────────────────────────────────────

  private getConfig() {
    return vscode.workspace.getConfiguration("debugLogCapture");
  }

  getLogDirectory(): string {
    const config = this.getConfig();
    const relDir = config.get<string>("logDirectory", "debug-logs");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error("No workspace folder open");
    }
    return path.join(workspaceRoot, relDir);
  }

  // ── Session lifecycle ───────────────────────────────────────────────

  /**
   * Called when a debug session starts. Creates the log directory, optionally
   * cleans old logs, and opens a write stream for the new session.
   */
  startSession(session: vscode.DebugSession): string {
    this.logDir = this.getLogDirectory();
    const config = this.getConfig();

    // Ensure directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // If this session has a parent already tracked by us, route its output
    // into the parent's (root's) log file instead of creating a new one.
    if (session.parentSession) {
      const rootId = this.resolveSessionId(session.parentSession.id);
      const rootLog = this.activeSessions.get(rootId);
      const rootStream = this.writeStreams.get(rootId);
      if (rootLog && rootStream) {
        this.sessionAliases.set(session.id, rootId);
        rootStream.write(
          `\n── Subprocess attached: ${session.name} [${session.id}] ──\n`
        );
        this.outputChannel.appendLine(
          `[LogManager] Subprocess "${session.name}" → ${rootLog.logFile}`
        );
        return rootLog.logFile;
      }
      // Fallthrough: parent isn't tracked (shouldn't normally happen) — treat
      // this as a standalone session so we don't lose its output.
    }

    // Clean previous logs if configured
    if (config.get<boolean>("cleanOnStart", true) && this.activeSessions.size === 0) {
      this.cleanAllLogs();
    }

    // Build a filesystem-safe name from the session name
    const safeName = session.name
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const logFile = path.join(this.logDir, `${safeName}.log`);
    const now = new Date().toISOString();

    const logSession: LogSession = {
      sessionId: session.id,
      sessionName: session.name,
      logFile,
      startedAt: now,
      isActive: true,
    };

    this.activeSessions.set(session.id, logSession);

    // Open write stream
    const stream = fs.createWriteStream(logFile, { flags: "w", encoding: "utf-8" });
    this.writeStreams.set(session.id, stream);

    // Write header
    const header = [
      `════════════════════════════════════════════════════════════`,
      `  Debug Session: ${session.name}`,
      `  Started:       ${now}`,
      `  Session ID:    ${session.id}`,
      `  Type:          ${session.type}`,
      `════════════════════════════════════════════════════════════`,
      "",
    ].join("\n");
    stream.write(header + "\n");

    this.outputChannel.appendLine(`[LogManager] Capturing → ${logFile}`);
    return logFile;
  }

  /**
   * Called when a debug session ends. Closes the write stream and marks
   * the session as inactive.
   */
  stopSession(sessionId: string): void {
    // Aliased subprocess: write a marker to the parent's stream and detach.
    if (this.sessionAliases.has(sessionId)) {
      const rootId = this.resolveSessionId(sessionId);
      const rootStream = this.writeStreams.get(rootId);
      rootStream?.write(
        `\n── Subprocess detached: ${sessionId} ──\n`
      );
      this.sessionAliases.delete(sessionId);
      this.outputChannel.appendLine(`[LogManager] Subprocess detached: ${sessionId}`);
      return;
    }

    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.isActive = false;
    }

    const stream = this.writeStreams.get(sessionId);
    if (stream) {
      stream.write(`\n════ Session ended: ${new Date().toISOString()} ════\n`);
      stream.end();
      this.writeStreams.delete(sessionId);
    }

    this.activeSessions.delete(sessionId);
    this.outputChannel.appendLine(`[LogManager] Session ended: ${sessionId}`);
  }

  // ── Writing ─────────────────────────────────────────────────────────

  /**
   * Append a line of debug output to the session's log file.
   */
  write(sessionId: string, output: string, category?: string): void {
    const rootId = this.resolveSessionId(sessionId);
    const stream = this.writeStreams.get(rootId);
    if (!stream) {
      return;
    }

    const config = this.getConfig();
    const includeTimestamps = config.get<boolean>("includeTimestamps", true);

    const prefix = includeTimestamps
      ? `[${new Date().toISOString()}]`
      : "";

    const tag = category && category !== "stdout" ? ` [${category}]` : "";
    const line = `${prefix}${tag} ${output}`;

    stream.write(line.endsWith("\n") ? line : line + "\n");

    // Check file size limit (against the root session's file)
    this.checkSizeLimit(rootId);
  }

  // ── Cleanup & size management ───────────────────────────────────────

  cleanAllLogs(): void {
    try {
      const dir = this.getLogDirectory();
      if (!fs.existsSync(dir)) {
        return;
      }
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
      for (const file of files) {
        fs.unlinkSync(path.join(dir, file));
      }
      this.outputChannel.appendLine(
        `[LogManager] Cleaned ${files.length} log file(s)`
      );
    } catch (err) {
      this.outputChannel.appendLine(`[LogManager] Clean error: ${err}`);
    }
  }

  private checkSizeLimit(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    const config = this.getConfig();
    const maxMB = config.get<number>("maxLogSizeMB", 10);
    const maxBytes = maxMB * 1024 * 1024;

    try {
      const stats = fs.statSync(session.logFile);
      if (stats.size > maxBytes) {
        // Truncate: keep the last half of the file
        const content = fs.readFileSync(session.logFile, "utf-8");
        const lines = content.split("\n");
        const half = Math.floor(lines.length / 2);
        const truncated =
          `[... truncated ${half} older lines ...]\n` +
          lines.slice(half).join("\n");

        // Close current stream, rewrite, reopen
        const stream = this.writeStreams.get(sessionId);
        stream?.end();

        fs.writeFileSync(session.logFile, truncated, "utf-8");

        const newStream = fs.createWriteStream(session.logFile, {
          flags: "a",
          encoding: "utf-8",
        });
        this.writeStreams.set(sessionId, newStream);

        this.outputChannel.appendLine(
          `[LogManager] Truncated ${session.logFile} (was ${stats.size} bytes)`
        );
      }
    } catch {
      // Ignore — file might be mid-write
    }
  }

  // ── Query helpers (used by MCP server) ──────────────────────────────

  getSessions(): LogSession[] {
    return Array.from(this.activeSessions.values());
  }

  getActiveSessionForName(name: string): LogSession | undefined {
    for (const s of this.activeSessions.values()) {
      if (s.sessionName === name && s.isActive) {
        return s;
      }
    }
    return undefined;
  }

  readLog(logFile: string, tailLines?: number): string {
    if (!fs.existsSync(logFile)) {
      return "";
    }
    const content = fs.readFileSync(logFile, "utf-8");
    if (tailLines && tailLines > 0) {
      const lines = content.split("\n");
      return lines.slice(-tailLines).join("\n");
    }
    return content;
  }

  /**
   * Return all .log files in the log directory (for the MCP server to
   * discover sessions even if the extension restarted).
   */
  listLogFiles(): { name: string; path: string; sizeBytes: number; modifiedAt: string }[] {
    try {
      const dir = this.getLogDirectory();
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => {
          const fullPath = path.join(dir, f);
          const stats = fs.statSync(fullPath);
          return {
            name: f,
            path: fullPath,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    } catch {
      return [];
    }
  }

  // ── Disposal ────────────────────────────────────────────────────────

  dispose(): void {
    for (const stream of this.writeStreams.values()) {
      stream.end();
    }
    this.writeStreams.clear();
    this.activeSessions.clear();
    this.sessionAliases.clear();
  }
}
