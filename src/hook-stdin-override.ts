// Test seam: when set, `hook-pretool` reads this string instead of
// process.stdin. Lets `runCli({stdin})` drive hook-pretool entirely
// in-process without having to mock the global stdin stream.
//
// Lives in its own module (rather than inside `cli.ts` or `commands/
// hook-pretool.ts`) because both the production command handler and the
// `runCli` test harness need to read/write the same module-scoped value
// without importing from each other.
let hookStdinOverride: string | undefined;

export function getHookStdinOverride(): string | undefined {
  return hookStdinOverride;
}

export function setHookStdinOverride(value: string | undefined): void {
  hookStdinOverride = value;
}
