import type { InstallOptions, IntegrateResult, IntegrationProviderId } from "../types.js";
import { getProvider } from "./registry.js";

/**
 * Options accepted by {@link runIntegrate}. Mirrors the CLI flags on
 * `artgraph integrate <tool>`.
 */
export interface RunIntegrateOptions extends InstallOptions {
  /** Remove the integration instead of installing it. */
  uninstall?: boolean;
}

/**
 * Dispatch entry point used by the CLI and by `init --integrate=...` to
 * apply (or remove) a single SDD-tool integration. Pure orchestration: the
 * actual filesystem effects live in each provider's `install` /
 * `uninstall`.
 *
 * Contracts:
 * - specs/009-sdd-integration/contracts/integrate-cli.md §1
 * - specs/009-sdd-integration/contracts/integration-provider.md §ライフサイクル契約
 */
export function runIntegrate(
  rootDir: string,
  tool: IntegrationProviderId,
  opts: RunIntegrateOptions,
): IntegrateResult {
  const provider = getProvider(tool);
  if (!provider) {
    throw new Error(`unknown integration tool: ${tool}`);
  }

  if (opts.uninstall) {
    return provider.uninstall(rootDir);
  }

  // Strip the runner-only flag before delegating; providers only see the
  // install-shaped options they care about.
  const { uninstall: _uninstall, ...installOpts } = opts;
  return provider.install(rootDir, installOpts);
}
