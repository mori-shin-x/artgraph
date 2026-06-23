import type { IntegrationProvider, IntegrationProviderId } from "../types.js";

/**
 * In-memory registry of {@link IntegrationProvider} implementations keyed by
 * id. Insertion order is preserved so `listProviders()` is deterministic and
 * `integrate list` output is stable.
 *
 * Contract: specs/009-sdd-integration/contracts/integration-provider.md
 * §レジストリ契約
 */
const providers = new Map<IntegrationProviderId, IntegrationProvider>();

export function registerProvider(provider: IntegrationProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Provider "${provider.id}" is already registered`);
  }
  providers.set(provider.id, provider);
}

export function getProvider(id: IntegrationProviderId): IntegrationProvider | undefined {
  return providers.get(id);
}

export function listProviders(): IntegrationProvider[] {
  // Map iteration is insertion-ordered (ECMAScript spec) — listProviders
  // therefore returns providers in the order they were registered.
  return Array.from(providers.values());
}

/**
 * Test-only helper to reset the registry between unit tests. Not exported
 * from `index.ts` to keep production code from clearing built-in providers.
 */
export function clearProviders(): void {
  providers.clear();
}
