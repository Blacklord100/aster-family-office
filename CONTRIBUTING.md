# Contributing to Aster

Please open an issue describing the problem and a synthetic reproduction before
starting a substantial change. Discuss financial metric definitions and data
provenance explicitly. Do not contribute customer documents, email credentials,
live database contents, browser sessions or production configuration.

## Development and validation

Use Node.js 24 and the versions pinned in package-lock.json. Start with `npm ci`,
then follow [the application README](README.md) and
[deployment documentation](operations/README.md) for local setup. Read
[AGENTS.md](AGENTS.md) and the installed Next.js documentation before changing
framework integration. The Python processor has its own pinned requirements and
[development instructions](processor/README.md).

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` for relevant
application changes. Run the relevant processor tests for extraction, OCR or
native changes. Database integration tests must use the positively guarded
disposable fixture database or isolated CI service; never point them at an office
or demo database. Refer to `.github/workflows/verify.yml` for the complete release
checks and required integration environment. Report tests not run and their reason.

Use synthetic fixtures with expected results and clear source provenance. A change
to a financial calculation needs a meaningful regression covering missing data,
scope and denominators. UI changes should include desktop/mobile interaction
checks. Preserve tenant boundaries, immutable source evidence, audit trails and
explicit human review of uncertain extracted facts.

## Rights and sign-off

Contributions are accepted under Apache-2.0, as described in [LICENSE](LICENSE).
Only submit material you have the right to contribute under those terms. Preserve
third-party licenses, copyright notices and modification records. Identify added
dependencies, imported code/assets and their source and license in the pull request.
Model names alone are not a redistribution license.

Sign off each commit with `git commit -s`. The sign-off certifies the
[Developer Certificate of Origin](DCO), not assignment of copyright. A maintainer
must review sign-offs before merging; automation is not currently an enforcement
guarantee. Security reports follow [SECURITY.md](SECURITY.md), not public issues.

Pull requests should explain the user-visible result, validation, migration or
compatibility effects and any remaining release limitations. Keep discussion
respectful and specific; see [the code of conduct](CODE_OF_CONDUCT.md).
