/**
 * @internal
 * Test seam — intentionally hidden from the public package surface via the
 * `exports` field in package.json. Mutates global process state during the
 * call (cwd / exit / console / stdout / stderr) and is unsafe for external
 * use. Tests reach it via the in-repo path `../src/cli.js`, which re-exports
 * `runCli` from this module (issue #162 — this is the composition-root /
 * test-harness split; `src/cli.ts` stays the production entry point).
 */
import { CommanderError } from "commander";
import { buildProgram } from "../build-program.js";
import { getHookStdinOverride, setHookStdinOverride } from "../hook-stdin-override.js";

export interface RunCliOptions {
  /** Working directory the CLI sees as `process.cwd()` for the duration of the call. */
  cwd?: string;
  /** Optional stdin string injected into hook-pretool (replaces process.stdin reads). */
  stdin?: string;
}

/** @internal */
export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

class CliExitError extends Error {
  exitCode: number;
  constructor(exitCode: number) {
    super(`artgraph CLI exited with code ${exitCode}`);
    this.exitCode = exitCode;
  }
}

/**
 * @internal
 * Run the artgraph CLI in-process and capture its stdout/stderr/exitCode.
 * Used by the test suite to avoid the ~150–300 ms per-spawn Node startup +
 * parser-stack reload cost. Behaves like a fresh `artgraph <argv>` invocation:
 * builds a new commander tree, redirects console/process.stdout/process.stderr,
 * intercepts `process.exit`, and temporarily chdirs into `opts.cwd`.
 *
 * NOT a public API — the package's `exports` field deliberately blocks
 * deep imports so external consumers cannot reach this. It mutates global
 * process state (cwd / exit / console / stdout / stderr) and is unsafe
 * to call concurrently within a single Node process.
 */
export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origCwd = process.cwd();
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const hadStdinOverride = getHookStdinOverride() !== undefined;
  const prevStdinOverride = getHookStdinOverride();
  // Snapshot `process.exitCode` so we can restore it after this runCli call.
  // Commands may leave a non-zero exitCode (e.g. `init` on hooksInstall
  // failure) that would otherwise poison the surrounding vitest process's
  // exit state.
  const origProcessExitCode = process.exitCode;

  const pushStdout = (s: string) => stdoutChunks.push(s);
  const pushStderr = (s: string) => stderrChunks.push(s);

  let exitCode = 0;

  try {
    if (opts.cwd) process.chdir(opts.cwd);
    if (opts.stdin !== undefined) setHookStdinOverride(opts.stdin);

    console.log = (...args: unknown[]) => {
      pushStdout(args.map(formatLogArg).join(" ") + "\n");
    };
    console.error = (...args: unknown[]) => {
      pushStderr(args.map(formatLogArg).join(" ") + "\n");
    };
    process.stdout.write = ((chunk: unknown) => {
      pushStdout(chunkToString(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      pushStderr(chunkToString(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new CliExitError(code ?? 0);
    }) as typeof process.exit;

    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({
      writeOut: pushStdout,
      writeErr: pushStderr,
    });

    try {
      await program.parseAsync(argv, { from: "user" });
      // Commands may signal failure by mutating `process.exitCode` instead of
      // throwing (e.g. `init` on hooksInstall failure). Read it here so those
      // exits are visible in RunCliResult.
      if (typeof process.exitCode === "number" && process.exitCode !== 0) {
        exitCode = process.exitCode;
      }
    } catch (e) {
      if (e instanceof CliExitError) {
        exitCode = e.exitCode;
      } else if (e instanceof CommanderError) {
        // Help / version exits are conventionally success.
        const code = e.code;
        if (code === "commander.helpDisplayed" || code === "commander.version") {
          exitCode = 0;
        } else {
          exitCode = e.exitCode ?? 1;
        }
      } else {
        throw e;
      }
    }
  } finally {
    process.chdir(origCwd);
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    setHookStdinOverride(hadStdinOverride ? prevStdinOverride : undefined);
    // Restore prior `process.exitCode` so a runCli call doesn't leak its
    // exit state into the surrounding test process.
    process.exitCode = origProcessExitCode;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    exitCode,
  };
}

function formatLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  return String(chunk);
}
