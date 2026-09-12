# Security policy

Aster is under active development. There is currently no production-qualified
stable release or long-term-support commitment. The latest development branch
receives fixes; earlier snapshots are not maintained release lines. Passing
functional tests does not clear a failing security or recovery qualification gate.
Known processor findings and candidate-specific evidence are recorded in
[processor release blockers](operations/processor-release-blockers.md).

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** action in this repository's Security tab:
https://github.com/Blacklord100/aster-family-office/security/advisories/new.
Do not put vulnerability details, office data, tokens, passwords, original emails,
or database dumps in a public issue or pull request. Provide a synthetic
reproduction, affected commit/image digest, impact and a redacted diagnostic
summary. Do not test against an office installation without its authorization.

Maintainers must enable private vulnerability reporting immediately upon making
the repository public, then verify that its reporting route is available. GitHub
provides this feature for public repositories. Configure responsible maintainers
and their notification settings as part of publication. If the action
is unavailable, open an issue requesting a private contact channel without
including vulnerability details. No response deadline is promised until a staffed
support policy is published.

## Maintainer handling

Keep reports private while confirming scope. Track impacted versions, tenant and
data boundaries, remediation, regression tests and coordinated disclosure. Rotate
exposed credentials; removing their text from Git does not revoke them. Publish
fixed artifact identities and security advisories when appropriate. Retain raw
scanner results and source evidence: exclusions, misleading package identities
and passing functional tests must not hide unresolved findings.

Offline installations require authenticated update media and independent recovery
material. Operators are responsible for host security, backups and supported
deployment configuration; see [operations](operations/README.md).
