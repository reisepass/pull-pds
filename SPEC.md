# Pull-PDS snapshot protocol — experimental implementation

This document describes the implemented extension. It is not an accepted AT Protocol specification. The server exposes a subset of AT Protocol sync and read APIs; it does not implement normal account signup, OAuth sessions, arbitrary write APIs, blobs, or a complete Bluesky PDS.

## Identity and discovery

A publisher uses `did:web:<hostname>` and serves its DID document at the HTTPS well-known DID URL. The document includes an `id` matching the derived DID, an `alsoKnownAs` handle, an `#atproto` Multikey verification method, and an `#atproto_pds` service of type `AtprotoPersonalDataServer`.

The service endpoint must exactly equal the configured PDS endpoint, and the advertised public key must equal the PDS's shared signing key. Each publisher delegates repository signing to that PDS. Ports and path-based DIDs are not supported in production.

`GET /.well-known/atproto-pull-pds` returns:

```json
{
  "pdsDid": "did:web:pds.example.com",
  "aggregatorDid": "did:web:pds.example.com",
  "signingPublicKeyMultibase": "<public Multikey>",
  "atprotoPdsEndpoint": "https://pds.example.com",
  "hub": "https://pds.example.com/websub",
  "allowedCollections": ["com.example.sensor.reading"],
  "feedSchema": "app.pullpds.feed",
  "ingestMode": "snapshot",
  "maxFeedBytes": 1048576,
  "minPingIntervalSec": 60
}
```

The old `atproto-pull-aggregator` well-known route and `aggregatorDid` field remain compatibility aliases.

## Snapshot

The topic URL is an HTTPS resource on the publisher's own hostname. Its JSON body is:

```json
{
  "$type": "app.pullpds.feed",
  "did": "did:web:publisher.example.com",
  "records": [
    {
      "collection": "com.example.sensor.reading",
      "rkey": "co2",
      "record": {
        "$type": "com.example.sensor.reading",
        "sensorId": "demo-station",
        "metric": "co2",
        "value": 412,
        "unit": "ppm",
        "observedAt": "2026-09-22T12:01:00Z"
      }
    }
  ]
}
```

The records array is the complete desired state, not a patch. Omission deletes an existing record. Duplicate collection/key pairs, invalid NSIDs or record keys, non-object records, excessive nesting, unsafe or fractional numbers, and unallowlisted collections reject the batch. Bundled lexicons additionally enforce their schemas and reject undeclared top-level fields. Custom allowlisted collections without bundled schemas receive structural checks only. Collections under `app.bsky.`, `chat.bsky.`, `com.atproto.`, and `tools.ozone.` can never be allowlisted: configuration fails if they are listed.

JSON numbers must be safe integers for DAG-CBOR encoding, so choose units that avoid fractions. The feed is not itself signed by the publisher; HTTPS origin binding authenticates its retrieval, and the PDS signs the resulting repository.

## Notification and ingestion

Send an URL-encoded POST to the hub with `hub.mode=publish` and `hub.url=<topic URL>`. The hub responds 202 for an accepted notification; later fetch or validation can still fail. Anyone can send a ping, but a ping cannot supply another origin's record bytes.

The PDS re-resolves the DID document on every ingest, checks origin/identity/endpoint/key bindings, fetches the feed with bounded size and timeout, validates the entire snapshot, computes a repository diff, and signs and persists changes. Per-DID requests are serialized. An unchanged snapshot produces no commit. The first committed snapshot emits identity/account information and a sync event as well as its commit. Subsequent commits appear on `com.atproto.sync.subscribeRepos`.

Stored ETags support no-change detection; the implementation also compares content-derived record CIDs. This is not a guarantee of a fully transactional database operation spanning every per-repository, metadata, and sequencer database under a process crash.

## Limits and configuration

Defaults: 1 MiB feed, 10,000 records per repo, nesting depth 32, 5-second fetch timeout, and 60-second notification debounce. Admission defaults cap a registrable domain at eight DIDs, four new DIDs per hour, and 240 new DIDs per hour globally. These discourage abuse but do not establish personhood or eliminate Sybils. Retention prunes old sync history, so consumers must handle unavailable cursors and resynchronize.

Supported settings include `SELF_ENDPOINT`, `PDS_DID`, `PDS_SIGNING_KEY`, `ALLOWED_COLLECTIONS`, `MAX_FEED_BYTES`, `MAX_RECORDS_PER_REPO`, `MIN_PING_INTERVAL_SEC`, `FETCH_TIMEOUT_MS`, `DATA_DIR`, `HOST`, and `PORT`. Persistent storage requires an explicit signing key. Memory-only development may use an ephemeral key. The legacy `AGG_DID` and `AGG_SIGNING_KEY` aliases remain supported with warnings.

`KEY_MODE` must be `shared`, `INGEST_MODE` must be `snapshot`, `DID_DOC_TTL_SEC` must be zero, and `PDS_CRAWLERS` must be empty. Automatic relay registration, per-publisher keys and oplog ingestion are not implemented. Relay crawl requests are an explicit operator action.

## Trust

The shared PDS can fabricate commits for every delegated publisher. Consumers verify the advertised key and repository structure, not the factual accuracy of observations. A key rotation must coordinate the PDS key, every affected DID document, and repository/sync state. Changing only an environment variable is not a complete rotation.

See the official AT Protocol DID and sync specifications for the surrounding protocol: https://atproto.com/specs/did and https://atproto.com/specs/sync.
