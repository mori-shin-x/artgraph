import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { runCli } from "../src/cli.js";

// Kept as a public export so a small set of tests (SC-004 perf) can still
// spawn the real bin via subprocess.
export const CLI = resolve(import.meta.dirname, "../dist/cli.js");
export const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
export const LOCK_PATH = resolve(FIXTURE_DIR, ".trace.lock");

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function run(args: string[]): Promise<RunResult> {
  return runAt(FIXTURE_DIR, args);
}

export function runAt(cwd: string, args: string[]): Promise<RunResult> {
  return runCli(args, { cwd });
}

export function cleanup() {
  if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
}
