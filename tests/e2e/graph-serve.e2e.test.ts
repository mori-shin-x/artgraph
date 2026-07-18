// Wave 2 (issue #125): end-to-end smoke test for `artgraph scan --serve`.
// Spawns the built bin so we exercise the real http.Server + signal handling
// path — the in-process unit suite can't drive that because runCli intercepts
// process.exit and the scan subcommand keeps the event loop alive on the
// server socket.

import { afterAll, describe, expect, it } from "vitest";
import { get } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");
const FIXTURE_DIR = resolve(REPO_ROOT, "tests/fixtures");

// Fixed high port — the e2e config runs single-forked (fileParallelism:false)
// so there's no in-suite concurrent bind. If a stale server ever squats the
// port, the test surfaces a clear EADDRINUSE from the child.
const PORT = 39191;

interface HttpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function fetchOnce(url: string): Promise<HttpResponse> {
  return new Promise((resolvePromise, reject) => {
    const req = get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolvePromise({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error("request timeout"));
    });
  });
}

// Poll `/` until it returns 200 or the deadline passes. The child bin takes
// a beat to bind on cold Node; without this the fetch would race the listen()
// callback and get ECONNREFUSED.
async function waitReady(url: string, timeoutMs: number): Promise<HttpResponse> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetchOnce(url);
      if (res.status === 200) return res;
      lastErr = new Error(`status ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms: ${String(lastErr)}`);
}

function waitExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

describe("e2e: scan --serve", () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterAll(() => {
    // Belt-and-suspenders: the individual test kills the child on the happy
    // path, but if it threw before then the child would leak past the suite.
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  });

  it(
    "serves /, /app.js, /vendor/cytoscape.min.js and 404s unknown paths",
    { timeout: 15000 },
    async () => {
      child = spawn("node", [CLI, "scan", "--serve", "--port", String(PORT)], {
        cwd: FIXTURE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Attach data listeners so the child's stdout/stderr buffers don't fill
      // and block. We don't assert on the content here — the HTTP checks below
      // are the real signal.
      child.stdout.on("data", () => {});
      child.stderr.on("data", () => {});

      // Guard against the child dying before we can fetch — otherwise the
      // waitReady loop would spin uselessly until timeout.
      const earlyExit = new Promise<never>((_, reject) => {
        child!.once("exit", (code) => {
          reject(new Error(`server exited early with code ${code}`));
        });
      });

      const ready = waitReady(`http://127.0.0.1:${PORT}/`, 3000);
      const root = await Promise.race([ready, earlyExit]);

      expect(root.status).toBe(200);
      expect(root.contentType).toMatch(/text\/html/);
      const html = root.body.toString("utf-8");
      expect(html).toContain('id="artgraph-data"');
      expect(html).toContain("cytoscape.min.js");
      // spec 020 T018 / FR-021: the exercises legend entry is static markup
      // (like the Layers/State sections), so it renders even for this
      // fixture, which has no `exercises` edges — legend entry always
      // present is the chosen design (consistency over conditional UI).
      expect(html).toMatch(/legend-swatch[^"]*edge-exercises/);
      expect(html).toContain("exercises");

      const app = await fetchOnce(`http://127.0.0.1:${PORT}/app.js`);
      expect(app.status).toBe(200);
      expect(app.contentType).toMatch(/text\/javascript/);
      expect(app.body.length).toBeGreaterThan(100);
      const appJs = app.body.toString("utf-8");
      // The cytoscape stylesheet distinguishes `exercises` edges (coverage
      // evidence) from declared edges with a dashed line-style.
      expect(appJs).toMatch(/edge\[\s*kind\s*=\s*["']exercises["']\s*\]/);
      expect(appJs).toMatch(/"line-style"\s*:\s*"dashed"/);

      const vendor = await fetchOnce(`http://127.0.0.1:${PORT}/vendor/cytoscape.min.js`);
      expect(vendor.status).toBe(200);
      expect(vendor.contentType).toMatch(/text\/javascript/);
      // Cytoscape minified is ~425KB — a truncated or missing file would come
      // in well under 100KB.
      expect(vendor.body.length).toBeGreaterThan(100_000);

      const notFound = await fetchOnce(`http://127.0.0.1:${PORT}/does-not-exist`);
      expect(notFound.status).toBe(404);

      // Regression: `/index.html` must resolve to the same rendered HTML as
      // `/`. Browsers and static-host mirrors sometimes canonicalize to
      // /index.html, and pre-refactor the route was covered by handler code
      // but never exercised by a test.
      const indexHtml = await fetchOnce(`http://127.0.0.1:${PORT}/index.html`);
      expect(indexHtml.status).toBe(200);
      expect(indexHtml.contentType).toMatch(/text\/html/);
      expect(indexHtml.body.toString("utf-8")).toContain('id="artgraph-data"');

      child.kill("SIGINT");
      const code = await waitExit(child, 3000);
      // Tightened from `expect([0, 130]).toContain(code)`: prior to the
      // A2 fix, keep-alive sockets pinned `server.close()` open past our
      // 3s waitExit budget, so the child got SIGKILLed and exited 130
      // — the test accepted that as "cleanly stopped" and silently
      // masked the bug. `closeIdleConnections` + `closeAllConnections`
      // in `startServer` now guarantee a graceful exit 0.
      expect(code).toBe(0);
    },
  );

  // issue #172 (C4) — before this fix, `--port 0` (ask the OS for a free
  // ephemeral port) printed the literal requested port back
  // ("serving at http://127.0.0.1:0"), which is not a URL anyone can visit.
  // `startServer` now reads the ACTUAL bound port from `server.address()`.
  // This needs a real listening socket (the in-process `runCli` harness
  // can't drive `--serve` — see this file's own top-of-file comment), so
  // it's covered here rather than in the unit suite.
  it(
    "T-graph-serve-172-C4: --port 0 prints the real bound port, and that port is reachable",
    { timeout: 15000 },
    async () => {
      let stderrBuf = "";
      const proc = spawn("node", [CLI, "scan", "--serve", "--port", "0"], {
        cwd: FIXTURE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout.on("data", () => {});
      proc.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString("utf-8");
      });

      const earlyExit = new Promise<never>((_, reject) => {
        proc.once("exit", (code) => {
          reject(new Error(`server exited early with code ${code}; stderr so far: ${stderrBuf}`));
        });
      });

      const waitForServingLine = (async (): Promise<RegExpMatchArray> => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const match = stderrBuf.match(/serving at http:\/\/127\.0\.0\.1:(\d+)/);
          if (match) return match;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(
          `did not see a "serving at" line within budget; stderr so far: ${stderrBuf}`,
        );
      })();

      const match = await Promise.race([waitForServingLine, earlyExit]);
      const boundPort = Number(match[1]);
      // The whole point of C4: the OS-assigned port must not be the literal
      // requested `0` — it must be a real, distinct ephemeral port.
      expect(boundPort).toBeGreaterThan(0);

      const res = await fetchOnce(`http://127.0.0.1:${boundPort}/`);
      expect(res.status).toBe(200);
      expect(res.contentType).toMatch(/text\/html/);

      proc.kill("SIGINT");
      const code = await waitExit(proc, 3000);
      expect(code).toBe(0);
    },
  );

  // issue #172 (C6) — `--host 0.0.0.0` binds every interface, not just
  // localhost, exposing the (unauthenticated) graph server to the whole
  // LAN. `startServer` now prints a one-line heads-up warning when it does.
  it(
    "T-graph-serve-172-C6: --host 0.0.0.0 warns about network exposure on stderr",
    { timeout: 15000 },
    async () => {
      let stderrBuf = "";
      // --port 0: avoids any risk of colliding with the fixed-port test
      // above under the single-fork e2e config (fileParallelism:false).
      const proc = spawn("node", [CLI, "scan", "--serve", "--host", "0.0.0.0", "--port", "0"], {
        cwd: FIXTURE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout.on("data", () => {});
      proc.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString("utf-8");
      });

      const earlyExit = new Promise<never>((_, reject) => {
        proc.once("exit", (code) => {
          reject(new Error(`server exited early with code ${code}; stderr so far: ${stderrBuf}`));
        });
      });

      const waitForServing = (async (): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (/serving at/.test(stderrBuf)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(
          `did not see a "serving at" line within budget; stderr so far: ${stderrBuf}`,
        );
      })();
      await Promise.race([waitForServing, earlyExit]);

      expect(stderrBuf).toContain("warning: binding to 0.0.0.0 exposes the graph to your network");

      proc.kill("SIGINT");
      const code = await waitExit(proc, 3000);
      expect(code).toBe(0);
    },
  );

  // PR #346 review (M2) — replaces a unit test in tests/cli.test.ts that
  // paired `--serve` with a deliberately-invalid `--port abc`: `parsePort`
  // rejects that at PARSE time, so the process exits before the action (and
  // the C8 "--port/--host are ignored without --serve" check) ever runs —
  // the old test had no discriminating power, since it could not fail
  // regardless of what the C8 logic did. This drives a real `--serve`
  // startup with VALID `--port`/`--host` (so the action, and the C8 check,
  // actually execute) and asserts the ignored-without-`--serve` warning
  // never fires — same spawn pattern as the C6 test above, using the
  // "serving at" line as the startup-complete signal and inspecting stderr
  // accumulated up to that point.
  it(
    "C8: --serve --port 0 --host 127.0.0.1 does not warn that --port/--host are ignored",
    { timeout: 15000 },
    async () => {
      let stderrBuf = "";
      const proc = spawn("node", [CLI, "scan", "--serve", "--port", "0", "--host", "127.0.0.1"], {
        cwd: FIXTURE_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout.on("data", () => {});
      proc.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString("utf-8");
      });

      const earlyExit = new Promise<never>((_, reject) => {
        proc.once("exit", (code) => {
          reject(new Error(`server exited early with code ${code}; stderr so far: ${stderrBuf}`));
        });
      });

      const waitForServing = (async (): Promise<void> => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (/serving at/.test(stderrBuf)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(
          `did not see a "serving at" line within budget; stderr so far: ${stderrBuf}`,
        );
      })();
      await Promise.race([waitForServing, earlyExit]);

      expect(stderrBuf).not.toContain("ignored");

      proc.kill("SIGINT");
      const code = await waitExit(proc, 3000);
      expect(code).toBe(0);
    },
  );
});
