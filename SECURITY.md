# Security and operational limits

This is an experimental, delegated-signing service. The operator can sign for every publisher that advertises its shared key. Public records may be replicated indefinitely. Do not publish private request bodies, prompts, account identifiers, secrets, or raw logs.

## Signing keys

Generate a fresh key for every deployment with `npm run keygen`. The generator creates an owner-readable environment file without printing the secret and refuses to overwrite an existing file. Keep the file outside version control and maintain a protected backup. Persistent PDS storage refuses to start without a supplied key; an ephemeral development key changes on restart.

Never commit a signing key. `npm run check:secrets` scans tracked files for key-shaped values, and `.gitignore` excludes environment files other than `*.example`. Removing a committed key from the current tree does not remove it from history, clones, logs, or backups; rotate it instead.

For a live rotation: inventory every DID delegating to the old key; pause ingestion; back up databases and identity documents; generate a fresh key; plan and test repository re-signing/resync or move publishers to fresh identities; update the PDS and affected DID documents coherently; verify fresh commits from an independent reader and relay; then resume publication. Preserve an audit trail. A new environment value alone cannot make existing commits verify under a new key.

The public release preparation does not itself rotate any running deployment.

## Network and availability

The ingest path enforces HTTPS, bounded responses, same-host redirects and DNS-pinned SSRF guards. These checks and the admission limits reduce specific risks; they are not a complete security audit or a general DDoS defense. Use a reverse proxy with request limits and a service user with minimal filesystem access. Keep localhost exceptions disabled on public deployments.

Repository signing, metadata, and the event sequencer use separate stores. Crash recovery and durability under every failure mode have not been established. Keep backups and test recovery before storing important data. The server implements only a subset of PDS behavior.

## Reporting

Use a private vulnerability-reporting channel supplied by the repository owner when available. Do not place credentials or an actively exploitable deployment detail in a public issue. Include the affected revision, minimal reproduction, and expected versus actual behavior with sensitive values removed.
