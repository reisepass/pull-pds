# Community post draft

Suggested venue: the Atmosphere community forum's “Share your project” category, listed at https://discourse.atmosphere.community/categories.

## Title

Pull-PDS: writing to AT Protocol with only a did:web domain, no account or PDS

## Body

I've been experimenting with a way for programs, such as telemetry exporters, monitoring probes, and data pipelines, to publish records on AT Protocol without running a PDS and without an account (no handle signup, email, password, or captcha).

The idea: use `did:web` as the identity and the same web origin as the data source. The publisher serves `/.well-known/did.json` and a JSON file of records on its domain, then sends a one-line WebSub ping. A shared Pull-PDS fetches the file from that same domain, validates it, signs the repository updates, and exposes the usual sync/firehose read surface. Domain control is the authentication, so there are no credentials to manage.

This is a hypothesis about reducing publisher-side overhead, not a benchmark claiming to beat other PDS implementations on cost.

It also suits small public datasets: open-data portals, benchmark results, project release feeds, event listings. The demo publisher uses clearly synthetic aggregated API error counts. These are custom AT Protocol records, so they don't automatically become posts in the Bluesky app.

The trust tradeoff is explicit: publishers delegate signing to the PDS, which can forge their records. HTTPS domain control gives attribution, not truth or Sybil resistance. This is an experimental partial PDS, with shared keys and snapshot ingestion only.

The source includes a small publisher generator, a reader that verifies the signed repository against the publisher's DID document, and tests. Historical July experiments observed records returning through a public relay; those results are dated and are not evidence that the current deployment is healthy.

I'd welcome feedback on the identity/delegation model, the snapshot-plus-notification interface, and whether this is useful for small public datasets or device observations.

## Before posting

Insert the public source URL and a tested quickstart link. Link a live demo only after rotating the exposed development keys, deploying the fixes, and repeating publication plus independent verification. If claiming current relay propagation, include a fresh commit CID and observation time. This draft has not been posted.
