import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTSParser, parseTSFilePaths, hash } from "../src/parsers/typescript.js";
import type { ParsedTS } from "../src/parsers/typescript.js";

// Regression tests pinning the oxc-parser TS extraction layer (issue #159).
//
// HISTORY: in phase 1 these inputs were run through BOTH the ts-morph backend
// and the oxc backend and asserted deep-equal (commit eaf7cf1,
// tests/typescript-differential.test.ts). With ts-morph removed, the
// empirically-verified behavior is pinned here as EXPLICIT expected values —
// each block documents one compatibility finding from that differential run:
//
//   R1  extension probe priority (.ts > .tsx > .d.ts > .js > .jsx) and the
//       .tsx SHADOWING rule (probed even without jsx, discarding the match
//       and hiding lower-priority candidates)
//   R2  .mjs/.cjs substitution, exact-extension specs, json modules
//   R3  directory resolution: index probing, package.json types/typings/main
//       (a present-but-broken "types" suppresses "main")
//   R4  script (non-module) targets yield NO import edge
//   R5  only jsx / allowJs / resolveJsonModule affect resolution (JSONC
//       tsconfig + extends chain included); moduleResolution and
//       package.json "type" do not
//   R6  getExportedDeclarations iteration order — the TS binder binds
//       top-level FUNCTION statements first (bindEachFunctionsFirst), then
//       everything else in source order
//   R7  per-declaration-kind getText() spans behind symbol contentHash
//       (statement text incl. `export` for functions/classes/…, declarator
//       `x = 1` for variables, leaf BindingElements for destructuring,
//       expression node for `export default <expr>`)
//   R8  file enumeration order (legacy DirectoryCache BFS: orphan roots in
//       pattern insertion order, sorted children/files)
//   R9  UTF-8 BOM stripping before hashing
//   R10 `export {} from "./x"` still produces an import edge
//   R11 files with fatal syntax errors: no throw, import edges recovered
//       from oxc's module record, tag edges via regex; symbol nodes are NOT
//       recovered (known, documented divergence from the old backend)
//
// A failure here means the extraction layer's OUTPUT CONTRACT changed —
// which would churn every existing .trace.lock. Fix the implementation, not
// the expectation, unless the contract change is deliberate and release-noted.

function write(rootDir: string, relPath: string, content: string): void {
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function importTargets(parsed: ParsedTS, sourceRel: string): string[] {
  return parsed.edges
    .filter((e) => e.kind === "imports" && e.source === `file:${sourceRel}`)
    .map((e) => e.target);
}

function symbolsOf(parsed: ParsedTS, relPath: string): Array<{ id: string; contentHash: string }> {
  return parsed.nodes
    .filter((n) => n.kind === "symbol" && n.filePath === relPath)
    .map((n) => ({ id: n.id, contentHash: n.contentHash }));
}

function expectedSymbols(
  relPath: string,
  entries: Array<[name: string, declText: string]>,
): Array<{ id: string; contentHash: string }> {
  return entries.map(([name, text]) => ({
    id: `symbol:${relPath}#${name}`,
    contentHash: hash(text),
  }));
}

// ---------------------------------------------------------------------------
// R1–R5: relative specifier resolution
// ---------------------------------------------------------------------------

describe("oxc regression: relative import resolution (R1–R5)", () => {
  let root: string;

  const SPECIFIERS = [
    "./only-ts",
    "./only-ts.js",
    "./only-ts.ts",
    "./both",
    "./both.js",
    "./tsx-dts",
    "./tsx-dts.js",
    "./tsx-dts.jsx",
    "./only-tsx",
    "./only-tsx.tsx",
    "./only-dts",
    "./only-dts.js",
    "./only-dts.d.ts",
    "./only-js",
    "./only-js.js",
    "./js-dts",
    "./js-dts.js",
    "./js-and-ts.js",
    "./only-jsx",
    "./only-jsx.jsx",
    "./only-mts",
    "./only-mts.mjs",
    "./only-mts.js",
    "./mts-and-dmts.mjs",
    "./only-cts",
    "./only-cts.cjs",
    "./dir",
    "./dir/",
    "./dir/index.js",
    "./idx-tsx",
    "./file-vs-dir",
    "./dirjs.js",
    "./pkg-types",
    "./pkg-types-js",
    "./pkg-types-missing",
    "./pkg-main",
    "./pkg-main-noext",
    "./pkg-typings",
    "./pkg-broken-json",
    "./pkg-nofields",
    "./script",
    "./ambient",
    "./export-eq",
    "./data.json",
    "./data",
    "./missing",
    "./deep/nested.js",
    "..",
    "../",
    "./",
  ];

  // Expected resolution with jsx / allowJs / resolveJsonModule all OFF.
  // null = unresolved (no edge). Values are rootDir-relative target paths.
  const BASE_EXPECTED: Record<string, string | null> = {
    "./only-ts": "src/only-ts.ts",
    "./only-ts.js": "src/only-ts.ts",
    "./only-ts.ts": "src/only-ts.ts",
    "./both": "src/both.ts", // .ts beats .tsx
    "./both.js": "src/both.ts",
    // R1: the .tsx match is discarded without jsx AND shadows tsx-dts.d.ts
    "./tsx-dts": null,
    "./tsx-dts.js": null,
    "./tsx-dts.jsx": null,
    "./only-tsx": null,
    "./only-tsx.tsx": null,
    "./only-dts": "src/only-dts.d.ts",
    "./only-dts.js": "src/only-dts.d.ts",
    "./only-dts.d.ts": "src/only-dts.d.ts",
    "./only-js": null, // .js needs allowJs (and does NOT shadow)
    "./only-js.js": null,
    "./js-dts": "src/js-dts.d.ts",
    "./js-dts.js": "src/js-dts.d.ts",
    "./js-and-ts.js": "src/js-and-ts.ts",
    "./only-jsx": null,
    "./only-jsx.jsx": null,
    "./only-mts": null, // extensionless never probes .mts/.cts
    "./only-mts.mjs": "src/only-mts.mts", // R2: .mjs -> .mts / .d.mts
    "./only-mts.js": null, // .js does not map across module kinds
    "./mts-and-dmts.mjs": "src/mts-and-dmts.mts",
    "./only-cts": null,
    "./only-cts.cjs": "src/only-cts.cts",
    "./dir": "src/dir/index.ts",
    "./dir/": "src/dir/index.ts",
    "./dir/index.js": "src/dir/index.ts",
    "./idx-tsx": null, // index.tsx needs jsx
    "./file-vs-dir": "src/file-vs-dir.ts", // file beats directory
    "./dirjs.js": "src/dirjs.js/index.ts", // dir named x.js resolves via index
    "./pkg-types": "src/pkg-types/entry.d.ts", // R3: types beats entry.ts+index
    "./pkg-types-js": "src/pkg-types-js/entry.ts", // types "./entry.js" substitutes
    "./pkg-types-missing": "src/pkg-types-missing/index.ts", // broken types suppresses main
    "./pkg-main": "src/pkg-main/entry.ts", // main "./entry.js" substitutes
    "./pkg-main-noext": "src/pkg-main-noext/entry.ts",
    "./pkg-typings": "src/pkg-typings/t.d.ts",
    "./pkg-broken-json": "src/pkg-broken-json/index.ts",
    "./pkg-nofields": "src/pkg-nofields/index.ts",
    "./script": null, // R4: resolvable file, but not a module
    "./ambient": null, // ambient-module-only .d.ts is a script
    "./export-eq": "src/export-eq.ts", // `export =` counts as a module
    "./data.json": null, // needs resolveJsonModule
    "./data": null, // .json never probed for extensionless
    "./missing": null,
    "./deep/nested.js": "src/deep/nested.ts",
    "..": "index.ts", // parent dir -> its index
    "../": "index.ts",
    "./": null, // src/ has no index
  };

  const JSX_ALLOWJS_JSON_OVERRIDES: Record<string, string | null> = {
    "./tsx-dts": "src/tsx-dts.tsx",
    "./tsx-dts.js": "src/tsx-dts.tsx",
    "./tsx-dts.jsx": "src/tsx-dts.tsx",
    "./only-tsx": "src/only-tsx.tsx",
    "./only-tsx.tsx": "src/only-tsx.tsx",
    "./only-js": "src/only-js.js",
    "./only-js.js": "src/only-js.js",
    "./only-jsx": "src/only-jsx.jsx",
    "./only-jsx.jsx": "src/only-jsx.jsx",
    "./idx-tsx": "src/idx-tsx/index.tsx",
    "./data.json": "src/data.json",
  };

  function writeResolverLayout(dir: string): void {
    const mod = "export const v = 1;\n";
    write(dir, "src/only-ts.ts", mod);
    write(dir, "src/both.ts", mod);
    write(dir, "src/both.tsx", mod);
    write(dir, "src/tsx-dts.tsx", mod);
    write(dir, "src/tsx-dts.d.ts", "export declare const v: number;\n");
    write(dir, "src/only-tsx.tsx", mod);
    write(dir, "src/only-dts.d.ts", "export declare const v: number;\n");
    write(dir, "src/only-js.js", mod);
    write(dir, "src/js-dts.js", mod);
    write(dir, "src/js-dts.d.ts", "export declare const v: number;\n");
    write(dir, "src/js-and-ts.js", mod);
    write(dir, "src/js-and-ts.ts", mod);
    write(dir, "src/only-jsx.jsx", mod);
    write(dir, "src/only-mts.mts", mod);
    write(dir, "src/mts-and-dmts.mts", mod);
    write(dir, "src/mts-and-dmts.d.mts", "export declare const v: number;\n");
    write(dir, "src/only-cts.cts", mod);
    write(dir, "src/dir/index.ts", mod);
    write(dir, "src/idx-tsx/index.tsx", mod);
    write(dir, "src/file-vs-dir.ts", mod);
    write(dir, "src/file-vs-dir/index.ts", mod);
    write(dir, "src/dirjs.js/index.ts", mod);
    write(dir, "src/pkg-types/package.json", JSON.stringify({ types: "./entry.d.ts" }));
    write(dir, "src/pkg-types/entry.ts", mod);
    write(dir, "src/pkg-types/entry.d.ts", "export declare const v: number;\n");
    write(dir, "src/pkg-types/index.ts", mod);
    write(dir, "src/pkg-types-js/package.json", JSON.stringify({ types: "./entry.js" }));
    write(dir, "src/pkg-types-js/entry.ts", mod);
    write(dir, "src/pkg-types-js/index.ts", mod);
    write(
      dir,
      "src/pkg-types-missing/package.json",
      JSON.stringify({ types: "./nope.d.ts", main: "./entry.js" }),
    );
    write(dir, "src/pkg-types-missing/entry.ts", mod);
    write(dir, "src/pkg-types-missing/index.ts", mod);
    write(dir, "src/pkg-main/package.json", JSON.stringify({ main: "./entry.js" }));
    write(dir, "src/pkg-main/entry.ts", mod);
    write(dir, "src/pkg-main/index.ts", mod);
    write(dir, "src/pkg-main-noext/package.json", JSON.stringify({ main: "./entry" }));
    write(dir, "src/pkg-main-noext/entry.ts", mod);
    write(dir, "src/pkg-typings/package.json", JSON.stringify({ typings: "./t.d.ts" }));
    write(dir, "src/pkg-typings/t.d.ts", "export declare const v: number;\n");
    write(dir, "src/pkg-typings/index.ts", mod);
    write(dir, "src/pkg-broken-json/package.json", "{ not json ");
    write(dir, "src/pkg-broken-json/index.ts", mod);
    write(dir, "src/pkg-nofields/package.json", JSON.stringify({ name: "x" }));
    write(dir, "src/pkg-nofields/index.ts", mod);
    write(dir, "src/script.ts", "const notExported = 1;\n");
    write(dir, "src/ambient.d.ts", 'declare module "whatever" { const x: number; }\n');
    write(dir, "src/export-eq.ts", "const x = 1;\nexport = x;\n");
    write(dir, "src/data.json", JSON.stringify({ a: 1 }));
    write(dir, "index.ts", mod);
    write(dir, "src/deep/nested.ts", mod);

    write(
      dir,
      "src/importer.ts",
      SPECIFIERS.map((s, i) => `import { v as v${i} } from "${s}";`).join("\n") +
        "\nexport const all = 1;\n",
    );
    write(
      dir,
      "src/side-effects.ts",
      'import "./dir";\nimport "./script";\nimport {} from "./only-ts";\n',
    );
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-resolver-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Each variant lists the OPTIONS-OFF baseline plus its overrides. no-tsconfig
  // and plain must behave identically; node16 proves moduleResolution has no
  // effect beyond its resolveJsonModule flag (R5).
  const variants: Array<{
    name: string;
    tsconfig?: object;
    overrides: Record<string, string | null>;
  }> = [
    { name: "no-tsconfig", overrides: {} },
    { name: "plain", tsconfig: { compilerOptions: {} }, overrides: {} },
    {
      name: "node16",
      tsconfig: {
        compilerOptions: {
          module: "Node16",
          moduleResolution: "Node16",
          resolveJsonModule: true,
        },
      },
      overrides: { "./data.json": "src/data.json" },
    },
    {
      name: "jsx-allowjs-json",
      tsconfig: {
        compilerOptions: { jsx: "preserve", allowJs: true, resolveJsonModule: true },
      },
      overrides: JSX_ALLOWJS_JSON_OVERRIDES,
    },
  ];

  for (const variant of variants) {
    it(`pins resolution under ${variant.name}`, () => {
      const dir = join(root, variant.name);
      writeResolverLayout(dir);
      if (variant.tsconfig) write(dir, "tsconfig.json", JSON.stringify(variant.tsconfig));

      // parseTSFilePaths with ONLY the importer also pins that resolution
      // targets outside the parsed file set are probed on the real FS.
      const importerAbs = join(dir, "src/importer.ts");
      const parsed = parseTSFilePaths(dir, [importerAbs], "file").get(importerAbs)!;

      const expected: Record<string, string | null> = { ...BASE_EXPECTED, ...variant.overrides };
      const expectedTargets = SPECIFIERS.map((s) => expected[s])
        .filter((t): t is string => t !== null)
        .map((t) => `file:${t}`);
      expect(importTargets(parsed, "src/importer.ts")).toEqual(expectedTargets);
    });
  }

  it("pins side-effect / empty-brace imports and script suppression", () => {
    const dir = join(root, "side-effects");
    writeResolverLayout(dir);
    const abs = join(dir, "src/side-effects.ts");
    const parsed = parseTSFilePaths(dir, [abs], "file").get(abs)!;
    // "./script" resolves to a file but is not a module -> no edge (R4).
    expect(importTargets(parsed, "src/side-effects.ts")).toEqual([
      "file:src/dir/index.ts",
      "file:src/only-ts.ts",
    ]);
  });

  it("reads jsx/allowJs through a JSONC tsconfig extends chain (R5)", () => {
    const dir = join(root, "extends-jsonc");
    writeResolverLayout(dir);
    write(
      dir,
      "tsconfig.base.json",
      '{\n  // comment\n  "compilerOptions": {\n    "jsx": "react-jsx", /* block */\n    "allowJs": true,\n  },\n}\n',
    );
    write(dir, "tsconfig.json", '{\n  "extends": "./tsconfig.base",\n}\n');
    const abs = join(dir, "src/importer.ts");
    const parsed = parseTSFilePaths(dir, [abs], "file").get(abs)!;
    const targets = importTargets(parsed, "src/importer.ts");
    expect(targets).toContain("file:src/tsx-dts.tsx"); // jsx applied via extends
    expect(targets).toContain("file:src/only-js.js"); // allowJs applied via extends
    expect(targets).not.toContain("file:src/data.json"); // resolveJsonModule still off
  });

  it("emits symbol-level import edges for named imports in symbol mode", () => {
    const dir = join(root, "symbol-imports");
    writeResolverLayout(dir);
    const abs = join(dir, "src/importer.ts");
    const parsed = parseTSFilePaths(dir, [abs], "symbol").get(abs)!;
    // Every import is `{ v as vN }` -> the edge targets the ORIGINAL name `v`.
    const expectedTargets = SPECIFIERS.map((s) => BASE_EXPECTED[s])
      .filter((t): t is string => t !== null)
      .map((t) => `symbol:${t}#v`);
    expect(importTargets(parsed, "src/importer.ts")).toEqual(expectedTargets);
  });
});

// ---------------------------------------------------------------------------
// R6–R7: symbol-mode export extraction
// ---------------------------------------------------------------------------

describe("oxc regression: symbol extraction (R6–R7)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-symbols-"));
    write(root, "src/re-export-target.ts", "export const qux = 1;\nexport const starred = 2;\n");
    write(
      root,
      "src/exports-kitchen-sink.ts",
      `// leading comment
/** jsdoc for iface */
export interface LoginRequest { email: string; }

export default function defaultFn() { return 1; }

// comment before const
export const x = 1, z = 2;

export function over(a: number): void;
export function over(a: string): void;
export function over(a: unknown) { void a; }

function localA() {}
export { localA as renamedA };

export type Alias = string;

export enum Color { Red }

export class Klass {}

export { qux } from "./re-export-target.js";

export abstract class Abs {}

export let mutable = 5;

const arrow = () => 1;
export { arrow };

export namespace NS { export const inner = 1; }

export * from "./re-export-target.js";

export * as ns from "./re-export-target.js";
`,
    );
    write(root, "src/default-expr.ts", "const a = 1;\nexport default 42;\nexport const b = 2;\n");
    write(root, "src/default-obj.ts", "export default { a: 1,\n  b: 2 };\n");
    write(
      root,
      "src/default-ident-fn.ts",
      "function foo() { return 1; }\nexport default foo;\nexport function bar() {}\n",
    );
    write(root, "src/default-ident-var.ts", "const foo = () => 1;\nexport default foo;\n");
    write(root, "src/default-anon-fn.ts", "export default function () { return 1; }\n");
    write(root, "src/default-anon-class.ts", "export default class { m() {} }\n");
    write(root, "src/default-paren.ts", "const foo = 1;\nexport default (foo);\n");
    write(
      root,
      "src/specifier-before-decl.ts",
      "export { later };\nfunction later() {}\nexport function first() {}\n",
    );
    write(
      root,
      "src/destructure.ts",
      "const obj = { a: 1, b: 2, c: 3, e: { f: 4 } };\n" +
        "export const { a, b: renamedB, c = 9, e: { f }, ...rest } = obj;\n" +
        "export const [g, h = 2, ...tail] = [1, 2, 3];\n",
    );
    write(
      root,
      "src/merges.ts",
      "export function m() {}\nexport namespace m { export const inner = 1; }\n" +
        "export namespace m2 { export const inner = 1; }\nexport function m2() {}\n" +
        "export interface I { a: number; }\nexport interface I { b: number; }\n" +
        "export class C {}\nexport namespace C { export const inner = 1; }\n",
    );
    write(
      root,
      "src/order-mix.ts",
      "export const v1 = 1;\nexport function f1() {}\nexport const v2 = 2;\n" +
        "export function f2() {}\nexport default 7;\nexport class K2 {}\n",
    );
    write(
      root,
      "src/aliases.ts",
      'function f() {}\nexport { f };\nexport { f as g };\nexport { f as "dash-name" };\n',
    );
    write(
      root,
      "src/import-reexport.ts",
      'import { qux } from "./re-export-target.js";\nimport * as ns from "./re-export-target.js";\n' +
        "export { qux };\nexport { ns };\nexport default qux;\nexport const local = 1;\n",
    );
    write(
      root,
      "src/declares.ts",
      "export declare const ambient: number;\nexport declare function ambientFn(): void;\n" +
        "export async function af() {}\nexport function* gen() { yield 1; }\n",
    );
    write(
      root,
      "src/type-only.ts",
      'type T = string;\nexport type { T };\nexport const val = 1;\nexport type { starred } from "./re-export-target.js";\n',
    );
    write(
      root,
      "src/impl-tags.ts",
      "export function tagged() {\n  // @impl FR-101\n  return 1;\n}\n" +
        "export const taggedArrow = () => {\n  // @impl FR-102\n  return 2;\n};\n" +
        "// @impl FR-103\nconst topLevel = 1;\nexport { topLevel };\n",
    );
    write(
      root,
      "src/jsx-comp.tsx",
      "export function Comp(props: { a: number }) {\n  return <div>{props.a}</div>;\n}\nexport default Comp;\n",
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function parseSymbol(relPath: string): ParsedTS {
    const abs = join(root, relPath);
    return parseTSFilePaths(root, [abs], "symbol").get(abs)!;
  }

  it("orders exports functions-first and hashes per-kind getText spans (kitchen sink)", () => {
    const rel = "src/exports-kitchen-sink.ts";
    // R6: `default` (line 5) and `over` (line 10) are FunctionDeclaration
    // statements -> bound before the interface on line 3. R7: each hash is
    // the exact legacy getText() of the declaration. Issue #177: the named
    // re-export `export { qux } from …` now materializes a barrel symbol node
    // (`#qux`) hashed PER-SPECIFIER on the resolved origin path + local +
    // exported (\0-joined) — sibling specifier edits in the same `export { … }
    // from` statement don't drift each other's hashes. Note: at the parser
    // layer, plain `export *` still produces no per-name node — per-symbol
    // expansion for `export *` happens later in the builder (see
    // src/graph/star-expansion.ts and tests/star-expansion.test.ts). specs/018
    // S2 (`export * as ns from`) IS materialized at parse time — see the `ns`
    // pin below.
    expect(symbolsOf(parseSymbol(rel), rel)).toEqual(
      expectedSymbols(rel, [
        ["default", "export default function defaultFn() { return 1; }"],
        ["over", "export function over(a: number): void;"], // first overload
        ["LoginRequest", "export interface LoginRequest { email: string; }"],
        ["x", "x = 1"], // declarator, not `export const x = 1`
        ["z", "z = 2"],
        ["renamedA", "function localA() {}"], // alias -> local decl text
        ["Alias", "export type Alias = string;"],
        ["Color", "export enum Color { Red }"],
        ["Klass", "export class Klass {}"],
        ["Abs", "export abstract class Abs {}"],
        ["mutable", "mutable = 5"],
        ["arrow", "arrow = () => 1"],
        ["NS", "export namespace NS { export const inner = 1; }"],
        // #177: barrel symbol -> hash source is targetRel\0local\0exported.
        ["qux", "src/re-export-target.ts\0qux\0qux"],
        // specs/018 §6 S2: `export * as ns from "./m"` materialises a
        // per-symbol barrel node for the namespace binding. Hash source is
        // targetRel\0*\0ns (the "*" origin-binding sentinel is the same one
        // S3-C4 uses for `import * as ns; export { ns }` — see the
        // src/import-reexport.ts pin below). Emitted by the same reExports
        // pass that emits `qux` above, in source order after it.
        ["ns", "src/re-export-target.ts\0*\0ns"],
      ]),
    );
  });

  const cases: Array<{ rel: string; expected: Array<[string, string]> }> = [
    {
      rel: "src/default-expr.ts",
      expected: [
        ["default", "42"], // expression node text
        ["b", "b = 2"],
      ],
    },
    { rel: "src/default-obj.ts", expected: [["default", "{ a: 1,\n  b: 2 }"]] },
    {
      rel: "src/default-ident-fn.ts",
      // `bar` is a function statement (pass 1); `export default foo;` is an
      // export assignment (pass 2) resolving to foo's declaration.
      expected: [
        ["bar", "export function bar() {}"],
        ["default", "function foo() { return 1; }"],
      ],
    },
    { rel: "src/default-ident-var.ts", expected: [["default", "foo = () => 1"]] },
    {
      rel: "src/default-anon-fn.ts",
      expected: [["default", "export default function () { return 1; }"]],
    },
    {
      // spec 021 (T024, issue #218): expectation INVERTED — the pre-spec-021
      // assumption "classes never carry member symbols" no longer holds.
      // `export default class { m() {} }` now ALSO materializes a
      // `#default.m` member symbol alongside the class's own `#default`
      // node (which stays byte-identical — same id, same span, same hash).
      rel: "src/default-anon-class.ts",
      expected: [
        ["default", "export default class { m() {} }"],
        ["default.m", "m() {}"],
      ],
    },
    { rel: "src/default-paren.ts", expected: [["default", "(foo)"]] },
    {
      rel: "src/specifier-before-decl.ts",
      // The export-specifier statement (line 1) binds in pass 2, so the
      // directly-exported function wins the earlier slot despite appearing
      // later in the file.
      expected: [
        ["first", "export function first() {}"],
        ["later", "function later() {}"],
      ],
    },
    {
      rel: "src/destructure.ts",
      expected: [
        ["a", "a"],
        ["renamedB", "b: renamedB"],
        ["c", "c = 9"],
        ["f", "f"], // leaf of the nested pattern
        ["rest", "...rest"],
        ["g", "g"],
        ["h", "h = 2"],
        ["tail", "...tail"],
      ],
    },
    {
      rel: "src/merges.ts",
      // fn+namespace merges resolve to the FUNCTION declaration regardless of
      // source order; duplicate interfaces keep the first.
      expected: [
        ["m", "export function m() {}"],
        ["m2", "export function m2() {}"],
        ["I", "export interface I { a: number; }"],
        ["C", "export class C {}"],
      ],
    },
    {
      rel: "src/order-mix.ts",
      expected: [
        ["f1", "export function f1() {}"],
        ["f2", "export function f2() {}"],
        ["v1", "v1 = 1"],
        ["v2", "v2 = 2"],
        ["default", "7"],
        ["K2", "export class K2 {}"],
      ],
    },
    {
      rel: "src/aliases.ts",
      expected: [
        ["f", "function f() {}"],
        ["g", "function f() {}"],
        ["dash-name", "function f() {}"],
      ],
    },
    {
      // #188 / specs/018 S3: imported identifiers re-exported via a source-null
      // named export (S3-C4) or as a default (S3-C3) are materialized per-symbol
      // in extractImports, hashed with synthReexportHash (targetRel \0
      // originBinding \0 exportedName). extractSymbols still skips the
      // ExportNamedDeclaration/ExportDefaultDeclaration because it has no
      // resolve context — the extractImports pass fills them in. Emit order:
      // extractSymbols first (local decl), then extractImports S3 in source
      // order (qux → ns → default).
      //   export { qux }         local="qux",  binding: named "qux"    -> targetRel\0qux\0qux
      //   export { ns }          local="ns",   binding: namespace "*"  -> targetRel\0*\0ns
      //   export default qux     local="qux",  binding: named "qux"    -> targetRel\0qux\0default
      rel: "src/import-reexport.ts",
      expected: [
        ["local", "local = 1"],
        ["qux", "src/re-export-target.ts\0qux\0qux"],
        ["ns", "src/re-export-target.ts\0*\0ns"],
        ["default", "src/re-export-target.ts\0qux\0default"],
      ],
    },
    {
      rel: "src/declares.ts",
      expected: [
        ["ambientFn", "export declare function ambientFn(): void;"],
        ["af", "export async function af() {}"],
        ["gen", "export function* gen() { yield 1; }"],
        ["ambient", "ambient: number"],
      ],
    },
    {
      rel: "src/type-only.ts",
      expected: [
        ["T", "type T = string;"],
        ["val", "val = 1"],
        // #177: `export type { starred } from …` is a named (type-only)
        // re-export -> materialized as a barrel symbol node like a value
        // re-export (the origin's `starred` symbol exists), hashed per-
        // specifier on targetRel\0local\0exported.
        ["starred", "src/re-export-target.ts\0starred\0starred"],
      ],
    },
    {
      rel: "src/jsx-comp.tsx",
      expected: [
        ["Comp", "export function Comp(props: { a: number }) {\n  return <div>{props.a}</div>;\n}"],
        [
          "default",
          "export function Comp(props: { a: number }) {\n  return <div>{props.a}</div>;\n}",
        ],
      ],
    },
  ];

  for (const { rel, expected } of cases) {
    it(`pins ${rel}`, () => {
      expect(symbolsOf(parseSymbol(rel), rel)).toEqual(expectedSymbols(rel, expected));
    });
  }

  it("attributes @impl tags to the innermost enclosing symbol range", () => {
    const rel = "src/impl-tags.ts";
    const parsed = parseSymbol(rel);
    const implEdges = parsed.edges.filter((e) => e.kind === "implements");
    expect(implEdges).toEqual([
      {
        source: `symbol:${rel}#tagged`,
        target: "FR-101",
        kind: "implements",
        provenances: ["code-tag"],
      },
      {
        source: `symbol:${rel}#taggedArrow`,
        target: "FR-102",
        kind: "implements",
        provenances: ["code-tag"],
      },
      // FR-103 sits on the line directly above `const topLevel = 1;`. Issue
      // #177: leading-comment tags now bind to the following symbol's widened
      // attribution range, so it attaches to `#topLevel` (the local backing the
      // `export { topLevel }`) instead of falling back to the file.
      {
        source: `symbol:${rel}#topLevel`,
        target: "FR-103",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// R8: file enumeration order
// ---------------------------------------------------------------------------

describe("oxc regression: file enumeration order (R8)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-order-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("walks directories breadth-first with sorted children and files", () => {
    const dir = join(root, "bfs");
    const mod = "export const v = 1;\n";
    write(dir, "zeta/z1.ts", mod);
    write(dir, "zeta/deep/z2.ts", mod);
    write(dir, "alpha/a1.ts", mod);
    write(dir, "alpha/Upper.ts", mod);
    write(dir, "alpha/lower.ts", mod);
    write(dir, "root1.ts", mod);
    write(dir, "beta/sub/b1.ts", mod);

    // root1.ts caches the root directory, unifying every subtree under one
    // BFS: depth 1 = root file, depth 2 = alpha/beta/zeta (sorted — NOT the
    // pattern order), depth 3 = their subdirectories (parent order first).
    const parsed = createTSParser(dir, [
      "zeta/**/*.ts",
      "*.ts",
      "alpha/**/*.ts",
      "beta/**/*.ts",
    ]).parse();
    expect(parsed.nodes.map((n) => n.filePath)).toEqual([
      "root1.ts",
      "alpha/a1.ts",
      "alpha/lower.ts", // LocaleStringComparer: case breaks ties only
      "alpha/Upper.ts",
      "zeta/z1.ts",
      "beta/sub/b1.ts",
      "zeta/deep/z2.ts",
    ]);
  });

  it("keeps disconnected top-level directories in pattern insertion order", () => {
    const dir = join(root, "orphans");
    const mod = "export const v = 1;\n";
    write(dir, "b/x.ts", mod);
    write(dir, "a/y.ts", mod);

    // No file at the root -> a/ and b/ are never connected under a common
    // cached ancestor; such "orphan" roots iterate in insertion (= pattern)
    // order, not sorted.
    const parsed = createTSParser(dir, ["b/**/*.ts", "a/**/*.ts"]).parse();
    expect(parsed.nodes.map((n) => n.filePath)).toEqual(["b/x.ts", "a/y.ts"]);
  });
});

// ---------------------------------------------------------------------------
// R9–R11: BOM, empty export-from, broken files
// ---------------------------------------------------------------------------

describe("oxc regression: BOM / export-from / syntax errors (R9–R11)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-misc-"));
    write(root, "src/target.ts", "export const t = 1;\n");
    write(root, "src/bom.ts", "﻿export const b = 1;\n");
    write(
      root,
      "src/export-from.ts",
      'export {} from "./target.js";\nexport type { t } from "./target.js";\nexport * from "./target.js";\n',
    );
    write(
      root,
      "src/broken.ts",
      '// @impl BRK-001\nimport { t } from "./target.js";\nexport function ok() {}\nconst x = ;\n',
    );
    write(
      root,
      "src/broken.test.ts",
      'import { t } from "./target.js";\ndescribe("[BRK-001] broken", () => {\nconst y = ;\n',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function parseOne(relPath: string, mode: "file" | "symbol"): ParsedTS {
    const abs = join(root, relPath);
    return parseTSFilePaths(root, [abs], mode).get(abs)!;
  }

  it("strips a UTF-8 BOM before hashing file content (R9)", () => {
    const parsed = parseOne("src/bom.ts", "file");
    expect(parsed.nodes[0].contentHash).toBe(hash("export const b = 1;\n"));
    expect(parsed.nodes[0].contentHash).not.toBe(hash("﻿export const b = 1;\n"));
  });

  it("emits one edge per re-export statement, including `export {} from` (R10)", () => {
    const parsed = parseOne("src/export-from.ts", "file");
    expect(importTargets(parsed, "src/export-from.ts")).toEqual([
      "file:src/target.ts",
      "file:src/target.ts",
      "file:src/target.ts",
    ]);
  });

  it("recovers import + tag edges from a file with a fatal syntax error (R11)", () => {
    const parsed = parseOne("src/broken.ts", "file");
    expect(parsed.nodes).toEqual([
      {
        id: "file:src/broken.ts",
        kind: "file",
        filePath: "src/broken.ts",
        contentHash: parsed.nodes[0].contentHash,
      },
    ]);
    // Import edges come from oxc's error-tolerant module record; the @impl
    // edge from the plain-text regex layer.
    expect(parsed.edges).toEqual([
      {
        source: "file:src/broken.ts",
        target: "file:src/target.ts",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:src/broken.ts",
        target: "BRK-001",
        kind: "implements",
        provenances: ["code-tag"],
      },
    ]);
  });

  it("keeps [REQ] verifies edges for a broken test file (R11)", () => {
    const parsed = parseOne("src/broken.test.ts", "file");
    expect(parsed.nodes[0].kind).toBe("test");
    expect(parsed.edges).toEqual([
      {
        source: "file:src/broken.test.ts",
        target: "file:src/target.ts",
        kind: "imports",
        provenances: ["ts-import"],
      },
      {
        source: "file:src/broken.test.ts",
        target: "BRK-001",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ]);
  });

  it("emits NO symbol nodes for a broken file in symbol mode (known limit, R11)", () => {
    // The old ts-morph backend recovered a partial AST here (a symbol node
    // for `ok`); oxc returns an empty program on fatal errors, so the file
    // degrades to file-level granularity: @impl attributes to the file.
    const parsed = parseOne("src/broken.ts", "symbol");
    expect(parsed.nodes.filter((n) => n.kind === "symbol")).toEqual([]);
    expect(parsed.edges).toContainEqual({
      source: "file:src/broken.ts",
      target: "BRK-001",
      kind: "implements",
      provenances: ["code-tag"],
    });
  });
});
