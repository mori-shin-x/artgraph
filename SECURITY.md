# Security Policy

## Supported versions

artgraph is pre-1.0. Only the **latest published minor release line** (the
newest `0.x` minor on [npm](https://www.npmjs.com/package/artgraph)) receives
security fixes. Because the project is pre-1.0, the public API may change
between minor releases, and previous minor lines are not maintained.

| Version              | Supported          |
| -------------------- | ------------------ |
| Latest `0.x` minor   | :white_check_mark: |
| Older release lines  | :x:                |

## Reporting a vulnerability

**Please do not file a public GitHub issue for security reports.**

Report vulnerabilities privately through GitHub's [Private Vulnerability
Reporting][PVR]:

1. Open the [Security tab][security] of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, steps to reproduce, affected versions, and — if you
   have one — a suggested mitigation.

[PVR]: https://github.com/mori-shin-x/artgraph/security/advisories/new
[security]: https://github.com/mori-shin-x/artgraph/security

## Response expectations

artgraph is maintained on a best-effort basis. For a valid report, we will:

- Acknowledge receipt within **7 days**.
- Triage and confirm (or reject) the report within **14 days** when feasible.
- Coordinate disclosure with the reporter and publish a fix as a patch release
  on the latest minor line.

No bug bounty program is offered.
