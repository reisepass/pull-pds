# Pull-PDS

**Let an application write to AT Protocol using only a web domain it controls: no PDS to run, no account, no password, no captcha, no WebSocket.**

Pull-PDS is an experimental shared PDS for machine publishers such as telemetry exporters, monitoring probes, CI jobs, and data pipelines. Today, getting records onto AT Protocol means either running your own PDS or signing up for an account on someone else's, with a handle, email, password, and often a captcha. Both are awkward for a program that just wants to publish data.

The key idea is that **identity and data come from the same web origin**. A publisher's identity is `did:web:data.example.org`, which resolves to `https://data.example.org/.well-known/did.json`. Its records are a JSON file on that same host. Whoever controls the domain controls both, so fetching the records over HTTPS from the identity's own domain is the authentication. No signup, credentials, or session are needed.

The publisher serves those two files and sends a one-line HTTP notification (a WebSub ping). The shared Pull-PDS fetches the file, validates the records, signs them into a standard AT Protocol repository, and serves them to relays, AppViews, and anyone else through the normal sync endpoints and firehose.

```text
data.example.org serves did.json + feed.json
        → HTTP ping to the Pull-PDS
        → Pull-PDS fetches feed.json from that same domain and validates it
        → signed repository + firehose → relays / apps / independent readers
```

The shared PDS still needs hosting, storage, bandwidth, backups, and an operator, and it holds the signing key for every publisher that delegates to it (see [Trust and limits](#trust-and-limits)). We have not demonstrated a general cost advantage over other PDS implementations.

## Who might use this

Pull-PDS fits programs and organizations that produce small, public data on a schedule and can serve a file from a domain they control:

- **Telemetry and monitoring**: exporters and probes publishing aggregated observations, such as network reachability or API error counts, each under its own domain, so anyone can index and compare them. The demo below uses this case with synthetic data.
- **Open-data publishers**: a city publishing transit disruptions, air-quality readings, or reservoir levels from the same static site that hosts its open-data portal.
- **Research and benchmark results**: a lab or leaderboard publishing evaluation scores as signed, attributable records that anyone can index, instead of a table on a web page.
- **Project release feeds**: an open-source project publishing releases, changelogs, or security advisories from its documentation site.
- **Community listings**: a club, venue, or meetup group publishing an event calendar without running a server.

In each case the publisher needs only a web host and a domain, and gets AT Protocol records that apps, feeds, and indexers can consume. The records use custom collections, so they do not automatically appear as posts in the Bluesky app; an app has to be built to read them.

## See it working

A demo publisher, `did:web:didwebuser1.0rs.org`, is a static HTTPS host. It publishes synthetic aggregated API error counts. Its snapshot was pulled into the shared Pull-PDS at `p2.0rs.org`. The same record appears at each step:

1. **Identity** (static file): [`didwebuser1.0rs.org/.well-known/did.json`](https://didwebuser1.0rs.org/.well-known/did.json) names the signing key and points the account at `https://p2.0rs.org`.
2. **Snapshot** (static file): [`didwebuser1.0rs.org/atproto/feed.json`](https://didwebuser1.0rs.org/atproto/feed.json) is plain JSON on the publisher's host.
3. **AT Protocol record** (served by the Pull-PDS): [`getRecord` for `app.omniroute.errorReport/openai`](https://p2.0rs.org/xrpc/com.atproto.repo.getRecord?repo=did:web:didwebuser1.0rs.org&collection=app.omniroute.errorReport&rkey=openai) returns the `openai` record from the snapshot, now addressed as `at://did:web:didwebuser1.0rs.org/app.omniroute.errorReport/openai` with a content ID.
4. **Signed repository**: [`sync.getRepo`](https://p2.0rs.org/xrpc/com.atproto.sync.getRepo?did=did:web:didwebuser1.0rs.org) returns the CAR file. Verify it yourself with no access to the server:

   ```sh
   npm run build
   PUBLISHER_DID=did:web:didwebuser1.0rs.org npm run example:verify
   ```

   The verifier resolves the DID, checks the commit signature and Merkle tree, and prints the records (`"verified": true`).

The demo data is a dated synthetic run from 2026-07-31 that uses the legacy `app.omniroute.errorReport` collection, and the demo server runs an older revision than this repository. It shows the publishing path; it is not a live status feed. Links were last checked on 2026-09-23.

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

[QUICKSTART.md](QUICKSTART.md) covers generating the publisher site, publishing, and verifying the result. [SPEC.md](SPEC.md) describes the implemented wire format and limits. [SECURITY.md](SECURITY.md) explains the trust model and safe key handling.

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

July 2026 experiment artifacts ([relay observations](experiments/results/relay-propagation/bsky-network-firehose-hits.jsonl)) recorded 240 matching relay observations across four repositories and 80 distinct commit CIDs. A separate historical soak reported roughly 100 MB PDS RSS under light load, 65 ms local median latency, and 392 ms median latency for Jetstream notification plus verification. These were synthetic runs, with colocated components and different revisions; they are not fresh measurements of this release, universal latency promises, or a comparative cost benchmark.

[docs/EVIDENCE.md](docs/EVIDENCE.md) separates those historical results from current local checks. Reproduce publication and independent verification before announcing a live deployment.

## Development

```sh
npm run typecheck
npm run build
npm test
npm run check:secrets
```

CI checks Node 22.13 and 24. The npm package remains private because this release is distributed as source, not published to the npm registry. MIT licensed. No affiliation with Bluesky, AT Protocol, OpenTelemetry, or CNCF is implied.
