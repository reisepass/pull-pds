# Static JSON publisher quickstart

## 1. Run a PDS

Follow the project introduction to install dependencies, generate a fresh signing key, configure persistent storage, and expose the server through HTTPS. The PDS descriptor must work before proceeding. Use a fresh publisher hostname for this demo; do not repoint an existing Bluesky identity.

The following examples use `pds.example.com` and `publisher.example.com` as placeholders. Replace both with hostnames you control. Publisher identities use bare HTTPS hostnames: no path-based identity or nonstandard port.

## 2. Generate a synthetic publisher site

From the project checkout:

```sh
PDS_ENDPOINT=https://pds.example.com \
PUBLISHER_ORIGIN=https://publisher.example.com \
PUBLISHER_OUTPUT=/tmp/pull-pds-publisher-site \
npm run example:generate
```

This reads the PDS descriptor and creates three public resources: a DID document, a handle-to-DID response, and a complete synthetic error-metrics snapshot. The command prints the absolute output directory and refuses to overwrite existing files. Its record names the provider `synthetic-demo` and the emitter `pull-pds-synthetic-demo`.

Publish the generated directory at the root of your static HTTPS host. The host must serve these URLs without authentication:

- `https://publisher.example.com/.well-known/did.json`
- `https://publisher.example.com/.well-known/atproto-did`
- `https://publisher.example.com/atproto/feed.json`

Any static host that preserves these paths can work. For object storage, preserve the object names and set JSON content types. For a build-based static host, ensure dot-directories are copied to the output. A custom domain is necessary if the host otherwise serves only a path below a shared hostname. Do not configure an SPA fallback for these resources.

Check the deployed bytes before sending a notification:

```sh
curl --fail https://publisher.example.com/.well-known/did.json
curl --fail https://publisher.example.com/.well-known/atproto-did
curl --fail https://publisher.example.com/atproto/feed.json
```

The DID document must delegate to exactly the endpoint and public signing key in the PDS descriptor. A redirect to a different host is rejected by ingestion.

## 3. Publish

```sh
curl --fail --request POST https://pds.example.com/websub \
  --data-urlencode 'hub.mode=publish' \
  --data-urlencode 'hub.url=https://publisher.example.com/atproto/feed.json'
```

HTTP 202 means the notification was accepted, not that a record was committed. Ingestion runs asynchronously. Consult the PDS ingestion log and read back the repository to confirm success. The default debounce is 60 seconds per origin; allow that interval between updates.

## 4. Verify as an independent reader

After ingestion has completed:

```sh
PUBLISHER_DID=did:web:publisher.example.com npm run example:verify
```

This resolves the publisher's HTTPS DID document, fetches its repository CAR from the advertised PDS, and checks the commit signature and Merkle tree using the DID's public key. Success prints `verified: true`, a commit CID, and the records. It does not read the PDS signing secret or local database. A successful direct read proves publication and signature validity; it does not prove propagation through a public relay.

## 5. Update carefully

Edit the hosted snapshot with a new observation and send the same notification. Keep the record key stable to update the record. An unchanged snapshot creates no commit. A missing record is a deletion, and an empty records array deletes every existing record. One invalid record rejects the whole snapshot. Avoid running this example against an identity with other records.

## Public-network demonstration

Ask a relay to crawl the public PDS using that relay's supported request-crawl endpoint, then watch for the publisher DID and commit CID in its stream. Record the observation time and distinguish relay output from reads directly against your PDS. Relay onboarding and acceptance are external policies, not guaranteed by a 202 or successful direct read.

The included AppView uses the legacy Jetstream JSON notification protocol with repeated `wantedCollections` parameters, then verifies signed proofs from the source PDS. Upstream documentation: https://github.com/bluesky-social/jetstream-legacy#consuming-jetstream. It has not been migrated to the newer Jetstream archive protocol.
