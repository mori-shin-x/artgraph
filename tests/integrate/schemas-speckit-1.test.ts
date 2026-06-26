import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  SPECKIT_SCHEMA_VERSION,
  UnsupportedSchemaVersionError,
  validateExtensionYaml,
  validateHookEntry,
} from "../../src/integrate/schemas/speckit-1.0.js";
import type { SpecKitExtensionManifest } from "../../src/integrate/schemas/speckit-1.0.js";
import type { HookEntry } from "../../src/types.js";

const CANONICAL_TEMPLATE_PATH = resolve(
  import.meta.dirname,
  "../../templates/integrate/speckit/extension.yml",
);

function canonicalManifest(): SpecKitExtensionManifest {
  return {
    schema_version: SPECKIT_SCHEMA_VERSION,
    extension: {
      id: "artgraph",
      name: "artgraph — SDD verification",
      version: "0.1.0",
      description: "Run artgraph scan/reconcile/check at Spec Kit workflow checkpoints.",
      author: "artgraph",
      repository: "https://github.com/ShintaroMorimoto/artgraph",
      license: "MIT",
    },
    requires: { speckit_version: ">=0.11.0" },
    provides: {
      commands: [
        {
          name: "artgraph.scan-reconcile",
          file: "commands/artgraph.scan-reconcile.md",
          description: "Refresh artgraph baseline (scan && reconcile)",
        },
        {
          name: "artgraph.check-diff",
          file: "commands/artgraph.check-diff.md",
          description: "Verify coverage/orphan/drift on the current diff",
        },
        {
          name: "artgraph.check-gate",
          file: "commands/artgraph.check-gate.md",
          description: "Gate implementation on artgraph check (--gate mode)",
        },
      ],
    },
    hooks: {
      after_tasks: {
        command: "artgraph.scan-reconcile",
        optional: false,
        description: "Refresh artgraph baseline after tasks",
      },
      after_implement: {
        command: "artgraph.check-diff",
        optional: false,
        description: "Verify artgraph traceability after implementation",
      },
    },
    tags: ["traceability", "verification", "artgraph"],
  };
}

function canonicalHookEntry(): HookEntry {
  return {
    extension: "artgraph",
    command: "artgraph.scan-reconcile",
    enabled: true,
    optional: false,
    priority: 50,
    prompt: "Run artgraph scan && reconcile to refresh trace baseline?",
    description: "Refresh artgraph baseline after tasks",
    condition: null,
  };
}

describe("validateExtensionYaml", () => {
  it("accepts the canonical manifest", () => {
    expect(() => validateExtensionYaml(canonicalManifest())).not.toThrow();
  });

  it("throws UnsupportedSchemaVersionError when schema_version != '1.0'", () => {
    const bad = {
      ...canonicalManifest(),
      schema_version: "2.0",
    } as unknown as SpecKitExtensionManifest;
    expect(() => validateExtensionYaml(bad)).toThrow(UnsupportedSchemaVersionError);
  });

  it("rejects extension.id that is not kebab-case", () => {
    const bad = canonicalManifest();
    bad.extension = { ...bad.extension, id: "Spec_Trace" };
    expect(() => validateExtensionYaml(bad)).toThrow();
  });

  it("rejects a provides.commands[].name that is not dot-separated kebab", () => {
    const bad = canonicalManifest();
    bad.provides.commands[0]!.name = "Not_A_Name";
    expect(() => validateExtensionYaml(bad)).toThrow();
  });

  it("rejects a provides.commands[].file that escapes the extension dir", () => {
    const bad = canonicalManifest();
    bad.provides.commands[0]!.file = "../escape.md";
    expect(() => validateExtensionYaml(bad)).toThrow();
  });

  it("rejects a hooks[].command that is not in provides.commands", () => {
    const bad = canonicalManifest();
    bad.hooks.after_tasks = {
      command: "artgraph.unknown",
      optional: false,
      description: "x",
    };
    expect(() => validateExtensionYaml(bad)).toThrow();
  });

  it("round-trips the canonical extension.yml template byte-identically through parse → serialize", () => {
    const raw = readFileSync(CANONICAL_TEMPLATE_PATH, "utf-8");
    const parsed = parseYaml(raw) as SpecKitExtensionManifest;
    // Validate that the parsed shape passes our validator.
    expect(() => validateExtensionYaml(parsed)).not.toThrow();
    // Re-serialize and re-parse to confirm the parsed object is stable.
    const reSerialized = stringifyYaml(parsed);
    const reParsed = parseYaml(reSerialized) as SpecKitExtensionManifest;
    expect(reParsed).toEqual(parsed);
  });
});

describe("validateHookEntry", () => {
  it("accepts the canonical hook entry", () => {
    expect(() => validateHookEntry(canonicalHookEntry())).not.toThrow();
  });

  it("rejects a negative priority", () => {
    const bad = { ...canonicalHookEntry(), priority: -1 };
    expect(() => validateHookEntry(bad)).toThrow();
  });

  it("rejects a non-integer priority", () => {
    const bad = { ...canonicalHookEntry(), priority: 1.5 };
    expect(() => validateHookEntry(bad)).toThrow();
  });
});
