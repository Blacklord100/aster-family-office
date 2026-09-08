# Email collection

Open **Connections → Mailboxes**. Choose 30 days, 90 days, one year or all available history, then connect an account. Each colleague signs into their own provider account and authorizes read-only access. Imported messages and attachments become available to authorized members of the selected Aster workspace. No password is requested by Aster for the mailbox itself.

The implementation supports Google Workspace/Gmail and Microsoft 365/Outlook accounts through delegated OAuth authorization with PKCE. Provider credentials have not been supplied in this development environment, so **no real mailbox connection has been exercised**. The Connections screen explicitly shows “Setup required” until the server configuration is complete.

## Register the provider applications

Choose the final canonical HTTPS origin first. Local development can use `http://localhost:3000` where permitted by the provider; register that URI separately and do not weaken production HTTPS requirements.

| Provider | Server settings | Authorized redirect URI |
| --- | --- | --- |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `https://YOUR-HOST/api/mailboxes/callback/gmail` |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` | `https://YOUR-HOST/api/mailboxes/callback/microsoft` |

For Google, create a web-application OAuth client, enable the Gmail API, configure the consent audience/test users, and register the exact callback. Aster requests `https://www.googleapis.com/auth/gmail.readonly` with offline access. Review Google's verification requirements for the chosen consent audience and Gmail scope before rollout. See [Google's web-server authorization guide](https://developers.google.com/identity/protocols/oauth2/web-server) and [Gmail scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes).

For Microsoft, register a **Web** redirect, choose the intended tenant/account audience, and add delegated `User.Read`, `Mail.Read` and `offline_access`. Set `MICROSOFT_TENANT_ID` to the reviewed tenant GUID, `organizations`, `consumers` or `common`; there is no implicit audience default. Aster does not request application-wide unattended permissions or send/write scopes. See [Microsoft's authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

For local development, keep these settings in the ignored mode-0600 `.env.local` and restart the web and mailbox worker. Never paste client secrets into the browser, commit them or put them in `NEXT_PUBLIC_*` settings.

For Compose, `generate-secrets.sh` creates an empty private `secrets/mailbox_providers` JSON file. Populate only the settings in the table above. Existing deployments must create this file explicitly; `{}` keeps provider connections disabled. The file is mounted only into web and mailbox-worker. The entrypoint rejects unsupported keys and conflicting credential sources. Use a managed secret store where appropriate. No email credentials are placed in Compose configuration or its public `.env` file.

## Run collection

```sh
npm run build:services
npm run mailbox:dev
```

The ordinary document worker and local processor must also be running to extract imported reports. In Compose, start `mailbox-worker` together with `web` and `worker`. It shares the runtime application image but has a separate command and heartbeat. Its networks are the internal database network and a dedicated internet-egress network. It has no processor/Ollama network membership or processor authentication token. Restrict its outbound destinations on the target host to the reviewed provider endpoints, and verify actual isolation there; Docker networking has not been run on this machine.

## Import behavior and limits

- Gmail captures a history cursor before backfill, pages all accessible messages in the chosen range including spam/trash, then follows added-message history. An expired history cursor triggers a new backfill with receipt deduplication. See [Google's synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync).
- Microsoft recursively discovers normal and hidden mail folders, skips virtual search folders, and keeps a separate delta cursor for each discovered folder. It revisits folder discovery approximately hourly. Original downloads request immutable message IDs. Deleted/moved-away entries do not delete retained Aster evidence; draft messages are excluded. See [mail-folder traversal](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0), [folder delta synchronization](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0) and [immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).
- Each account has a durable cursor, lease and independent schedule. Completed rounds wait five minutes; unfinished pages continue after one second. Source persistence and a per-account message receipt commit together. A page cursor only advances after all its messages have durable receipts, so a crash can replay a page safely.
- Original MIME is retained exactly, encrypted, and queued into the same local workflow/agentic extraction pipeline. The current organization policy is pinned when each new document job is created. Identical source bytes deduplicate across accounts within an organization, while separate mailbox receipts preserve import coverage. Nothing is accepted into holdings automatically.
- Each original is limited to 10 MiB. Oversized, disappeared or invalid MIME sources are recorded as skipped; the UI shows the skipped count. Supported attachments are handled by the existing bounded EML processor. This does not recover permanently deleted or otherwise provider-inaccessible messages.
- Provider requests have 20-second deadlines, no redirects and bounded bodies. Throttling respects Retry-After, with exponential retry delays and jitter for failures. A missing/revoked grant requires reauthorization. Pause/disconnect increments the connection generation and removes its schedule; old workers cannot commit against the changed generation.
- Disconnect deletes stored provider credentials and import cursors, and preserves imported records. It does not revoke the entire application's consent at the provider; users can also remove the provider-side grant in their account settings. Reconnecting rescans the selected history and deduplicates already imported messages.
- This release caps each workspace at 100 mailbox records and Graph discovery at 1,000 folders. Cursor and provider-page size bounds fail visibly instead of silently skipping coverage. Provider/live-account behavior, very large accounts, shared/delegated mailboxes, sovereign clouds and real consent policies still require testing. Push webhooks and domain-wide administrator impersonation are not implemented.

## Verification

`lib/server/mailbox-pages.test.ts` covers Gmail history/backfill, expired cursors, nested Graph folders, delta pagination, deleted/draft events, credentialed/foreign continuation rejection, byte preservation, response limits, throttling and read-only scope validation.

The opt-in `ASTER_MAILBOX_INTEGRATION=1` suite uses actual PostgreSQL and synthetic provider responses. It checks PKCE/session-bound one-time state, both provider account types, encrypted credentials, RLS, persisted imports, pinned policy, duplicates, stale leases, retry scheduling, token refresh and pause/disconnect. It also runs the native encrypted recovery drill while an imported source and encrypted mailbox state exist. It does not substitute for a real provider consent/backfill trial.
