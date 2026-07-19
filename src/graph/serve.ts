import { createServer, type Server } from "node:http";
import { isIPv6 } from "node:net";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { RenderData } from "./render.js";
import { renderTemplate } from "../template.js";

export interface ServeOptions {
  data: RenderData;
  port?: number;
  host?: string;
}

export interface ServeHandle {
  url: string;
  close(): Promise<void>;
}

export interface ExportOptions {
  data: RenderData;
  outputDir: string;
  /**
   * Overwrite `outputDir` even if it contains files artgraph doesn't manage
   * (issue #170 D1). Without this, `writeStaticExport` refuses to write into
   * a non-empty, non-artgraph-owned directory.
   */
  force?: boolean;
}

const DEFAULT_PORT = 3737;
const DEFAULT_HOST = "127.0.0.1";

// issue #172 (C4/C5/C7) — the URL printed by `scan --serve` used to be a
// bare `http://${host}:${port}` string built from the REQUESTED host/port,
// which was wrong in three ways this helper fixes:
//   (C5) an IPv6 host (`::1`, a literal address, …) needs `[...]` bracketing
//        in a URL — `http://::1:3737` is not a valid authority, the colons
//        collide with the port separator.
//   (C7) `0.0.0.0` (IPv4 "all interfaces") and `::` (and its equivalent
//        spellings — see `isUnspecifiedHost` below) (IPv6 "all interfaces")
//        are valid BIND addresses but not valid addresses to actually
//        connect back to from the machine that just started the server —
//        display the loopback equivalent instead. This is a DISPLAY-ONLY
//        substitution: the caller still binds to the literal host it was
//        given (see `startServer` below) — only the printed/returned URL
//        text is adjusted.
//   (C4) `port` here must be the ACTUALLY bound port, not the requested one
//        — the caller is responsible for passing `server.address()`'s port
//        (relevant for `--port 0`, where the OS picks a free port).

// PR #346 review (M1) — the C6 network-exposure warning below and this
// function's C7 display substitution used to key on an exact-string match
// against `"0.0.0.0"` / `"::"` only, so equivalent IPv6 "all interfaces"
// spellings (`::0`, `0:0:0:0:0:0:0:0`,
// `0000:0000:0000:0000:0000:0000:0000:0000`, …) — which bind identically to
// `::` — silently skipped both the warning and the display fix. `net.isIPv6`
// accepts every one of these spellings; this helper additionally checks that
// every colon-separated segment is either empty (the `::` zero-run
// shorthand) or parses as the literal number 0, which holds for every
// spelling of the IPv6 unspecified address.
//
// IPv4-mapped IPv6 forms (`::ffff:0.0.0.0`) are deliberately NOT covered:
// they're a rare spelling, and it isn't confirmed that `server.listen()`
// binds them the same all-interfaces way as literal `::`/`0.0.0.0` — folding
// them in risks a wrong warning/substitution rather than a merely missing
// one, so they're left as a known gap rather than guessed at. (As a side
// effect, the last segment of an IPv4-mapped address is dotted-decimal, e.g.
// `0.0.0.0`, which `Number(...)` doesn't parse as `0` — so this check
// naturally falls through to `false` for those forms without special-casing
// them.)
export function isUnspecifiedHost(host: string): boolean {
  if (host === "0.0.0.0") return true;
  if (!isIPv6(host)) return false;
  return host.split(":").every((segment) => segment === "" || Number(segment) === 0);
}

export function formatServeUrl(host: string, port: number): string {
  let displayHost = host;
  if (isUnspecifiedHost(host)) {
    displayHost = host === "0.0.0.0" ? "127.0.0.1" : "::1";
  }
  const authorityHost = isIPv6(displayHost) ? `[${displayHost}]` : displayHost;
  return `http://${authorityHost}:${port}`;
}

// `dist/graph/serve.js` → `dist/graph/../../templates/graph` = `<root>/templates/graph`.
// At dev time (vitest reads src directly), `src/graph/serve.ts` → same relative
// path resolves to `<root>/templates/graph`. Both paths converge on the packaged
// templates dir.
const TEMPLATE_DIR = resolve(import.meta.dirname, "../../templates/graph");
const INDEX_HTML_PATH = resolve(TEMPLATE_DIR, "index.html");
const APP_JS_PATH = resolve(TEMPLATE_DIR, "app.js");
const VENDOR_JS_PATH = resolve(TEMPLATE_DIR, "vendor/cytoscape.min.js");
// Cytoscape's MIT notice must accompany every redistributed copy of the
// bundle, so static exports copy it alongside cytoscape.min.js.
const VENDOR_LICENSE_PATH = resolve(TEMPLATE_DIR, "vendor/cytoscape.LICENSE");

// The JSON payload is embedded verbatim inside `<script type="application/json">`.
// A literal `</script>` in the data (e.g. a filePath containing `</`, or any
// string with `<`) would terminate the script tag despite the type attribute,
// so we escape every `<` as its unicode form. Cheaper than a full JSON walk
// and defensively safe on any input.
function encodeEmbeddedJson(data: RenderData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function readIndexHtml(data: RenderData): string {
  if (!existsSync(INDEX_HTML_PATH)) {
    throw new Error(
      `artgraph graph: template not found at ${INDEX_HTML_PATH}. Did the package ship without templates?`,
    );
  }
  if (!existsSync(VENDOR_JS_PATH)) {
    throw new Error(
      `artgraph graph: cytoscape vendor asset missing at ${VENDOR_JS_PATH}. Run \`pnpm build\` (the prebuild step copies it into templates/graph/vendor/).`,
    );
  }
  // Wrap the raw read so a TOCTOU between existsSync and readFileSync (e.g.
  // a concurrent chmod) surfaces as the same hint-bearing error the caller
  // gets for a missing file. Without this, ENOENT/EACCES leaks a bare
  // `Error: EACCES: permission denied, open '<path>'` and the CLI prints it
  // verbatim — accurate but not actionable.
  let html: string;
  try {
    html = readFileSync(INDEX_HTML_PATH, "utf-8");
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(
      `artgraph graph: failed to read template at ${INDEX_HTML_PATH} (${cause}). Did the package ship without templates?`,
    );
  }
  return renderTemplate(html, { ARTGRAPH_DATA: encodeEmbeddedJson(data) });
}

// Same wrap as `readIndexHtml` for the two static assets so the CLI can
// print a message that names the file *and* points at the fix (rerun the
// prebuild copy). Errors here fail startServer before we listen, so the
// user sees the hint on stderr rather than the client seeing a partial
// response — see A1/A3/A7 in the PR #155 meta review.
function readStaticAsset(path: string, name: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(
      `artgraph graph: failed to read ${name} at ${path} (${cause}). Run \`pnpm build\` (the prebuild step copies templates/graph/).`,
    );
  }
}

export async function startServer(opts: ServeOptions): Promise<ServeHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;

  // issue #172 (C6) — binding to every interface (`0.0.0.0`/`::` and their
  // equivalent spellings, see `isUnspecifiedHost` above) exposes this server
  // (no auth, arbitrary graph data) to the whole LAN, not just localhost.
  // `--host` is opt-in, so this is a heads-up, not a refusal.
  if (isUnspecifiedHost(host)) {
    console.error(`warning: binding to ${host} exposes the graph to your network`);
  }

  // Read and cache all four static payloads at startup:
  //   - fail-fast: a missing template kills startup with a clear message
  //     instead of 500-ing on first request (and thanks to A3, doing so
  //     after writeHead(200) which left the client with an empty body).
  //   - crash-proofs the request handler: no per-request I/O, so a mid-run
  //     `chmod 000` on templates/ can't kill the process (A1).
  //   - trivial memory cost (~500KB total; vendor dominates at ~425KB).
  const html = readIndexHtml(opts.data);
  const appJs = readStaticAsset(APP_JS_PATH, "app.js");
  const vendorJs = readStaticAsset(VENDOR_JS_PATH, "cytoscape.min.js");
  const vendorLicense = readStaticAsset(VENDOR_LICENSE_PATH, "cytoscape.LICENSE");

  return new Promise<ServeHandle>((resolvePromise, reject) => {
    // Tracks the promise lifecycle so post-listen errors don't try to
    // reject an already-resolved promise (A5). Node silently drops
    // rejections on settled promises, which turned into an
    // impossible-to-observe silent failure mode.
    let phase: "pending" | "listening" | "closing" = "pending";

    const server: Server = createServer((req, res) => {
      // Belt-and-suspenders: with assets pre-loaded, no known code path
      // throws here — but a future edit that reintroduces per-request I/O
      // (or a Node internal that throws on write) must not kill the
      // process. `res.headersSent` picks the right recovery status.
      try {
        // Client abort during a large body write emits `error` on the
        // Writable. Without a listener, EventEmitter throws synchronously
        // and the whole server dies (A4). We don't need the payload — just
        // absorb it so the socket teardown is graceful.
        req.on("error", () => {});
        res.on("error", () => {});

        const url = req.url ?? "/";
        if (url === "/" || url === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(html);
          return;
        }
        if (url === "/app.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(appJs);
          return;
        }
        if (url === "/vendor/cytoscape.min.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          res.end(vendorJs);
          return;
        }
        if (url === "/vendor/cytoscape.LICENSE") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(vendorLicense);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
      } catch (err) {
        // Headers may already be on the wire; only touch writeHead if the
        // socket still lets us. `res.end` is guarded against the socket
        // being fully torn down.
        if (!res.headersSent) {
          try {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          } catch {
            // Socket died between the check and the write — nothing to do.
          }
        }
        try {
          res.end("Internal Server Error");
        } catch {
          // Socket already gone.
        }
        console.error(
          `artgraph graph: handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    // Malformed HTTP frames (e.g. `curl --http1.0` with garbage) surface
    // as socket-level `clientError`. Without a handler Node's default
    // sends 400 and destroys — fine — but registering explicitly means
    // any listener we add later (metrics, logging) has a hook.
    server.on("clientError", (_err, socket) => {
      try {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      } catch {
        // Socket already dead — nothing to do.
      }
    });

    // Default keep-alive is 5s in Node 22. On SIGINT that's a 5-second
    // stall before `server.close()` drains idle sockets. Shortening to 1s
    // is safe for a local dev tool and makes Ctrl+C snappy (Meta-A-α).
    server.keepAliveTimeout = 1000;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (phase === "pending") {
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `artgraph graph: address ${host}:${port} is already in use. Pass \`--port <n>\` to pick a different port.`,
            ),
          );
        } else {
          reject(err);
        }
        return;
      }
      // Post-listen: the promise is already settled, so `reject` here is
      // a no-op that would silently swallow the error (A5). Log to stderr
      // so the operator running --serve at least sees the failure.
      console.error(`artgraph graph: server error after listen: ${err.message}`);
    });

    server.listen(port, host, () => {
      phase = "listening";
      // issue #172 (C4) — read back the ACTUALLY bound port from the OS
      // rather than echoing the requested `port` value: with `--port 0` the
      // OS assigns a free ephemeral port, and the pre-fix code printed
      // "serving at http://host:0", which is not a URL anyone can visit.
      const address = server.address();
      // PR #346 review (L1) — the `: port` half of this fallback is
      // unreachable in practice: inside `server.listen()`'s own callback,
      // `server.address()` always returns a populated `AddressInfo` (never
      // `null`/a string), so `typeof address === "object"` is always true
      // here. This is defensive-for-the-type-checker code, not a live
      // branch — TypeScript's declared return type for `address()` is wider
      // than what's actually possible at this specific call site. If it were
      // ever somehow reached, it would display the REQUESTED port (`0` for
      // `--port 0`) rather than the actual bound port — silently
      // reintroducing the exact C4 bug this fallback's sibling branch
      // exists to fix. Known, accepted limitation of an unreachable path,
      // not something worth guarding further.
      const actualPort = address && typeof address === "object" ? address.port : port;
      const url = formatServeUrl(host, actualPort);
      resolvePromise({
        url,
        close(): Promise<void> {
          phase = "closing";
          return new Promise((resolveClose, rejectClose) => {
            // A bare `server.close()` waits for keep-alive sockets to go
            // idle before firing its callback. Browsers hold those open
            // and re-use them within Node's 5s keep-alive window, so the
            // callback never fires and Ctrl+C hangs (A2). Node ≥18.2
            // exposes these two escape hatches — engines.node ≥22 in this
            // repo, so no runtime guard is needed, but the optional call
            // stays defensive.
            server.closeIdleConnections?.();
            // Give any in-flight request a brief window to finish before
            // yanking their sockets. 500ms is plenty on localhost.
            const graceMs = 500;
            const timer = setTimeout(() => {
              server.closeAllConnections?.();
            }, graceMs);
            server.close((closeErr) => {
              clearTimeout(timer);
              if (closeErr) rejectClose(closeErr);
              else resolveClose();
            });
          });
        },
      });
    });
  });
}

const MANAGED_OUTPUT_ENTRIES = new Set(["index.html", "app.js", "vendor"]);

// D1 (issue #170): `writeStaticExport` used to overwrite index.html / app.js /
// vendor/cytoscape.min.js unconditionally, so pointing `--output` at the wrong
// directory (GitHub Pages' `docs/`, or repo root) could silently replace
// unrelated files — confirmed in practice against a dir containing
// `USER-IMPORTANT-INDEX.md`. This lists anything at the top level of
// `outputDir` that isn't one of the three artgraph-managed paths so the
// caller can refuse unless `--force`. `vendor` only counts as managed when it
// is actually a directory — a file/symlink squatting on that name is
// suspicious and gets flagged too.
function findUnmanagedTopLevelEntries(outputDir: string): string[] {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir).filter((entry) => {
    if (entry !== "vendor") return !MANAGED_OUTPUT_ENTRIES.has(entry);
    return !lstatSync(resolve(outputDir, entry)).isDirectory();
  });
}

export async function writeStaticExport(opts: ExportOptions): Promise<void> {
  const { data, outputDir, force } = opts;

  const unmanaged = findUnmanagedTopLevelEntries(outputDir);
  if (unmanaged.length > 0 && !force) {
    throw new Error(
      `artgraph scan: ${outputDir} contains file(s) artgraph doesn't manage (${unmanaged.join(", ")}). ` +
        "Pass --force to overwrite anyway, or point --output at an empty/dedicated directory.",
    );
  }

  const html = readIndexHtml(data);
  // Fail before any writes (same fail-fast contract as readIndexHtml's vendor
  // check) so a half-written export never lands on disk.
  if (!existsSync(VENDOR_LICENSE_PATH)) {
    throw new Error(
      `artgraph graph: cytoscape license notice missing at ${VENDOR_LICENSE_PATH}. ` +
        "Run `pnpm build` (the prebuild step copies it into templates/graph/vendor/).",
    );
  }
  mkdirSync(outputDir, { recursive: true });

  // D2 (issue #170): once we get here, vendor/ is entirely artgraph-owned —
  // wipe it before rewriting instead of layering the current cytoscape build
  // on top of whatever an older artgraph version left behind (e.g. a
  // differently-named vendor bundle from a prior release). Keeps repeated
  // `--output` runs in a CI pipe from accumulating stale vendor artifacts.
  // `rmSync` doesn't follow symlinks, so a `vendor` symlink is unlinked, not
  // traversed, before `mkdirSync` recreates it as a real directory.
  const vendorDir = resolve(outputDir, "vendor");
  rmSync(vendorDir, { recursive: true, force: true });
  mkdirSync(vendorDir, { recursive: true });

  writeFileSync(resolve(outputDir, "index.html"), html, "utf-8");
  copyFileSync(APP_JS_PATH, resolve(outputDir, "app.js"));
  copyFileSync(VENDOR_JS_PATH, resolve(vendorDir, "cytoscape.min.js"));
  copyFileSync(VENDOR_LICENSE_PATH, resolve(vendorDir, "cytoscape.LICENSE"));
}
