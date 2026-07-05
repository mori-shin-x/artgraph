import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createTSParser as createTsMorphParser,
  parseTSFilePaths as parseTsMorphFilePaths,
  globCodeFiles,
} from "../src/parsers/typescript.js";
import {
  createTSParser as createOxcParser,
  parseTSFilePaths as parseOxcFilePaths,
} from "../src/parsers/typescript-oxc.js";

// Differential tests for the oxc-parser TS extraction layer (issue #159,
// phase 1): every input is parsed by BOTH backends and the ParsedTS output
// must match exactly — node/edge contents, ARRAY ORDER, and contentHash
// values. ts-morph is the ground truth; any assertion failure here is a
// parity bug in typescript-oxc.ts, never something to paper over by relaxing
// the assertion.

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures");

function expectParity(
  rootDir: string,
  patterns: string[],
  mode: "file" | "symbol",
  codeId?: string,
): void {
  const expected = createTsMorphParser(rootDir, patterns, mode, codeId).parse();
  const actual = createOxcParser(rootDir, patterns, mode, codeId).parse();
  expect(actual.nodes).toEqual(expected.nodes);
  expect(actual.edges).toEqual(expected.edges);
}

function write(rootDir: string, relPath: string, content: string): void {
  const abs = join(rootDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe("oxc/ts-morph differential: this repository", () => {
  const patterns = ["src/**/*.ts", "tests/**/*.test.ts"];

  it("file mode matches on the artgraph codebase itself", () => {
    expectParity(REPO_ROOT, patterns, "file");
  });

  it("symbol mode matches on the artgraph codebase itself", () => {
    expectParity(REPO_ROOT, patterns, "symbol");
  });

  it("parseTSFilePaths matches per-file on the artgraph src set", () => {
    const files = globCodeFiles(REPO_ROOT, ["src/**/*.ts"]);
    for (const mode of ["file", "symbol"] as const) {
      const expected = parseTsMorphFilePaths(REPO_ROOT, files, mode);
      const actual = parseOxcFilePaths(REPO_ROOT, files, mode);
      expect([...actual.keys()]).toEqual([...expected.keys()]);
      for (const [path, fragment] of expected) {
        expect(actual.get(path)).toEqual(fragment);
      }
    }
  });
});

describe("oxc/ts-morph differential: bundled fixtures", () => {
  const fixtures: Array<{ dir: string; patterns: string[]; codeId?: string }> = [
    { dir: ".", patterns: ["src/**/*.ts", "tests/**/*.ts"] },
    { dir: "all-verified", patterns: ["src/**/*.ts", "tests/**/*.ts"] },
    { dir: "bootstrap-basic", patterns: ["src/**/*.ts", "tests/**/*.ts"] },
    { dir: "custom-id", patterns: ["src/**/*.ts", "tests/**/*.ts"], codeId: "\\d+" },
    { dir: "edge-provenance", patterns: ["src/**/*.ts", "tests/**/*.ts"] },
    { dir: "symbol-level", patterns: ["src/**/*.ts"] },
    { dir: "symbol-mode", patterns: ["src/**/*.ts", "tests/**/*.test.ts"] },
  ];

  for (const fixture of fixtures) {
    for (const mode of ["file", "symbol"] as const) {
      it(`${fixture.dir} (${mode} mode${fixture.codeId ? ", custom codeId" : ""})`, () => {
        expectParity(resolve(FIXTURE_ROOT, fixture.dir), fixture.patterns, mode, fixture.codeId);
      });
    }
  }

  it("custom-id fixture with the default codeId (no custom pattern)", () => {
    expectParity(resolve(FIXTURE_ROOT, "custom-id"), ["src/**/*.ts", "tests/**/*.ts"], "file");
  });
});

describe("oxc/ts-morph differential: resolver edge cases", () => {
  let root: string;

  // One layout, parsed under two tsconfig variants: the probe set covers
  // extension substitution priority (.js -> .ts/.tsx/.d.ts/.js/.jsx),
  // .mjs/.cjs mapping, extensionless probing, directory/index resolution,
  // package.json types/typings/main fields, script (non-module) targets, and
  // json modules.
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

    const specifiers = [
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
    write(
      dir,
      "src/importer.ts",
      specifiers.map((s, i) => `import { v as v${i} } from "${s}";`).join("\n") +
        "\nexport const all = 1;\n",
    );
    write(
      dir,
      "src/side-effects.ts",
      'import "./dir";\nimport "./script";\nimport {} from "./only-ts";\n',
    );
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-diff-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const variants: Array<{ name: string; tsconfig?: object }> = [
    { name: "no-tsconfig" },
    { name: "plain", tsconfig: { compilerOptions: {} } },
    {
      name: "node16",
      tsconfig: {
        compilerOptions: {
          module: "Node16",
          moduleResolution: "Node16",
          resolveJsonModule: true,
        },
      },
    },
    {
      name: "jsx-allowjs-json",
      tsconfig: {
        compilerOptions: { jsx: "preserve", allowJs: true, resolveJsonModule: true },
      },
    },
  ];

  for (const variant of variants) {
    it(`resolves like ts-morph under ${variant.name}`, () => {
      const dir = join(root, variant.name);
      writeResolverLayout(dir);
      if (variant.tsconfig) write(dir, "tsconfig.json", JSON.stringify(variant.tsconfig));
      expectParity(dir, ["src/importer.ts", "src/side-effects.ts"], "file");
      expectParity(dir, ["src/importer.ts", "src/side-effects.ts"], "symbol");
    });
  }

  it("resolves like ts-morph with a JSONC tsconfig behind extends", () => {
    const dir = join(root, "extends-jsonc");
    writeResolverLayout(dir);
    write(
      dir,
      "tsconfig.base.json",
      '{\n  // comment\n  "compilerOptions": {\n    "jsx": "react-jsx", /* block */\n    "allowJs": true,\n  },\n}\n',
    );
    write(dir, "tsconfig.json", '{\n  "extends": "./tsconfig.base",\n}\n');
    expectParity(dir, ["src/importer.ts"], "file");
  });

  it("resolves targets outside the parsed file set (parseTSFilePaths)", () => {
    const dir = join(root, "outside-set");
    writeResolverLayout(dir);
    const files = [join(dir, "src/importer.ts")];
    for (const mode of ["file", "symbol"] as const) {
      const expected = parseTsMorphFilePaths(dir, files, mode);
      const actual = parseOxcFilePaths(dir, files, mode);
      expect(actual.get(files[0])).toEqual(expected.get(files[0]));
    }
  });
});

describe("oxc/ts-morph differential: symbol extraction edge cases", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-sym-"));
    const dir = root;
    write(
      dir,
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
`,
    );
    write(dir, "src/re-export-target.ts", "export const qux = 1;\nexport const starred = 2;\n");
    write(dir, "src/default-expr.ts", "const a = 1;\nexport default 42;\nexport const b = 2;\n");
    write(dir, "src/default-obj.ts", "export default { a: 1,\n  b: 2 };\n");
    write(
      dir,
      "src/default-ident-fn.ts",
      "function foo() { return 1; }\nexport default foo;\nexport function bar() {}\n",
    );
    write(dir, "src/default-ident-var.ts", "const foo = () => 1;\nexport default foo;\n");
    write(dir, "src/default-anon-fn.ts", "export default function () { return 1; }\n");
    write(dir, "src/default-anon-class.ts", "export default class { m() {} }\n");
    write(dir, "src/default-paren.ts", "const foo = 1;\nexport default (foo);\n");
    write(
      dir,
      "src/specifier-before-decl.ts",
      "export { later };\nfunction later() {}\nexport function first() {}\n",
    );
    write(
      dir,
      "src/destructure.ts",
      "const obj = { a: 1, b: 2, c: 3, e: { f: 4 } };\n" +
        "export const { a, b: renamedB, c = 9, e: { f }, ...rest } = obj;\n" +
        "export const [g, h = 2, ...tail] = [1, 2, 3];\n",
    );
    write(
      dir,
      "src/merges.ts",
      "export function m() {}\nexport namespace m { export const inner = 1; }\n" +
        "export namespace m2 { export const inner = 1; }\nexport function m2() {}\n" +
        "export interface I { a: number; }\nexport interface I { b: number; }\n" +
        "export class C {}\nexport namespace C { export const inner = 1; }\n",
    );
    write(
      dir,
      "src/order-mix.ts",
      "export const v1 = 1;\nexport function f1() {}\nexport const v2 = 2;\n" +
        "export function f2() {}\nexport default 7;\nexport class K2 {}\n",
    );
    write(
      dir,
      "src/aliases.ts",
      'function f() {}\nexport { f };\nexport { f as g };\nexport { f as "dash-name" };\n',
    );
    write(
      dir,
      "src/import-reexport.ts",
      'import { qux } from "./re-export-target.js";\nimport * as ns from "./re-export-target.js";\n' +
        "export { qux };\nexport { ns };\nexport default qux;\nexport const local = 1;\n",
    );
    write(
      dir,
      "src/declares.ts",
      "export declare const ambient: number;\nexport declare function ambientFn(): void;\n" +
        "export async function af() {}\nexport function* gen() { yield 1; }\n",
    );
    write(
      dir,
      "src/type-only.ts",
      'type T = string;\nexport type { T };\nexport const val = 1;\nexport type { starred } from "./re-export-target.js";\n',
    );
    write(
      dir,
      "src/impl-tags.ts",
      "export function tagged() {\n  // @impl FR-101\n  return 1;\n}\n" +
        "export const taggedArrow = () => {\n  // @impl FR-102\n  return 2;\n};\n" +
        "// @impl FR-103\nconst topLevel = 1;\nexport { topLevel };\n",
    );
    write(dir, "src/export-eq.ts", "const x = 1;\nexport = x;\n");
    write(dir, "src/empty.ts", "");
    write(
      dir,
      "src/jsx-comp.tsx",
      "export function Comp(props: { a: number }) {\n  return <div>{props.a}</div>;\n}\nexport default Comp;\n",
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("matches in symbol mode across export forms", () => {
    expectParity(root, ["src/**/*.ts", "src/**/*.tsx"], "symbol");
  });

  it("matches in file mode across export forms", () => {
    expectParity(root, ["src/**/*.ts", "src/**/*.tsx"], "file");
  });
});

describe("oxc/ts-morph differential: files with syntax errors", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "artgraph-oxc-broken-"));
    // The statements after the import are unparseable; ts-morph recovers a
    // partial AST, oxc returns an empty program but keeps the module record
    // (imports/exports), which is what the file-mode output is built from.
    write(root, "src/target.ts", "export const t = 1;\n");
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

  it("neither backend throws, and file mode matches exactly", () => {
    expectParity(root, ["src/**/*.ts"], "file");
  });

  it("symbol mode: import edges and impl tags survive; symbol nodes are a documented divergence", () => {
    // KNOWN DIVERGENCE (accepted for phase 1): on a fatal syntax error
    // ts-morph still recovers partial declarations (a symbol node for `ok`),
    // while oxc returns an empty program — so oxc emits no symbol nodes for
    // the broken file and attributes its @impl tags to the file instead.
    // Everything reconstructible without an AST (file/test nodes, import
    // edges via the module record, tag edges) must still match.
    const oxc = createOxcParser(root, ["src/**/*.ts"], "symbol").parse();
    const tsMorph = createTsMorphParser(root, ["src/**/*.ts"], "symbol").parse();

    const fileNodes = (nodes: typeof oxc.nodes) => nodes.filter((n) => n.kind !== "symbol");
    expect(fileNodes(oxc.nodes)).toEqual(fileNodes(tsMorph.nodes));

    const importEdges = (edges: typeof oxc.edges) => edges.filter((e) => e.kind === "imports");
    expect(importEdges(oxc.edges)).toEqual(importEdges(tsMorph.edges));

    // The @impl edge is still extracted (regex layer needs no AST); only its
    // source falls back from symbol:...#ok to the file.
    expect(oxc.edges).toContainEqual({
      source: "file:src/broken.ts",
      target: "BRK-001",
      kind: "implements",
      provenances: ["code-tag"],
    });
  });
});
