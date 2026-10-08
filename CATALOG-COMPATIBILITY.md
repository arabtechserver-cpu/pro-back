# Complete provider catalog

## Standard clients

`imeiservicelist` exports all available IMEI, server and remote groups, including enabled FoxReload products. DHRU 6.1 documents this as the shared list action: [official standard](https://github.com/dhru-com/dhru-fusion-api-standards).

Each group has `GROUPTYPE`; each service has `SERVICETYPE`. Business sections travel separately in `section_id`/`category_key` (topups, game-currency, app-stores, subscriptions, esim and rewarble). This preserves the order protocol while allowing storefront filters.

The standard response uses `SUCCESS[0].LIST`, with group/service dictionaries. `format=array` explicitly requests arrays. Generic `services`/`getservices` actions retain their legacy aliases. `serverservicelist` and `remoteservicelist` return their actual protocol subsets. `service_type=imei` requests a strict IMEI subset; `section=esim` requests one business section.

The exported `ID` and `SERVICEID` are consistent. Existing provider-scoped IDs remain valid. Identical group names with different types are not overwritten. Selecting a protocol or business section filters the full snapshot; it does not delete other groups.

## Complete discovery and efficient refresh

Standard catalog JSON streams service by service with backpressure and small write chunks. It does not allocate a whole serialized catalog for every connected client. Available zero-price products remain visible; missing, invalid and negative prices are excluded.

FoxReload pages are read using its documented cursor/offset pagination, rather than stopping at 100 products per category: [API specification](https://public-api.foxreload.com/openapi.json). A bulk cursor walk replaces calls to every bundle and region. Required and optional fields, field types/options and real quantity limits survive export. No Player ID requirement or maximum of ten is fabricated.

Only complete snapshots are cached. Failed pages, repeated cursors or a missing continuation for an incomplete result return an error. Cached data is bounded by bytes and shared across clients; these are cache budgets, not process RAM limits. Catalog/settings changes invalidate exported snapshots. Popular bundles retain their actual business section.

With background jobs enabled, startup begins one catalog warmup and a timer checks freshness every ten minutes. The shared provider refresh has a fifteen-minute watchdog, while HTTP readers keep their existing 22/25/29-second deadlines. Timing out an HTTP reader does not restart the refresh. The previous complete snapshot can serve while refreshing. A cold server can return a timeout until its first complete snapshot is ready; a slow upstream cannot guarantee successful cold discovery within 30 seconds.

## Verification and deployment

Production builds, API/security regression tests, provider field/quantity tests and frontend section-filter tests pass. Mock integration covers a single-list DHRU client, all business sections, overlapping lists, section filters and shared refresh surviving a reader timeout. A live local FoxReload cold walk did not complete within five minutes; production catalog latency and counts are not established by the mock tests.

Deploy/rebuild both repositories, allow the first background refresh to finish, then choose **API Live / Sync from provider** on the client. No database migration or live database update is required by this patch; it does not automatically import services into a client's site.

After building the backend, `node validation/check-exported-catalog.cjs` performs read-only full verification and prints counts and timing without service data or credentials. It can wait up to fifteen minutes for warmup. `--probe` reads just one provider page.
