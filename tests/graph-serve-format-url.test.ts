// issue #172 (C4/C5/C7) — unit tests for `formatServeUrl`, the helper
// `startServer` uses to build the URL it prints/returns. Exercises the
// three fixes in isolation (no real HTTP server needed):
//   C5 — an IPv6 host gets `[...]` bracketing in the URL authority.
//   C7 — `0.0.0.0` / `::` (bind-only "every interface" addresses) are
//        display-substituted for a loopback address a user can actually
//        visit — DISPLAY ONLY, this helper never touches the bind call.
//   C4 — the caller is expected to pass the ACTUALLY bound port (this
//        helper just formats whatever port it's given; the "read back
//        server.address()" half of C4 is covered by the e2e `--port 0` test
//        in tests/e2e/graph-serve.e2e.test.ts, since that needs a real
//        listening socket).
import { describe, expect, it } from "vitest";
import { formatServeUrl } from "../src/graph/serve.js";

describe("formatServeUrl (issue #172 C4/C5/C7)", () => {
  it("formats an ordinary IPv4 host/port with no bracketing", () => {
    expect(formatServeUrl("127.0.0.1", 3737)).toBe("http://127.0.0.1:3737");
  });

  it("formats a plain hostname with no bracketing", () => {
    expect(formatServeUrl("localhost", 8080)).toBe("http://localhost:8080");
  });

  it("C5: brackets an IPv6 loopback address", () => {
    expect(formatServeUrl("::1", 3737)).toBe("http://[::1]:3737");
  });

  it("C5: brackets an arbitrary IPv6 literal address", () => {
    expect(formatServeUrl("2001:db8::1", 4000)).toBe("http://[2001:db8::1]:4000");
  });

  it("C7: displays 0.0.0.0 as 127.0.0.1 (bind address unaffected, display only)", () => {
    expect(formatServeUrl("0.0.0.0", 3737)).toBe("http://127.0.0.1:3737");
  });

  it("C7: displays :: (IPv6 unspecified) as [::1], bracketed", () => {
    expect(formatServeUrl("::", 3737)).toBe("http://[::1]:3737");
  });

  // PR #346 review (M1) — `isUnspecifiedHost` (used by both this function's
  // C7 substitution and `startServer`'s C6 warning) recognizes every
  // spelling of the IPv6 unspecified address, not just the exact string
  // "::" — these two are equivalent binds that used to slip past both
  // string-equality checks.
  it("M1: displays ::0 (equivalent IPv6 unspecified spelling) as [::1], bracketed", () => {
    expect(formatServeUrl("::0", 3737)).toBe("http://[::1]:3737");
  });

  it("M1: displays 0:0:0:0:0:0:0:0 (fully expanded IPv6 unspecified) as [::1], bracketed", () => {
    expect(formatServeUrl("0:0:0:0:0:0:0:0", 3737)).toBe("http://[::1]:3737");
  });

  it("passes the port through unchanged, including 0 (caller's responsibility to pass the actual bound port)", () => {
    expect(formatServeUrl("127.0.0.1", 0)).toBe("http://127.0.0.1:0");
  });
});
