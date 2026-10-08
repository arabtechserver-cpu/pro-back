# API reliability changes

Changes are built and tested locally. They have not been deployed to the running server.

## Behavior

- Saving API settings preserves the client's existing key. Only the explicit key regeneration endpoint rotates it. Concurrent activations initialize one key atomically.
- The client's own profile returns its current API key. Admin user lists continue to exclude API keys.
- Client requests normalize the stored token, support the legacy token storage key, and clear an expired session once. A delayed response cannot sign out a newer session. Changing a password returns a new token while revoking older sessions.
- Catalog reads have a 25-second application deadline. External API authentication has a 3-second deadline, and the frontend proxy has one 29-second budget covering backend discovery and response-body reading. A timeout returns an error; it does not guarantee successful provider fulfillment within 30 seconds.
- DHRU groups return their matching packages without querying FoxReload. Group IDs avoid shared-prefix collisions, and service discovery no longer truncates at 200 rows.
- Merged catalogs include all bundles and regions. Requests share an in-progress refresh, provider fan-out is bounded, and successfully cached snapshots can be served during refresh. Provider failures do not replace a successful product cache with an empty list.
- Order confirmations return after saving the order and charging the wallet; Telegram delivery runs asynchronously.
- Provider dispatch from the dashboard and Telegram saves provider identity and service type for later synchronization. A missing original provider is recorded as `MISSING_PROVIDER_CONFIGURATION`; it does not trigger an automatic refund or reassignment to another provider.

## Deployment

1. Deploy/rebuild both backend and frontend from this workspace. No database schema migration was added.
2. For Telegram polling, run exactly one polling instance for each bot token. Set `TELEGRAM_UPDATES_MODE=polling` on that instance and `disabled` on other instances. When a separate service owns the webhook, set this backend to `webhook` (this setting does not create a webhook receiver).
3. Polling checks the webhook and removes it once during startup, preserving pending updates. It stops with an actionable log on a later 409 rather than repeatedly deleting another service's webhook. See [Telegram's update and webhook documentation](https://core.telegram.org/bots/api#getupdates).
4. Users with expired or revoked login sessions must sign in again. Preserve the deployed `JWT_SECRET` across restarts.
5. Restore the original provider mapping for order ending `4b41ae`, provider reference `479408`, in the running database. That order is absent from the local database, so its original provider could not be established here. Provider status `0` for the other logged order means it remains in progress; it must not be marked completed without a provider result.

## Verification

Both production builds passed. Backend security, wallet/provider regressions, API reliability and Telegram persistence checks passed; frontend type checking, token handling and session race checks passed.

Local database read: 195 DHRU groups loaded in 67 ms; packages for one group loaded in 70 ms. These measurements are local and do not establish production latency or remote provider availability.

After building the backend, run `npm test` there. Frontend session checks: `node client-auth-token.test.js` and `node user-api-fetch.test.js`.
