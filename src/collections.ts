/**
 * Collection NSIDs this system reads, in one place.
 *
 * PEER TELEMETRY: peer-published reliability telemetry about digital service
 * providers. The record schema was renamed from the product-specific
 * `app.omniroute.errorReport` to this vendor-neutral, OTel-shaped standard
 * (OTEL-TASK Part 2, AUTHORITY-FINAL) reformatted onto OTel GenAI
 * semantic-convention field names (see `OTEL-COMPAT.md`, `OTEL-DECISIONS.md`,
 * `MIGRATION.md`). Peer Telemetry is NOT an OpenTelemetry or CNCF project; we
 * adopt their GenAI attribute names and pin to a commit, but there is no
 * affiliation.
 *
 * AUTHORITY IS A NAMING CONVENTION, NOT AN ENFORCED CONSTRAINT. NSID validation
 * in `@atproto/syntax` is purely syntactic (at least 3 segments, ASCII
 * letters/digits/dashes/periods, no leading digit on the first segment, final
 * segment letters and digits only, 317 chars max). There is no DNS lookup, no
 * domain-ownership check, and no resolution anywhere in the code path. So the
 * authority prefix is just a name we pick - but we back it with a domain we
 * actually control (`peertelemetry.org`) so the convention is honest.
 *
 * The authority is a single parameterized constant (`NSID_AUTHORITY`) so
 * re-homing the standard is a one-line change here plus a lexicon file move,
 * nothing scattered through the tree.
 *
 * NOTE ON TIMING: changing the authority BEFORE public adoption costs nothing
 * (only these constants and the lexicon file paths move). AFTER adoption it
 * costs everyone - every integrator re-points, and every already signed record
 * keeps the prior NSID forever (see dual-read below). The authority is now
 * SETTLED at `org.peertelemetry` (backed by the registered, owned domain
 * `peertelemetry.org`), so this is the last authority change.
 *
 * DUAL-READ IS PERMANENT. Every record already published under the old product
 * NSID carries `app.omniroute.errorReport` inside signed, immutable,
 * content-addressed bytes and can never be rewritten. So the indexer, the
 * AppView, and the ingest allowlist must accept the legacy NSID indefinitely.
 * This is not a cutover; the old name never goes away. New writes use the
 * current NSIDs; reads span all of them. See `MIGRATION.md`.
 */

/**
 * The NSID authority prefix (reverse-DNS domain) for this standard. SETTLED at
 * `org.peertelemetry`, backed by the registered, owned domain
 * `peertelemetry.org`. Change this ONE constant plus the on-disk lexicon
 * directory to re-home the schema, but note it is now settled and this should
 * not change again.
 */
export const NSID_AUTHORITY = 'org.peertelemetry';

/**
 * Current error-metrics record NSID. New writes use this. The namespace
 * (`org.peertelemetry`) carries the trust model (peer-published); the record
 * name (`errorMetrics`, camelCase per atproto convention) carries the domain
 * semantics. The `$type` lands inside signed immutable bytes, so the casing is
 * permanent (NAME-FINAL2).
 */
export const ERROR_METRICS_NSID = `${NSID_AUTHORITY}.errorMetrics`;

/**
 * Current usage-metrics record NSID, a SEPARATE opt-in collection under the same
 * authority. Kept here so the two collections share one authority constant.
 * Usage lives in its own collection, not as optional fields on the error record,
 * because the consent boundary differs (usage reveals competitive scale, errors
 * do not). See `USAGE-STATS-DESIGN.md`.
 */
export const USAGE_METRICS_NSID = `${NSID_AUTHORITY}.usageMetrics`;

/**
 * The original product-specific NSID. Immutable, signed into every pre-rename
 * record forever. Never emitted for new writes; always still read.
 */
export const LEGACY_ERROR_REPORT_NSID = 'app.omniroute.errorReport';

/**
 * Interim NSIDs from the `org.llmtelemetry` working default that preceded the
 * settled `org.peertelemetry` authority. These were NEVER PUBLISHED - the
 * authority was renamed (AUTHORITY-FINAL / NAME-FINAL2) before any record went
 * out under them. They are included in the read sets defensively (the constants
 * existed in committed code, so a stray record cannot be ruled out with
 * certainty) and documented as never-published rather than silently dropped.
 */
export const NEVER_PUBLISHED_ERROR_NSID = 'org.llmtelemetry.errorMetrics';
export const NEVER_PUBLISHED_USAGE_NSID = 'org.llmtelemetry.usageMetrics';

/**
 * Every NSID a consumer (indexer, AppView, ingest allowlist, Jetstream
 * `wantedCollections`, the filtered `subscribeRepos`, the retention pruner)
 * must accept for the ERROR signal. Current name first so it is the default
 * where a single value is still wanted (`[0]`). Includes the immutable legacy
 * NSID (dual-read) and the never-published interim `org.llmtelemetry.errorMetrics`.
 */
export const ERROR_METRICS_COLLECTIONS: readonly string[] = [
  ERROR_METRICS_NSID,
  LEGACY_ERROR_REPORT_NSID,
  NEVER_PUBLISHED_ERROR_NSID,
];

/**
 * The usage signal is a SEPARATE opt-in collection (USAGE-STATS-DESIGN.md §1):
 * the consent boundary differs, so it is a distinct NSID a publisher opts into
 * independently. It has no PUBLISHED predecessor (usage is new), but the
 * never-published interim `org.llmtelemetry.usageMetrics` is read defensively.
 * Kept separate from ERROR_METRICS_COLLECTIONS on purpose; a consumer that wants
 * both filters on ALL_TELEMETRY_COLLECTIONS.
 */
export const USAGE_METRICS_COLLECTIONS: readonly string[] = [
  USAGE_METRICS_NSID,
  NEVER_PUBLISHED_USAGE_NSID,
];

/**
 * All telemetry NSIDs, for a consumer (indexer / AppView) that indexes both
 * signals. The per-collection `wantedCollections` filter still lets a publisher
 * or a downstream consumer subscribe to one signal only; this is just the union
 * for a consumer that wants everything.
 */
export const ALL_TELEMETRY_COLLECTIONS: readonly string[] = [
  ...ERROR_METRICS_COLLECTIONS,
  ...USAGE_METRICS_COLLECTIONS,
];
