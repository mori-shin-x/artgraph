/**
 * Public surface for the SDD-integration subsystem.
 *
 * Consumers (the CLI in `src/cli.ts`, future `runInit` extensions) import
 * from this barrel. Individual provider modules live under
 * `src/integrate/providers/` and are wired in via {@link registerBuiltinProviders}.
 */
export { runIntegrate } from "./runner.js";
export type { RunIntegrateOptions } from "./runner.js";
export { getProvider, listProviders, registerProvider } from "./registry.js";
import { getProvider, listProviders, registerProvider } from "./registry.js";
import { SpecKitProvider } from "./providers/speckit.js";
import { KiroProvider } from "./providers/kiro.js";
import type { IntegrationStatus } from "../types.js";

/**
 * Register every provider that ships with artgraph. Called at CLI startup
 * and lazily by `detectProject` so that callers who never touch the CLI
 * (tests / library use) still see the built-ins in `getProviderStatuses`.
 *
 * Idempotent: re-invocation simply skips ids that are already registered.
 * The earlier one-shot guard caused trouble after `clearProviders()` so
 * we now rely on per-id `getProvider` checks instead.
 *
 * Registration order is significant: `listProviders()` preserves it, and
 * the `integrate list` / init Tip surfaces show providers in this order.
 */
export function registerBuiltinProviders(): void {
  if (!getProvider("speckit")) {
    registerProvider(new SpecKitProvider());
  }
  if (!getProvider("kiro")) {
    registerProvider(new KiroProvider());
  }
}

/**
 * Snapshot every registered provider's `detect` / `isInstalled` against
 * `rootDir`. Used by `integrate list` and `init`'s Tip + one-shot paths so
 * that detection logic stays unified (FR-019).
 *
 * Pure: no filesystem mutation; reads only.
 */
export function getProviderStatuses(rootDir: string): IntegrationStatus[] {
  // Lazy ensure built-ins are present so library callers (e.g. detectProject)
  // see them even if cli.ts was never imported.
  registerBuiltinProviders();
  return listProviders().map((p) => ({
    providerId: p.id,
    displayName: p.displayName,
    marker: p.marker,
    detected: safeProviderCheck(p.id, "detect", () => p.detect(rootDir)),
    installed: safeProviderCheck(p.id, "isInstalled", () => p.isInstalled(rootDir)),
  }));
}

/**
 * Run a provider's `detect` / `isInstalled` guarded against exceptions.
 *
 * `IntegrationProvider.detect` / `.isInstalled` are documented as
 * side-effect-free checks that shouldn't throw, and both built-in providers
 * (`SpecKitProvider`, `KiroProvider`) honor that today — Spec Kit's YAML
 * parsing failures are already caught internally and folded into `false`.
 * This wrapper is a defense-in-depth backstop for third-party / future
 * providers that don't uphold the contract: one misbehaving provider must
 * not crash `artgraph init` / `integrate list` for everyone else, so we
 * fall back to `false` and surface a warning instead of propagating.
 */
function safeProviderCheck(
  providerId: string,
  method: "detect" | "isInstalled",
  fn: () => boolean,
): boolean {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `WARNING: provider "${providerId}".${method}() threw and was treated as false: ${msg}`,
    );
    return false;
  }
}
