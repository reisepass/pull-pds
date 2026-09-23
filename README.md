# Pull-PDS

**Publish static JSON into AT Protocol repositories with a WebSub ping.**

Pull-PDS is an experimental PDS for small, public data publishers. A publisher serves a DID document and a JSON snapshot from an HTTPS origin. A shared server fetches that snapshot, validates it, signs repository commits, and exposes AT Protocol sync endpoints and a firehose.

The idea is to reduce publisher-side machinery: static hosting and a notification instead of running a repository server for every publisher. The shared PDS still needs hosting, storage, bandwidth, backups, and an operator. We have not demonstrated a general cost advantage over other PDS implementations.

```text
publisher HTTPS origin → WebSub notification → Pull-PDS fetch + validate
                                            → signed repository + firehose
                                            → relay / independent reader
```

**Peer Telemetry is the example application.** It demonstrates small aggregate service observations. The demo may contain synthetic data and is not a provider status authority. This project publishes AT Protocol records; custom records do not automatically appear as posts in the Bluesky app.

## Try it

Use Node 22.13 or newer. From the checked-out project:

```sh
npm ci
npm run build
npm test
npm run keygen
```

The key-generation command writes a new private environment file in the checkout, with owner-only permissions, refuses to overwrite it, and prints only the public key. Add these settings to that generated environment file, using your own HTTPS hostname:

```dotenv
SELF_ENDPOINT=https://pds.example.com
DATA_DIR=/var/lib/pull-pds
```

Create the data directory and give the service user ownership. Put a TLS reverse proxy in front of port 3000, including WebSocket upgrades. Start with the generated environment file at its absolute location; this example assumes a checkout at `/opt/pull-pds`:

```sh
node --env-file=/opt/pull-pds/.env /opt/pull-pds/dist/src/server/index.js
```

Then check the descriptor:

```sh
curl --fail https://pds.example.com/.well-known/atproto-pull-pds
```

The quickstart document covers generating the publisher site, publishing, and verifying the result. The specification document describes the implemented wire format and limits. The security document explains the trust model and safe key handling.

## What is implemented

- Hostname-only `did:web` identities, bound to the publisher's HTTPS origin and the configured PDS endpoint and key.
- Snapshot feeds with deterministic create/update/delete diffs, serialized ingestion per publisher, SQLite storage and signed AT Protocol repositories.
- Collection allowlists and schema checks for bundled lexicons; undeclared top-level fields are rejected for those schemas. Custom collections without bundled schemas receive structural checks only.
- WebSub publish notifications and a public read/sync surface, including repository CARs and `com.atproto.sync.subscribeRepos`.
- A sample AppView and a consumer of the legacy Jetstream JSON protocol that fetches signed record proofs from the source PDS before indexing.

Only shared signing keys and snapshot ingestion are implemented. Per-publisher keys, operation-log feeds, automatic crawler registration, and DID-document caching are not supported and fail configuration validation.

## Trust and limits

The PDS holds the signing key and can forge records for every publisher that delegates to it. This is delegated signing, not publisher self-custody. Domain control establishes attribution, not the truth of the data or a unique human identity. Losing a `did:web` hostname also loses control of that identity.

Feeds and resulting records are public. Publish only deliberately selected aggregates. Changing or deleting a record does not erase copies already retained by other network participants. A snapshot replaces the repository's desired record state: omitted records are deleted.

This is a research demo with a partial PDS surface, not a drop-in Bluesky account server or a production service with an SLA. Public relay acceptance is controlled by relay operators and requires explicit testing.

## Evidence

July 2026 experiment artifacts recorded 240 matching relay observations across four repositories and 80 distinct commit CIDs. A separate historical soak reported roughly 100 MB PDS RSS under light load, 65 ms local median latency, and 392 ms median latency for Jetstream notification plus verification. These were synthetic runs, with colocated components and different revisions; they are not fresh measurements of this release, universal latency promises, or a comparative cost benchmark.

The evidence document separates those historical results from current local checks. Reproduce publication and independent verification before announcing a live deployment.

## Development

```sh
npm run typecheck
npm run build
npm test
npm run check:secrets
```

CI checks Node 22.13 and 24. The npm package remains private because this release is distributed as source, not published to the npm registry. MIT licensed. No affiliation with Bluesky, AT Protocol, OpenTelemetry, or CNCF is implied.
