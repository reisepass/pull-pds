# Community post draft

Suggested venue: the Atmosphere community forum's “Share your project” category, listed at https://discourse.atmosphere.community/categories.

## Title

Pull-PDS: publishing static JSON to AT Protocol with a WebSub ping

## Body

I've been experimenting with a small publishing path for AT Protocol: host a DID document and a JSON snapshot on an HTTPS origin, then ping a WebSub endpoint. A shared Pull-PDS fetches the snapshot, validates it, signs the repository updates, and exposes the usual sync/firehose read surface.

The motivation is to make small public-data publishers cheap and simple to operate. The publisher can be a static site; repository machinery lives on a shared server. This is a hypothesis about reducing publisher-side overhead, not a benchmark claiming to beat other PDS implementations on cost.

Peer Telemetry is the example application, with clearly synthetic aggregate observations. The reusable part is the static-JSON publishing path. These are custom AT Protocol records, so they don't automatically become posts in the Bluesky app.

The trust tradeoff is explicit: publishers delegate signing to the PDS, which can forge their records. HTTPS domain control gives attribution, not truth or Sybil resistance. This is an experimental partial PDS, with shared keys and snapshot ingestion only.

The source includes a small publisher generator, a reader that verifies the signed repository against the publisher's DID document, and tests. Historical July experiments observed records returning through a public relay; those results are dated and are not evidence that the current deployment is healthy.

I'd welcome feedback on the identity/delegation model, the snapshot-plus-notification interface, and whether this is useful for small public datasets or device observations.

## Before posting

Insert the public source URL and a tested quickstart link. Link a live demo only after rotating the exposed development keys, deploying the fixes, and repeating publication plus independent verification. If claiming current relay propagation, include a fresh commit CID and observation time. This draft has not been posted.
