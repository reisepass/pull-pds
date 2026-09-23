# Evidence and limitations

## Historical experiments, July 2026

The relay observation artifact contains 240 rows, four distinct publisher repositories, and 80 distinct commit CIDs. It demonstrates that these experiment records were observed on the configured public relay at the recorded times. It does not establish current relay acceptance or current service health.

Earlier synthetic soak reports measured approximately 100 MB PDS RSS at light load, a local median near 65 ms, and a Jetstream-notification-plus-verification median near 392 ms. Components were colocated on one VM in parts of the experiment. The runs used older revisions and a legacy collection schema. They did not compare equivalent workloads against other PDS implementations or demonstrate the proposed 0.1-vCPU budget.

The release includes the relay observation data as dated evidence. Private operational notes and raw deployment configurations remain outside the public export.

## Current local checks

The cleanup adds regression coverage for production record validation, multiple-collection Jetstream ingestion, private-key log suppression, unsupported configuration rejection, and missing/stale/unverified demo observations. The static publisher and independent verifier are intended to make a new run reproducible.

Local tests and a successful cold repository verification are different from fresh public-network propagation. An announcement should state which has actually been observed, name the tested revision, and include a dated relay observation only after repeating the public-network check with fresh signing keys.
