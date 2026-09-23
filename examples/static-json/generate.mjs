// Generate a complete, synthetic snapshot for a fresh publisher identity.
// The static host must serve dot-directories, including /.well-known/.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const endpoint = new URL(process.env.PDS_ENDPOINT ?? 'https://pds.example.invalid');
const publisher = new URL(process.env.PUBLISHER_ORIGIN ?? 'https://publisher.example.invalid');
for (const url of [endpoint, publisher]) {
  if (url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.hostname.endsWith('.invalid')) {
    throw new Error('Set PDS_ENDPOINT and PUBLISHER_ORIGIN to real, bare HTTPS origins without ports.');
  }
}
const res = await fetch(new URL('/.well-known/atproto-pull-pds', endpoint), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
if (!res.ok) throw new Error(`Descriptor request failed: HTTP ${res.status}`);
const descriptor = await res.json();
const collection = 'org.peertelemetry.errorMetrics';
if (descriptor.atprotoPdsEndpoint !== endpoint.origin || descriptor.ingestMode !== 'snapshot' ||
    !descriptor.allowedCollections?.includes(collection) || typeof descriptor.signingPublicKeyMultibase !== 'string') {
  throw new Error('Descriptor endpoint, snapshot mode, key or collection does not match.');
}
const did = `did:web:${publisher.hostname}`;
const now = new Date();
const output = resolve(process.env.PUBLISHER_OUTPUT ?? 'publisher-site');
await mkdir(join(output, '.well-known'), { recursive: true });
await mkdir(join(output, 'atproto'), { recursive: true });
const didDoc = {
  '@context': ['https://www.w3.org/ns/did/v1'], id: did,
  alsoKnownAs: [`at://${publisher.hostname}`],
  verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: descriptor.signingPublicKeyMultibase }],
  service: [{ id: `${did}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: endpoint.origin }],
};
const feed = {
  $type: 'app.pullpds.feed', did,
  records: [{ collection, rkey: 'demo', record: {
    $type: collection, serviceType: 'llm', 'gen_ai.provider.name': 'synthetic-demo',
    windowStartUnixMicro: (now.getTime() - 60_000) * 1000, windowEndUnixMicro: now.getTime() * 1000,
    requestCount: 10, errors: [{ code: '503', count: 1 }], totalErrors: 1,
    'telemetry.distro.name': 'pull-pds-synthetic-demo', observedAt: now.toISOString(), emittedAt: now.toISOString(),
  } }],
};
// Fail instead of silently overwriting an existing publisher's identity/feed.
await writeFile(join(output, '.well-known/did.json'), JSON.stringify(didDoc, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(output, '.well-known/atproto-did'), did + '\n', { flag: 'wx' });
await writeFile(join(output, 'atproto/feed.json'), JSON.stringify(feed, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, did, topic: `${publisher.origin}/atproto/feed.json`, hub: `${endpoint.origin}/websub`, synthetic: true }, null, 2));
