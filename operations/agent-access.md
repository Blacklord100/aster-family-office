# Apps and agents

Aster exposes a read-only MCP endpoint at `/api/mcp` on its configured origin. Open **Connections → Apps & agents** as an owner or administrator, create a named access token, and select its permissions and expiry. Authenticator enrollment is required. Copy the token once into your client's secure credential storage.

Use a client that supports Streamable HTTP with an explicitly configured Bearer token. This integration does not provide OAuth discovery or automatically connect a cloud assistant. The client receives the selected data; choose a local client when that is required by your data policy.

| Permission | Available tools |
| --- | --- |
| Holdings & timeline | `list_holdings`, `list_timeline` |
| Original documents | `list_sources`, `read_source` |
| Connection status | `list_mailboxes` |

The original-document permission includes imported email bodies and attachments. `read_source` returns a bounded base64 chunk of the exact retained file, with a continuation offset. Listing and reading sources never grants mailbox-provider tokens. Tool lists are filtered by granted permissions. There are no tools for sending email, changing holdings, accepting valuations or executing payments.

Configure the client's HTTP endpoint as your canonical HTTPS origin plus `/api/mcp`, with `Authorization: Bearer <access-token>`. Query-string credentials are rejected. Clients must send the normal MCP JSON and SSE Accept types, even though this endpoint uses stateless JSON responses. Empty tool arguments are `{}`. Use the MCP client's request APIs instead of building protocol messages manually.

Tokens expire after 1, 7 or 30 days. The database stores a SHA-256 hash, not the token. Access additionally requires the issuing user's active owner/admin membership and enrolled authenticator. Tokens are independent of browser sessions: signing out does not revoke them. Revoke unneeded access from the same screen. Access is checked on every request; reads are audited without storing the credential or source content in the audit details. Each token is limited to 120 requests per minute, and at most ten unexpired active tokens are allowed per workspace.

The endpoint uses the official [`@modelcontextprotocol/sdk` 1.30.0](https://ts.sdk.modelcontextprotocol.io/) Web Standards transport. Its stateless transport and initialization/tool calls are tested using the SDK client against the actual endpoint handler and PostgreSQL. See the official [transport guide](https://ts.sdk.modelcontextprotocol.io/server) and [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) for the protocol contract.

Run the integration suite only against a migrated disposable database, with explicitly configured runtime and maintenance credentials:

```sh
ASTER_MCP_INTEGRATION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run lib/server/mcp.integration.test.ts
```

The suite owns generated fixture IDs and removes them after use. It checks official-client negotiation, scope-filtered tools, original-byte retrieval, cross-organization rejection, credential hashing, auditing, expiry, membership removal, role downgrade, missing MFA, explicit revocation, invalid origins and request-size bounds. This does not certify the client you choose or its data handling.
