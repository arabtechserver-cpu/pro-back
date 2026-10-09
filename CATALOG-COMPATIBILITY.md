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

## eSIM discovery

eSIM is a provider business section, while its ordering protocol remains `SERVER`. Country plans such as `10 GB / 30 days` do not contain the word eSIM. Discover them from the documented category subtree using `categoryId=esim`, `includeDescendants=true` and `nextCursor`, rather than text search or a fixed category UUID. A dedicated, shared and resumable eSIM refresh publishes independently of the global catalog. Country/region metadata accompanies the plans; deeper unmatched categories still keep their known eSIM section. A complete scoped `section=esim` response reports complete readiness even if other sections are refreshing. Combined lists deduplicate products shared with the global snapshot.

The complete eSIM snapshot restores from the private `foxreload-esim.jsonl.gz` file with the same fingerprint, footer and age validation as the global snapshot. The provider browser distinguishes stored services from API Live: a stored zero count means no eSIM services have been imported. Its empty eSIM view offers a live refresh while preserving the selected tab. Import the desired country bundles to make them available to customers; the patch does not write imported services to the database automatically. Device compatibility checks mentioning eSIM remain IMEI services.

Live verification on 2026-10-08 read 13,766 in-stock plans from 243 upstream category entries and exported all 13,766 under eSIM in 242 nonempty groups. The first complete read took about 175 seconds with a slow provider page; it runs in the background for HTTP readers. A new process restored the saved plans and local services in 531 ms; the expanded field/region export was rechecked in 1,127 ms. These are local verification measurements, not a guaranteed provider refresh duration or combined frontend/backend RAM measurement.

## FoxReload fields and hierarchy

The standard flat DHRU list preserves the storefront hierarchy in one group per bundle/region, with stable IDs derived from upstream category IDs. Group and product metadata include bundle/region IDs and names, section and category ID; titles distinguish identical plan names in different regions. Products additionally expose their original name, description, user guide, delivery type, attributes, stock, required note fields, native field types/options, and real quantity limits. Both description and instructions survive INFO import. No delivery time is invented; FoxReload prices retain the four-decimal unit price used for API order calculation.

Custom fields use their actual input type. Legacy options contain submitted values, while additive option_choices preserves each value/label pair across export, import, JSON storage and repeated normalization. Customer forms display labels and submit the exact provider values; both the native FoxReload form and imported-service form render optional fields and appropriate input controls. Modern package lookup accepts the group IDs returned by the standard list and preserves region/field metadata. Zero stock and an empty required-fields list remain accurate.

Website and API FoxReload orders share validation against the fresh provider product before billing. It checks quantity bounds/stock, required fields, numeric types, emails and exact select values; optional zero values and identifiers with leading zeroes survive. Only declared fields are sent, and products with no account requirement receive no invented account_id. Structured notes and DHRU customfield/custom_ inputs are accepted by the API. Existing clients must synchronize or reimport service definitions to receive corrected fields and grouping. The patch does not change the database schema or automatically rewrite imported services.

## Verification and deployment

Production builds, API/security regression tests, provider field/quantity tests and frontend section-filter tests pass. Mock integration covers a single-list DHRU client, all business sections, overlapping lists, section filters, resumable pagination, private snapshot restore, and shared refresh surviving a reader timeout. With FoxReload stalled, 32 concurrent catalog readers reuse one database build; actual POST requests for the three standard lists return HTTP 200 with accurate readiness. Proxy tests distinguish deadlines from DNS/connection failures.

A read-only local cold catalog check returned 1,197 ready services in 168 ms (615 IMEI, 549 server and 33 remote), with FoxReload explicitly marked as refreshing. This is a local measurement, not production latency or proof that the upstream full catalog has completed. The earlier live FoxReload cold walk did not complete within five minutes.

Deploy/rebuild both repositories, allow the first background refresh to finish, then choose **API Live / Sync from provider** on the client. No database migration or live database update is required by this patch; it does not automatically import services into a client's site.

After building the backend, `node validation/check-exported-catalog.cjs --available` checks immediately available services, readiness and timing without waiting for external discovery. `--esim` verifies the complete eSIM subtree independently. The command without a flag performs full verification and can wait up to fifteen minutes for warmup. `--probe` reads just one provider page. These checks perform no database or order writes and print no service data or credentials.
