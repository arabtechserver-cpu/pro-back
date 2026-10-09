# Complete provider catalog

## Standard clients

`imeiservicelist` exports all available IMEI, server and remote groups, including enabled FoxReload products. DHRU 6.1 documents this as the shared list action: [official standard](https://github.com/dhru-com/dhru-fusion-api-standards).

Each group has `GROUPTYPE`; each service has `SERVICETYPE`. Business sections travel separately in `section_id`/`category_key` (topups, game-currency, app-stores, subscriptions, esim and rewarble). This preserves the order protocol while allowing storefront filters.

The standard response uses `SUCCESS[0].LIST`, with group/service dictionaries. `format=array` explicitly requests arrays. Generic `services`/`getservices` actions retain their legacy aliases. `serverservicelist` and `remoteservicelist` return their actual protocol subsets. `service_type=imei` requests a strict IMEI subset; `section=esim` requests one business section.

The exported `ID` and `SERVICEID` are consistent. Existing provider-scoped IDs remain valid. Identical group names with different types are not overwritten. Selecting a protocol or business section filters the full snapshot; it does not delete other groups.

## Complete discovery and efficient refresh

Standard catalog JSON streams service by service with backpressure and small write chunks. It does not allocate a whole serialized catalog for every connected client. Available zero-price products remain visible; missing, invalid and negative prices are excluded.

FoxReload pages are read using its documented cursor/offset pagination, rather than stopping at 100 products per category: [API specification](https://public-api.foxreload.com/openapi.json). A bulk cursor walk replaces calls to every bundle and region. Required and optional fields, field types/options and real quantity limits survive export. No Player ID requirement or maximum of ten is fabricated.

Only complete provider product snapshots are published. A temporarily unavailable page preserves the cursor and previously fetched pages for the next refresh; partial pages never become a successful FoxReload list. Repeated cursors or missing continuation reset invalid pagination. Exactly one complete provider snapshot is shared across clients, so a byte budget cannot silently discard a large catalog and restart discovery indefinitely. Optional category/export caches retain their byte budgets. No process RAM or heap limit was added. Catalog/settings changes invalidate exported snapshots. Popular bundles retain their actual business section.

With background jobs enabled, startup begins one catalog warmup and a timer checks freshness every ten minutes. The shared provider refresh has a fifteen-minute watchdog; failed pages have a 30-second retry backoff. HTTP catalog lists return ready database services and the last complete provider snapshot without waiting for external discovery. Strict IMEI and remote lists require no FoxReload connection. Their existing 25/29-second backend/proxy deadlines remain in place for authentication, database reads and transmission.

On first startup with no complete provider snapshot, additional provider services refresh in the background. The response explicitly sets `catalog_complete=false`, `refreshing_sources=["foxreload"]`, `X-Catalog-Complete: false` and `Retry-After: 5`. Ready services remain available. The provider browser displays the refresh warning; full synchronization rejects an incomplete source list rather than treating it as complete. Once a complete provider snapshot is published, later requests include it automatically. First discovery of a slow upstream still cannot promise all remote products within 30 seconds.

Complete product snapshots and available section metadata are saved atomically as compressed JSON lines in the private `backups/.catalog/foxreload.jsonl.gz` directory, outside public static paths. Restore checks the settings fingerprint, completion footer and maximum 24-hour age; credentials are not written. Set `FOXRELOAD_CATALOG_CACHE_DIR` only if an existing private persistent directory is preferred. Restart restore requires that directory to survive the restart/redeploy; no hosting, volume or database configuration was changed here. A missing, invalid or mismatched file falls back to background discovery without blocking local services. Publications serialize and coalesce to prevent an older write replacing a newer snapshot.

The frontend preserves a known backend address after a request timeout. Only connection or DNS failures clear that address. A 504 alone does not prove the backend stopped, and mutation requests are not replayed automatically.

## Verification and deployment

Production builds, API/security regression tests, provider field/quantity tests and frontend section-filter tests pass. Mock integration covers a single-list DHRU client, all business sections, overlapping lists, section filters, resumable pagination, private snapshot restore, and shared refresh surviving a reader timeout. With FoxReload stalled, 32 concurrent catalog readers reuse one database build; actual POST requests for the three standard lists return HTTP 200 with accurate readiness. Proxy tests distinguish deadlines from DNS/connection failures.

A read-only local cold catalog check returned 1,197 ready services in 168 ms (615 IMEI, 549 server and 33 remote), with FoxReload explicitly marked as refreshing. This is a local measurement, not production latency or proof that the upstream full catalog has completed. The earlier live FoxReload cold walk did not complete within five minutes.

Deploy/rebuild both repositories, allow the first background refresh to finish, then choose **API Live / Sync from provider** on the client. No database migration or live database update is required by this patch; it does not automatically import services into a client's site.

After building the backend, `node validation/check-exported-catalog.cjs --available` checks immediately available services, readiness and timing without waiting for external discovery. The command without a flag performs full verification and can wait up to fifteen minutes for warmup. `--probe` reads just one provider page. These checks perform no database or order writes and print no service data or credentials.
