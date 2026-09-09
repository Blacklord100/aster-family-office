# Aster local client plugin

An installable Codex plugin and generic Streamable HTTP MCP endpoint for an existing Aster installation. The package contains no credentials, model weights or server process. Aster stays on your own machine or private server. It must already be running.

## Connect

1. In Aster, sign in as an office-wide owner or administrator with MFA. Open **Connections → Apps & agents** and create a short-lived token. Choose only the scopes the client needs. The token is shown once.
2. Configure the client host's `ASTER_MCP_TOKEN` environment variable through its secret mechanism. Never paste the token into a conversation, commit it, put it in a URL, or pass it as a command-line argument. Aster stores only the hash. Tokens expire after 1, 7 or 30 days and can be revoked immediately in Aster.
3. Register this repository's distributable marketplace on the client host, then install the package. Replace `/absolute/path/to/app` with your checkout or extracted package root:

   ```sh
   codex plugin marketplace add /absolute/path/to/app
   codex plugin add aster-local@personal
   ```

   The package root contains `.agents/plugins/marketplace.json` and `plugins/aster-local/`; keep both when distributing it. The generated marketplace is named `personal`. If your client already has a marketplace with that name, use the direct MCP configuration below or have your deployment administrator package a distinct marketplace name before registering it. The plugin's `.codex-plugin/plugin.json` is the package manifest and `.mcp.json` bundles the authenticated HTTP connection. The application build does not install this marketplace or change the current user's client configuration.
4. The default endpoint is `http://localhost:3000/api/mcp`. For another installation, edit `.mcp.json` to its exact configured origin plus `/api/mcp`; use HTTPS for a remote host. Keep the header's environment-variable reference, never replace it with a literal secret. The hostname must agree with Aster's `BETTER_AUTH_URL`, including `localhost` versus `127.0.0.1`.
5. Start a fresh client session with the secret available and list the Aster tools. For direct Codex MCP setup without the plugin, use `codex.config.toml.example` instead. [Official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) documents environment-backed bearer tokens. Other MCP clients can use the same endpoint and `Authorization: Bearer …` from their protected credential store.

A cloud client can receive the data it reads through MCP even when Aster uses local Gemma. For an offline installation, use a client that runs locally with networking disabled except the approved local Aster endpoint. This package does not turn on a cloud provider or expose localhost publicly.

## Available tools

| Scope | Tools |
| --- | --- |
| `portfolio:read` | `list_holdings`, `list_timeline`, `read_exposure` |
| `sources:read` | `list_sources`, `read_source`, `list_processing`, `read_processing` |
| Both portfolio and sources | `list_reporting_calendar`, `list_exceptions` |
| `mailboxes:read` | `list_mailboxes` |

All tools are read-only, bounded, tenant scoped and audited. Original files and parsed reviews require `sources:read`; mailbox status does not include OAuth credentials or message bodies. There are no send, upload, synchronization, review-acceptance or portfolio-write tools. Source reads through MCP do not satisfy the human original-preview control in Aster. Expired tokens, removed memberships, downgraded roles and disabled MFA invalidate access. Family/entity-scoped viewer accounts cannot issue office-wide MCP tokens.

`list_processing` reports all matching jobs, including retries and both model modes; follow `nextOffset`. `read_processing` preserves the original fact alongside the reviewed amendment and status. `read_exposure` uses Aster's deterministic calculations, keeps undisclosed weights unknown, and returns coverage and warnings. Calendar date filters use the UTC deadline date and only read existing monitor results. Exception histories return the latest 20 entries with an explicit count/truncation flag; the full history stays in Aster.

## Email and folder ingestion

Aster's Connections interface is the ingestion boundary. Gmail and Microsoft 365 use per-mailbox OAuth consent and durable synchronization workers. Local demo folders import actual `.eml`, `.pdf` and `.txt` source bytes through the same processing queue. Several authorized mailboxes can belong to one office; multiple families remain explicitly mapped and reviewed inside that office.

This plugin reads what Aster has imported. It does not bypass provider consent, impersonate another mailbox user, or silently download all email through a client token. Real Gmail/Microsoft consent must be configured and tested against an operator's tenant before live use. Demo folders need no provider credentials.
