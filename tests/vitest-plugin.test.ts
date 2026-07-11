// spec 021 (tasks.md T006 — Red; made Green by T007's src/vitest/plugin.ts)
// — unit tests calling the trace-instrumentation Vite plugin's `transform`
// hook directly (not through a real Vite pipeline). Covers tasks.md T006's
// full bullet list: the V4 naming table (functions/arrows/methods/getters/
// setters/object-literal members, export forms, computed/anonymous
// exclusions), insertion structure (line-count/content preservation,
// sourcemap), V5 hash-from-disk, exclusion rules, fail-soft parse handling,
// the zero-function boundary, and contracts/instrumentation-runtime.md's
// preamble obligations 3-5.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import artgraphTracePlugin, {
  buildPreamble,
  HITS_VAR,
  type ArtgraphTracePlugin,
} from "../src/vitest/plugin.js";
import { REGISTRY_KEY, hashContent } from "../src/trace/schema.js";

let tmpRoot: string;
let execDir: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-vitest-plugin-test-"));
  execDir = mkdtempSync(join(tmpdir(), "artgraph-vitest-plugin-exec-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(execDir, { recursive: true, force: true });
});

function makePlugin(root = tmpRoot): ArtgraphTracePlugin {
  const plugin = artgraphTracePlugin();
  plugin.configResolved({ root });
  return plugin;
}

// Writes fixture source under tmpRoot (so relPath computation + exclusion
// rules exercise the real root-relative path), returns its absolute path.
function writeFixture(relPath: string, content: string): string {
  const abs = join(tmpRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

// Writes transformed output to its OWN unique `.mjs` file and dynamically
// imports it — real V8/Node module evaluation, not string inspection. The
// execute location is independent of the fixture's location: the
// registration's `file` key was already baked into the emitted text at
// transform time (relative to `root`), so where we actually run the code
// from doesn't matter.
async function importTransformed(code: string): Promise<Record<string, unknown>> {
  const file = join(execDir, `out-${randomUUID()}.mjs`);
  writeFileSync(file, code, "utf-8");
  return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
}

interface ModuleRegistrationLike {
  file: string;
  hash: string;
  fns: string[];
  hits: Uint8Array;
}
interface TraceRegistryLike {
  version: number;
  modules: Map<string, ModuleRegistrationLike>;
}

function registryOf(): TraceRegistryLike | undefined {
  return (globalThis as unknown as Record<string, TraceRegistryLike | undefined>)[REGISTRY_KEY];
}

function extractFns(code: string): string[] {
  const m = code.match(/fns:(\[[^\]]*\])/);
  return m ? (JSON.parse(m[1]!) as string[]) : [];
}

function extractHash(code: string): string | undefined {
  return code.match(/hash:"([0-9a-f]{16})"/)?.[1];
}

describe("naming table (research.md V4) + registration, end-to-end via real execution", () => {
  const relPath = "src/mega.js";
  const source = [
    "function topLevelFn() { return 1; }",
    "",
    "export default function namedDefault() { return 2; }",
    "",
    "export function exportedFn() { return 3; }",
    "",
    "const arrowVar = (x) => { return x + 1; };",
    "",
    "const arrowConcise = (x) => x + 2;",
    "",
    "let letFn = function () { return 4; };",
    "",
    "const namedExprVar = function innerName() { return 13; };",
    "",
    'function computedKeyName() { return "dyn"; }',
    "",
    "class Widget {",
    "  static instances = 0;",
    "  constructor() { this.ready = true; }",
    "  method() { return 5; }",
    "  get value() { return 6; }",
    "  set value(v) { this._v = v; }",
    "  fieldFn = () => { return 7; };",
    "}",
    "",
    "const obj = {",
    "  method() { return 8; },",
    "  prop: function () { return 9; },",
    "  get accessor() { return 10; },",
    "  [computedKeyName()]() { return 11; },",
    "};",
    "",
    "function outer() {",
    "  function inner() { return 12; }",
    "  return inner();",
    "}",
    "",
    "function callsAnonymous(cb) { return cb(); }",
    "",
    "export function run() {",
    "  topLevelFn();",
    "  exportedFn();",
    "  arrowVar(1);",
    "  arrowConcise(1);",
    "  letFn();",
    "  namedExprVar();",
    "  const w = new Widget();",
    "  w.method();",
    "  void w.value;",
    "  w.value = 1;",
    "  w.fieldFn();",
    "  obj.method();",
    "  obj.prop();",
    "  void obj.accessor;",
    '  obj["dyn"]();',
    "  outer();",
    "  callsAnonymous(() => 99);",
    "  callsAnonymous(function () { return 100; });",
    "}",
    "",
  ].join("\n");

  const expectedNames = [
    "topLevelFn",
    "namedDefault", // export default function NAMED — own name wins over "default"
    "exportedFn",
    "arrowVar",
    "arrowConcise",
    // letFn: `let letFn = function () {}` — anonymous function expression
    // assigned via `let` — variable-name naming rule applies the same as
    // `const`.
    "letFn",
    "innerName", // named function EXPRESSION — own name wins over variable name "namedExprVar"
    "computedKeyName",
    "Widget", // constructor -> class name (V8-compatible)
    "method", // Widget.method
    "value", // getter
    "value", // setter — independent slot, same name
    "fieldFn", // class field arrow (PropertyDefinition)
    "method", // obj.method — independent slot, same name as Widget.method
    "prop", // obj.prop: function(){}
    "accessor", // obj get accessor
    "outer",
    "inner", // nested named function
    "callsAnonymous",
    "run",
  ];

  let plugin: ArtgraphTracePlugin;
  let code: string;

  beforeAll(async () => {
    plugin = makePlugin();
    const abs = writeFixture(relPath, source);
    const result = plugin.transform(source, abs);
    expect(result).toBeDefined();
    code = result!.code;
  });

  it("registers exactly the statically-nameable functions (computed keys / anonymous callbacks excluded)", () => {
    const fns = extractFns(code);
    expect(fns.length).toBe(expectedNames.length);
    expect([...fns].sort()).toEqual([...expectedNames].sort());
  });

  it("flips every registered slot's hit after real execution (own-name precedence, hoisting, constructor naming all actually run)", async () => {
    const mod = await importTransformed(code);
    (mod.default as () => void)();
    (mod.run as () => void)();

    const reg = registryOf()?.modules.get(relPath);
    expect(reg).toBeDefined();
    expect(reg!.fns.length).toBe(reg!.hits.length);
    for (let i = 0; i < reg!.hits.length; i++) {
      expect(reg!.hits[i], `slot ${i} ("${reg!.fns[i]}") never hit`).toBeGreaterThan(0);
    }
  });
});

describe('anonymous default export (function/arrow) -> "default" (V4)', () => {
  it('names an anonymous default-exported function "default"', () => {
    const plugin = makePlugin();
    const src = "export default function () { return 1; }\n";
    const abs = writeFixture("src/anon-default-fn.js", src);
    const result = plugin.transform(src, abs);
    expect(extractFns(result!.code)).toEqual(["default"]);
  });

  it('names an anonymous default-exported concise arrow "default"', () => {
    const plugin = makePlugin();
    const src = "export default (x) => x + 1;\n";
    const abs = writeFixture("src/anon-default-arrow.js", src);
    const result = plugin.transform(src, abs);
    expect(extractFns(result!.code)).toEqual(["default"]);
  });
});

describe("insertion structure (contract 書き手義務 1-2, 観点1)", () => {
  it("preserves line count and every existing line's content exactly (block-bodied fixture)", () => {
    const plugin = makePlugin();
    const src = [
      "function a() {",
      "  return 1;",
      "}",
      "",
      "class C {",
      "  method() {",
      "    return 2;",
      "  }",
      "}",
      "",
      "const b = (x) => {",
      "  return x;",
      "};",
      "",
    ].join("\n");
    const abs = writeFixture("src/structure.js", src);
    const result = plugin.transform(src, abs)!;

    expect(result.code.split("\n").length).toBe(src.split("\n").length);

    const preamble = buildPreamble(
      "src/structure.js",
      extractHash(result.code)!,
      extractFns(result.code),
    );
    expect(result.code.startsWith(preamble)).toBe(true);
    let rest = result.code.slice(preamble.length);
    const fns = extractFns(result.code);
    for (let i = 0; i < fns.length; i++) {
      const marker = `${HITS_VAR}[${i}]=1;`;
      const idx = rest.indexOf(marker);
      expect(idx, `store marker for slot ${i} not found`).toBeGreaterThanOrEqual(0);
      rest = rest.slice(0, idx) + rest.slice(idx + marker.length);
    }
    expect(rest).toBe(src);
  });

  it("preserves line count for a fixture using concise-arrow bodies too", () => {
    const plugin = makePlugin();
    const src = ["const f = (x) => x + 1;", "const g = (x) => ({ x });", ""].join("\n");
    const abs = writeFixture("src/structure-concise.js", src);
    const result = plugin.transform(src, abs)!;
    expect(result.code.split("\n").length).toBe(src.split("\n").length);
  });

  it("returns a sourcemap (magic-string generateMap, hires: boundary)", () => {
    const plugin = makePlugin();
    const src = "export function f() { return 1; }\n";
    const abs = writeFixture("src/sourcemap.js", src);
    const result = plugin.transform(src, abs)!;
    const map = result.map as { version: number; mappings: string };
    expect(map).toBeDefined();
    expect(map.version).toBe(3);
    expect(typeof map.mappings).toBe("string");
  });

  it("preamble contains no import/require statement (contract 書き手義務 1)", () => {
    const preamble = buildPreamble("src/x.js", "0".repeat(16), ["f"]);
    expect(preamble).not.toMatch(/\bimport\b/);
    expect(preamble).not.toMatch(/\brequire\(/);
  });
});

describe("hash (V5, 観点1): computed from disk content, not the `code` argument", () => {
  it("hashes disk content with a UTF-8 BOM stripped, matching schema.ts's hashContent", () => {
    const plugin = makePlugin();
    const bom = "﻿";
    const src = `${bom}export function f() { return 1; }\n`;
    const abs = writeFixture("src/bom.js", src);
    const result = plugin.transform(src, abs)!;
    expect(extractHash(result.code)).toBe(hashContent(src));
  });

  it("hashes CRLF disk content exactly as read (no normalization)", () => {
    const plugin = makePlugin();
    const src = "export function f() {\r\n  return 1;\r\n}\r\n";
    const abs = writeFixture("src/crlf.js", src);
    const result = plugin.transform(src, abs)!;
    expect(extractHash(result.code)).toBe(hashContent(src));
  });

  it("hashes the ON-DISK original source, not a `code` argument a prior pre-plugin already rewrote", () => {
    const plugin = makePlugin();
    const diskSrc = "export function f() { return 1; }\n";
    const abs = writeFixture("src/pre-plugin.js", diskSrc);
    // Simulate an upstream `enforce: 'pre'` plugin ahead of this one having
    // already rewritten `code` — same function shape, different bytes.
    const rewrittenCode = "export function f() { /* rewritten */ return 1; }\n";
    const result = plugin.transform(rewrittenCode, abs)!;
    expect(extractHash(result.code)).toBe(hashContent(diskSrc));
    expect(extractHash(result.code)).not.toBe(hashContent(rewrittenCode));
  });
});

describe("exclusion (contracts/config-surface.md §plugin の適用範囲, 観点1) — silent no-op", () => {
  it("does not transform a test file, and does not warn", () => {
    const plugin = makePlugin();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const src = 'import { it } from "vitest";\nit("x", () => { function f() {} });\n';
    const abs = writeFixture("src/thing.test.js", src);
    expect(plugin.transform(src, abs)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not transform a node_modules module, and does not warn", () => {
    const plugin = makePlugin();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const src = "export function f() { return 1; }\n";
    const abs = writeFixture("node_modules/pkg/index.js", src);
    expect(plugin.transform(src, abs)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not transform a module resolved outside the project root", () => {
    const plugin = makePlugin();
    const outsideDir = mkdtempSync(join(tmpdir(), "artgraph-vitest-plugin-outside-"));
    try {
      const abs = join(outsideDir, "outside.js");
      const src = "export function f() { return 1; }\n";
      writeFileSync(abs, src, "utf-8");
      expect(plugin.transform(src, abs)).toBeUndefined();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("DOES transform a directory that merely starts with 'node_modules' (segment match, not substring — T003's exact boundary)", () => {
    const plugin = makePlugin();
    const src = "export function f() { return 1; }\n";
    const abs = writeFixture("my_node_modules/foo.js", src);
    const result = plugin.transform(src, abs);
    expect(result).toBeDefined();
    expect(extractFns(result!.code)).toEqual(["f"]);
  });
});

describe("fail-soft (contract §変換のスキップ, 観点4): unparseable source", () => {
  it("passes an unparseable module through untransformed, warning once to stderr — no warning on a second transform of the same module", () => {
    const plugin = makePlugin();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const broken = "function used( {\n  this is not valid javascript &&& ***\n";
    const abs = writeFixture("src/broken.js", broken);

    const first = plugin.transform(broken, abs);
    expect(first).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    const second = plugin.transform(broken, abs);
    expect(second).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1); // still one — de-duped per module

    warn.mockRestore();
  });
});

describe("boundary (観点1・6): a module with zero statically-nameable functions is untransformed and unregistered", () => {
  it("leaves an empty file untransformed", () => {
    const plugin = makePlugin();
    const abs = writeFixture("src/empty.js", "");
    expect(plugin.transform("", abs)).toBeUndefined();
  });

  it("leaves a file with only non-function top-level code untransformed", () => {
    const plugin = makePlugin();
    const src = "export const x = 1 + 2;\nexport const y = { a: 1, b: 2 };\n";
    const abs = writeFixture("src/no-fns.js", src);
    expect(plugin.transform(src, abs)).toBeUndefined();
  });

  it("does not warn for the zero-function boundary (it's not a parse failure)", () => {
    const plugin = makePlugin();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const abs = writeFixture("src/empty2.js", "");
    plugin.transform("", abs);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("contracts/instrumentation-runtime.md §preamble の義務 3-5", () => {
  it("obligation 3: the entry stamp is a single branchless store, `<HITS_VAR>[k]=1;`, landing immediately after the opening brace", () => {
    const plugin = makePlugin();
    const src = "function a() { return 1; }\nfunction b() { return 2; }\n";
    const abs = writeFixture("src/obl3.js", src);
    const result = plugin.transform(src, abs)!;
    expect(result.code).toContain(`{${HITS_VAR}[0]=1;`);
    expect(result.code).toContain(`{${HITS_VAR}[1]=1;`);
    for (const store of result.code.match(new RegExp(`${HITS_VAR}\\[\\d+\\]=1;`, "g")) ?? []) {
      expect(store).not.toMatch(/if|&&|\?/);
    }
  });

  it("obligation 4: the preamble contains no `await` / `import.meta` (ESM/CJS-evaluable) and is a single line", () => {
    const preamble = buildPreamble("src/x.js", "0".repeat(16), ["f", "g"]);
    expect(preamble).not.toMatch(/\bawait\b/);
    expect(preamble).not.toMatch(/import\.meta/);
    expect(preamble.includes("\n")).toBe(false);
  });

  it("obligation 5: a hoisted FunctionDeclaration's entry stamp resolves the preamble-defined hits variable at call time", async () => {
    const plugin = makePlugin();
    const relPath = "src/hoisting.js";
    // `laterFn` is called from `run` (textually earlier) but only exists via
    // FunctionDeclaration hoisting — its stamp must still reference the
    // SAME preamble-defined `<HITS_VAR>` const, correctly in scope by the
    // time it actually runs (after the whole module — including the
    // preamble's first line — has evaluated).
    const src = [
      "export function run() { return laterFn(); }",
      "",
      "function laterFn() { return 42; }",
      "",
    ].join("\n");
    const abs = writeFixture(relPath, src);
    const result = plugin.transform(src, abs)!;

    const mod = await importTransformed(result.code);
    expect((mod.run as () => number)()).toBe(42);

    const reg = registryOf()?.modules.get(relPath);
    expect(reg).toBeDefined();
    const laterFnSlot = reg!.fns.indexOf("laterFn");
    expect(laterFnSlot).toBeGreaterThanOrEqual(0);
    expect(reg!.hits[laterFnSlot]).toBeGreaterThan(0);
  });
});
