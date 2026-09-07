# Aster Family Office

A working, persistent family-office demonstration with a Linear/Notion-inspired workspace. All financial records, people, source messages and connected mailboxes are synthetic, fixed as of 7 September 2026.

## What works

- Consolidated EUR128m portfolio across three families, six entities and 21 holdings.
- Family, asset-class and entity filters; allocation by asset class, geography and currency; daily-linked time-weighted returns; liquidity and commitments.
- Investment timelines, original/revised statement excerpts, inbox review and linked tasks.
- A deterministic five-stage agent workflow: three copies of one capital call become one expected obligation; a corrected NAV restates the right historical period; news updates the timeline without altering cash.
- Repeat-run deduplication, cancellation before publication, persistent state, keyboard search and grounded sample answers.
- Immutable report snapshots, accurate CSV downloads and an A4 print / Save PDF view.
- Responsive desktop and mobile navigation.

## Run locally

Node 22.13 or later is required. Node 24 was used for validation.

```sh
npm ci
npx wrangler d1 migrations apply DB --local --config wrangler.local.jsonc
npm run dev -- --host 127.0.0.1 --port 3000
```

The D1 migration creates the workspace table; the first API request lazily seeds the sample state. Database writes use an optimistic revision check. Reset sample data from Workspace settings.

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

## Architecture and limits

Vinext/React on Cloudflare Workers, shadcn/Base UI primitives, Recharts, TypeScript, D1 persistence and Vitest. Financial calculations live in lib/finance.ts; the simulation lives in lib/demo-engine; lib/workspace.ts connects its accepted results to the UI.

This version has no live mailbox access, OCR, language-model calls, MCP servers, scheduled background workers, payment execution or production multi-tenant permission model. The agent stages advance while the workspace is open and resume on reload. Mailbox inventory totals are illustrative; only the included fixture evidence is inspectable. PDF-looking statement panels are synthetic HTML previews; their source excerpt downloads are text files.

Private marks carry forward between synthetic statements. Unrealized gain means NAV minus remaining cost basis. Value / cost is not TVPI. Notice amounts do not count as settled cash. The correction model currently handles one known restatement before the next independent valuation; broader accounting and live feeds require additional integration.

Live integration should preserve the existing evidence IDs, run stages and accepted-event boundary while replacing fixture intake with provider APIs, durable jobs, extraction and reconciliation. Keep financial calculations deterministic.

## Validation

Application lint excludes unchanged scaffold UI primitives.

29 financial, query, replay, cancellation and workspace integration tests. Browser checks cover family scopes, evidence review, persistence, report snapshots after corrections, CSV export, print layout, workflow run/replay/stop, search, assistant citations, mailbox sync, reset and mobile navigation.
