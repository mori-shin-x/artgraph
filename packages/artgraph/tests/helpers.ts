import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";

export const CLI = resolve(import.meta.dirname, "../dist/cli.js");
export const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");
export const LOCK_PATH = resolve(FIXTURE_DIR, ".trace.lock");

export function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  return runAt(FIXTURE_DIR, args);
}

export function runAt(
  cwd: string,
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      encoding: "utf-8",
      cwd,
      timeout: 30000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

export function cleanup() {
  if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
}
