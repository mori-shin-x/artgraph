import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
}

const DEFAULT_PORT = 3737;
const DEFAULT_HOST = "127.0.0.1";

// `dist/graph/serve.js` → `dist/graph/../../templates/graph` = `<root>/templates/graph`.
// At dev time (vitest reads src directly), `src/graph/serve.ts` → same relative
// path resolves to `<root>/templates/graph`. Both paths converge on the packaged
// templates dir.
const TEMPLATE_DIR = resolve(import.meta.dirname, "../../templates/graph");
const INDEX_HTML_PATH = resolve(TEMPLATE_DIR, "index.html");
const APP_JS_PATH = resolve(TEMPLATE_DIR, "app.js");
const VENDOR_JS_PATH = resolve(TEMPLATE_DIR, "vendor/cytoscape.min.js");

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
  const html = readFileSync(INDEX_HTML_PATH, "utf-8");
  return renderTemplate(html, { ARTGRAPH_DATA: encodeEmbeddedJson(data) });
}

export function startServer(opts: ServeOptions): Promise<ServeHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;

  // Render the HTML up-front so a template/vendor issue fails fast instead of
  // 500-ing on the first request. `app.js` and the vendor bundle are read
  // per-request — they're small and this is a local dev tool, no need to cache.
  const html = readIndexHtml(opts.data);

  return new Promise<ServeHandle>((resolvePromise, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (url === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(readFileSync(APP_JS_PATH));
        return;
      }
      if (url === "/vendor/cytoscape.min.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(readFileSync(VENDOR_JS_PATH));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `artgraph graph: address ${host}:${port} is already in use. Pass \`--port <n>\` to pick a different port.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      resolvePromise({
        url,
        close(): Promise<void> {
          return new Promise((resolveClose, rejectClose) => {
            server.close((closeErr) => {
              if (closeErr) rejectClose(closeErr);
              else resolveClose();
            });
          });
        },
      });
    });
  });
}

export async function writeStaticExport(opts: ExportOptions): Promise<void> {
  const { data, outputDir } = opts;
  const html = readIndexHtml(data);
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(resolve(outputDir, "vendor"), { recursive: true });
  writeFileSync(resolve(outputDir, "index.html"), html, "utf-8");
  copyFileSync(APP_JS_PATH, resolve(outputDir, "app.js"));
  copyFileSync(VENDOR_JS_PATH, resolve(outputDir, "vendor/cytoscape.min.js"));
}
