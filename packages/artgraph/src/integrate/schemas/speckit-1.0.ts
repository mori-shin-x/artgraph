/**
 * Frozen Spec Kit Extension schema v1.0 (FR-016 / Clarifications Q3).
 *
 * The schema_version this integration emits is fixed at compile-time. If
 * Spec Kit's manifest ever undergoes a breaking change, raise a version-
 * branch PR rather than silently following upstream.
 *
 * Contract: specs/009-sdd-integration/contracts/speckit-extension-schema.md
 */
import type { HookEntry, HookTrigger } from "../../types.js";

export const SPECKIT_SCHEMA_VERSION = "1.0" as const;

export interface SpecKitExtensionMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  repository: string;
  license: string;
}

export interface ProvidedCommand {
  /** dot-separated kebab; e.g. "artgraph.scan-reconcile" */
  name: string;
  /** relative to the extension dir; e.g. "commands/artgraph.scan-reconcile.md" */
  file: string;
  description: string;
}

export interface ManifestHookDeclaration {
  command: string;
  optional: boolean;
  description: string;
}

export interface SpecKitExtensionManifest {
  schema_version: typeof SPECKIT_SCHEMA_VERSION;
  extension: SpecKitExtensionMetadata;
  requires: { speckit_version: string };
  provides: { commands: ProvidedCommand[] };
  hooks: Partial<Record<HookTrigger, ManifestHookDeclaration>>;
  tags: string[];
}

/** Thrown when the parsed manifest's schema_version is not the frozen value. */
export class UnsupportedSchemaVersionError extends Error {
  readonly found: string;
  constructor(found: string) {
    super(
      `Unsupported Spec Kit Extension schema_version: "${found}" (this integration supports only "${SPECKIT_SCHEMA_VERSION}")`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.found = found;
  }
}

const ID_KEBAB = /^[a-z][a-z0-9-]*$/;
// dot-separated kebab: each segment must start with a letter and may contain
// letters/digits/hyphens; segments are joined by ".".
const COMMAND_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]+)*$/;

/**
 * Validate a parsed `extension.yml` payload against the frozen v1.0 schema.
 * Throws on mismatch; returns void on success.
 */
export function validateExtensionYaml(manifest: SpecKitExtensionManifest): void {
  if (manifest.schema_version !== SPECKIT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(String(manifest.schema_version));
  }

  const ext = manifest.extension;
  if (!ext || typeof ext.id !== "string" || !ID_KEBAB.test(ext.id)) {
    throw new Error(
      `extension.id must be kebab-case ([a-z][a-z0-9-]*); got: ${JSON.stringify(ext?.id)}`,
    );
  }
  for (const key of [
    "name",
    "version",
    "description",
    "author",
    "repository",
    "license",
  ] as const) {
    if (typeof ext[key] !== "string" || ext[key].length === 0) {
      throw new Error(`extension.${key} must be a non-empty string`);
    }
  }

  if (!manifest.requires || typeof manifest.requires.speckit_version !== "string") {
    throw new Error("requires.speckit_version must be a string");
  }

  if (!manifest.provides || !Array.isArray(manifest.provides.commands)) {
    throw new Error("provides.commands must be an array");
  }

  const commandNames = new Set<string>();
  for (const cmd of manifest.provides.commands) {
    if (typeof cmd.name !== "string" || !COMMAND_NAME.test(cmd.name)) {
      throw new Error(
        `provides.commands[].name must be dot-separated kebab; got: ${JSON.stringify(cmd.name)}`,
      );
    }
    if (typeof cmd.file !== "string" || cmd.file.length === 0 || cmd.file.includes("..")) {
      throw new Error(
        `provides.commands[].file must be a relative path within the extension dir; got: ${JSON.stringify(cmd.file)}`,
      );
    }
    if (typeof cmd.description !== "string") {
      throw new Error("provides.commands[].description must be a string");
    }
    commandNames.add(cmd.name);
  }

  if (manifest.hooks && typeof manifest.hooks === "object") {
    for (const [trigger, decl] of Object.entries(manifest.hooks)) {
      if (!decl) continue;
      if (typeof decl.command !== "string" || !commandNames.has(decl.command)) {
        throw new Error(
          `hooks.${trigger}.command "${decl.command}" is not declared in provides.commands`,
        );
      }
      if (typeof decl.optional !== "boolean") {
        throw new Error(`hooks.${trigger}.optional must be boolean`);
      }
      if (typeof decl.description !== "string") {
        throw new Error(`hooks.${trigger}.description must be a string`);
      }
    }
  }

  if (!Array.isArray(manifest.tags)) {
    throw new Error("tags must be an array");
  }
}

/**
 * Validate a single `extensions.yml` hook entry (the per-extension object
 * stored under `hooks.<trigger>[]`). Used by `speckit-yaml.ts` before
 * writing entries.
 */
export function validateHookEntry(entry: HookEntry): void {
  if (typeof entry.extension !== "string" || entry.extension.length === 0) {
    throw new Error("hook entry: extension must be a non-empty string");
  }
  if (typeof entry.command !== "string" || entry.command.length === 0) {
    throw new Error("hook entry: command must be a non-empty string");
  }
  if (typeof entry.enabled !== "boolean") {
    throw new Error("hook entry: enabled must be boolean");
  }
  if (typeof entry.optional !== "boolean") {
    throw new Error("hook entry: optional must be boolean");
  }
  if (
    typeof entry.priority !== "number" ||
    !Number.isInteger(entry.priority) ||
    entry.priority < 0
  ) {
    throw new Error("hook entry: priority must be a non-negative integer");
  }
  if (typeof entry.prompt !== "string") {
    throw new Error("hook entry: prompt must be a string");
  }
  if (typeof entry.description !== "string") {
    throw new Error("hook entry: description must be a string");
  }
  if (entry.condition !== null && typeof entry.condition !== "string") {
    throw new Error("hook entry: condition must be string | null");
  }
}
