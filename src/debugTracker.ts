import * as vscode from "vscode";
import { LogManager } from "./logManager";

/**
 * Intercepts Debug Adapter Protocol (DAP) messages and forwards output
 * events to the LogManager for persistence.
 *
 * Registered via vscode.debug.registerDebugAdapterTrackerFactory("*", …)
 * so it captures output from **any** debugger type (debugpy, node, etc.).
 */
export class DebugTrackerFactory implements vscode.DebugAdapterTrackerFactory {
  constructor(
    private logManager: LogManager,
    private outputChannel: vscode.OutputChannel
  ) {}

  createDebugAdapterTracker(
    session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterTracker> {
    return new DebugOutputTracker(session, this.logManager, this.outputChannel);
  }
}

class DebugOutputTracker implements vscode.DebugAdapterTracker {
  constructor(
    private session: vscode.DebugSession,
    private logManager: LogManager,
    private outputChannel: vscode.OutputChannel
  ) {}

  /**
   * Called for every message sent FROM the debug adapter TO VS Code.
   * We're interested in "output" events which carry stdout/stderr/console text.
   *
   * DAP OutputEvent spec:
   *   { type: "event", event: "output", body: { category, output, ... } }
   */
  onDidSendMessage(message: unknown): void {
    const msg = message as Record<string, unknown>;

    if (msg.type !== "event" || msg.event !== "output") {
      return;
    }

    const body = msg.body as { category?: string; output?: string } | undefined;
    if (!body?.output) {
      return;
    }

    // Categories: "stdout", "stderr", "console", "important", "telemetry"
    const config = vscode.workspace.getConfiguration("debugLogCapture");
    const excluded = config.get<string[]>("excludeCategories", ["telemetry"]);
    if (body.category && excluded.includes(body.category)) {
      return;
    }

    this.logManager.write(this.session.id, body.output, body.category);
  }

  onWillStopSession(): void {
    this.outputChannel.appendLine(
      `[Tracker] Session stopping: ${this.session.name}`
    );
  }

  onError(error: Error): void {
    this.logManager.write(
      this.session.id,
      `[TRACKER ERROR] ${error.message}`,
      "stderr"
    );
  }

  onExit(code: number | undefined, signal: string | undefined): void {
    this.logManager.write(
      this.session.id,
      `[Process exited] code=${code ?? "?"} signal=${signal ?? "none"}`,
      "console"
    );
  }
}
