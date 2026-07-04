#!/usr/bin/env node
// Regenerate docs/demo/tag-zero.cast (asciinema v2) from the actual
// dist/cli.js output of the tag-zero brownfield flow.
//
// Why hand-authored instead of `asciinema rec`:
//   1. Deterministic — same fixture, same commands, same cast → same SVG.
//   2. Works in headless CI (no TTY).
//   3. Anyone can regenerate: `pnpm demo:record`.
//
// The captured stdout comes from the REAL binary (no mocking), so if the
// tag-zero flow breaks, the recorder crashes before writing a stale cast.
// Only the "typing" timing is synthesized — the payload is authentic.
//
// After running this, convert the cast to an SVG for README embedding:
//   pnpm demo:svg   (calls svg-term-cli)

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");
const OUT_CAST = resolve(REPO_ROOT, "docs/demo/tag-zero.cast");

// --- Fixture setup mirrors tests/e2e/tag-zero.e2e.test.ts so the demo shows
// exactly what the E2E test guards. Divergence would mean the SVG lies. ---
const workDir = mkdtempSync(join(tmpdir(), "artgraph-demo-record-"));
try {
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(
    join(workDir, "src", "a.ts"),
    `import { hello } from "./b";\nexport const greeting = hello();\n`,
  );
  writeFileSync(
    join(workDir, "src", "b.ts"),
    `export function hello(): string {\n  return "hi";\n}\n`,
  );
  writeFileSync(
    join(workDir, "package.json"),
    JSON.stringify(
      { name: "brownfield-fixture", version: "0.0.0", type: "module" },
      null,
      2,
    ),
  );

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "artgraph-demo",
    GIT_AUTHOR_EMAIL: "demo@example.com",
    GIT_COMMITTER_NAME: "artgraph-demo",
    GIT_COMMITTER_EMAIL: "demo@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir, env: gitEnv });
  execFileSync("git", ["add", "."], { cwd: workDir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: workDir, env: gitEnv });

  // The "user just edited a file" step in the pitch.
  writeFileSync(
    join(workDir, "src", "b.ts"),
    `export function hello(): string {\n  return "hi there";\n}\n`,
  );

  // --- Capture real bin output ---
  function runCli(args) {
    const r = spawnSync("node", [CLI, ...args], {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 30000,
    });
    if (r.status !== 0) {
      throw new Error(
        `CLI failed for [${args.join(" ")}]: exit ${r.status}\n${r.stderr}`,
      );
    }
    return r.stdout;
  }

  // `init --agents=claude` matches the README command exactly. Spec 013
  // makes --agents required whenever Skills / agent-context distribution
  // runs. The Claude Code Skills install output is verbose but honest —
  // the Zero-tag ready message lands at the tail as the payoff.
  const initOut = runCli(["init", "--agents=claude"]);
  // Single source of truth for the impact command so the on-screen "typed"
  // command and the args actually executed can never drift apart.
  const IMPACT_ARGS = ["impact", "--diff"];
  const impactOut = runCli(IMPACT_ARGS);

  // --- Compose an asciinema v2 cast ---
  //
  // Format (https://docs.asciinema.org/manual/asciicast/v2/):
  //   Line 1: JSON header (version, dimensions, title, ...)
  //   Line N: JSON tuple `[time_seconds, "o", data]`
  // Times are absolute seconds since start; `data` is raw stdout bytes.
  // Terminal newlines must be "\r\n" so svg-term / asciinema players
  // render them as line breaks instead of just line feeds.

  const events = [];
  let t = 0;
  const bumpMs = (ms) => {
    t += ms / 1000;
  };
  const emit = (data) => {
    events.push([Number(t.toFixed(3)), "o", data]);
  };
  const crlf = (s) => s.replace(/\r?\n/g, "\r\n");

  const PROMPT_ANSI = "\x1b[32m$\x1b[0m "; // green $
  const COMMENT_ANSI_OPEN = "\x1b[90m"; // dim grey
  const ANSI_RESET = "\x1b[0m";

  function typePrompt() {
    emit(PROMPT_ANSI);
    bumpMs(300);
  }
  function typeCommand(cmd) {
    for (const ch of cmd) {
      emit(ch);
      bumpMs(55);
    }
    emit("\r\n");
    bumpMs(220);
  }
  // Split the payload on newlines so the reader gets a "scrolling" effect
  // rather than one giant paint. Delay per line is short — this is output,
  // not typing.
  function dumpOutput(text, msPerLine = 90) {
    const lines = crlf(text).split("\r\n");
    // `text` (console.log output) ends with "\n", so splitting on "\r\n"
    // leaves one trailing empty element — drop it so we don't emit a
    // silent, content-free line into the cast.
    if (lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const suffix = i === lines.length - 1 ? "" : "\r\n";
      emit(lines[i] + suffix);
      bumpMs(msPerLine);
    }
  }
  function comment(text) {
    emit(`${COMMENT_ANSI_OPEN}# ${text}${ANSI_RESET}\r\n`);
    bumpMs(1100);
  }
  function pause(ms) {
    bumpMs(ms);
  }

  // ---- Scene 1: intro comment ----
  bumpMs(400);
  comment("Existing TypeScript repo. No specs, no @impl tags, no config.");

  // ---- Scene 2: artgraph init ----
  typePrompt();
  typeCommand("pnpm dlx artgraph init --agents=claude");
  dumpOutput(initOut);
  // Let the "Zero-tag ready" tail sit on screen for a beat.
  pause(1800);

  // ---- Scene 3: user edited a file ----
  comment("You edited src/b.ts — now see what's affected:");

  // ---- Scene 4: artgraph impact --diff ----
  typePrompt();
  typeCommand(`pnpm dlx artgraph ${IMPACT_ARGS.join(" ")}`);
  dumpOutput(impactOut, 130);
  pause(2500);
  // `pause()` only advances the clock — it never emits. Without a trailing
  // emit here, the cast's last event timestamp is whatever `dumpOutput` last
  // wrote, so the 2.5s "let the payoff sit" pause is invisible to the SVG
  // renderer and the final (most important) frame gets truncated out of the
  // animation loop. Emit a no-op event to commit the elapsed time.
  emit("");

  // ---- Finalise cast file ----
  const HEADER = {
    version: 2,
    width: 96,
    // Must be >= the real output line count (41 lines as of writing) plus
    // headroom, and must match `demo:svg`'s `--height` in package.json —
    // otherwise the render window scrolls the early lines out of frame.
    height: 45,
    title: "artgraph tag-zero 30-second start",
    env: { TERM: "xterm-256color", SHELL: "/bin/sh" },
  };
  mkdirSync(dirname(OUT_CAST), { recursive: true });
  const lines = [JSON.stringify(HEADER)];
  for (const e of events) lines.push(JSON.stringify(e));
  writeFileSync(OUT_CAST, lines.join("\n") + "\n");
  console.log(
    `Wrote ${OUT_CAST} — ${events.length} events, ~${t.toFixed(1)}s runtime.`,
  );
  console.log("Next: pnpm demo:svg");
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup, don't mask the primary error
  }
}
