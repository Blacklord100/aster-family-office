# Public source review

The initial history review was performed on 12 September 2026 against
`0e0bed07a2867118e75aa00bda110b9bc6a36bdd`. The repository was not shallow:
34 reachable commits, 1,517 distinct blobs and 16,481,877 blob bytes were inventoried.
No tracked history paths matching private environment files, private keys, backup
payloads or browser authentication storage were found.

Gitleaks 8.30.1 scanned all reachable history with full redaction. Its ten candidates
were individually reviewed: nine source-file SHA256 values in a synthetic benchmark
reproducibility record and one replay UUID in a schema validation test. No unresolved
credential candidate remained. The exact historical fingerprints and reasons are
retained in `tools/release/history-secret-review.json`; this is not a general
allowlist for those files, keywords or future commits.

The binary inventory contains 128 historical PDF blobs, two bundled Geist font
files and a public upstream TIFF signature. Of the PDFs, 120 have extractable text;
five image-only fixtures were rendered and visually checked as synthetic; three
encrypted fixtures were verified against their checked-in synthetic generator and
fictional-document footer. No live customer archive or mailbox export was identified.
Geist's upstream SIL Open Font License notices are retained under `licenses/geist/`.
Imported Tesseract security patches retain upstream license and authorship headers.
Generated shadcn/ui registry components retain their MIT notice in
`licenses/shadcn-ui/`; the Apache project license does not remove that notice.

Run the repeatable credential check against the final publication commit:

```sh
python3 tools/release/audit-history.py --repo . \
  --gitleaks /absolute/path/to/verified/gitleaks \
  --output /private/new-review-directory
```

Use the publisher's authenticated release/checksum for the scanner. The tool refuses
shallow history, preserves a redacted report, and fails on every candidate not tied
to an exact reviewed historical fingerprint. It does not read operator .env files.
New assets and source files need their own data/provenance review. Automated scanning
does not prove the absence of every possible secret or certify copyright ownership.

The project license is Apache-2.0. Dependency, OS, font, model and GPU components
retain their own terms; collect their exact release notices and corresponding source
where required. See [third-party notices](THIRD_PARTY_NOTICES.md). A current-tree or
history secret scan is distinct from the image vulnerability gate.

Public source availability does not imply a production-qualified appliance. Retain
the exact candidate's functional, recovery and security evidence, disclose remaining
limitations, enable the private reporting route in [SECURITY.md](SECURITY.md), and
publish versioned source from a reviewed commit. Only release artifacts made from
that reviewed source belong in the downloadable distribution; operator environments,
private validation results, live volumes, archives and backups do not.
