import { describe, expect, it } from 'vitest';
import { IndexStore } from '../src/appview/index-store.js';
import { renderAppView } from '../src/appview/views.js';
import { ERROR_METRICS_NSID } from '../src/collections.js';

async function overview(observedAt?: string, errors = 0, verified = true) {
  const store = new IndexStore();
  if (observedAt !== undefined) store.putRecord({
    did: 'did:web:demo.example.com', collection: ERROR_METRICS_NSID, rkey: 'demo',
    cid: 'demo', rev: 'demo', sourcePds: 'pds.example.com', sigVerified: verified,
    indexedAt: new Date().toISOString(), recordJson: JSON.stringify({
      $type: ERROR_METRICS_NSID, serviceType: 'llm', 'gen_ai.provider.name': 'openai',
      observedAt, totalErrors: errors, errors: errors ? [{ code: '503', count: errors }] : [],
    }),
  });
  try { return (await renderAppView(store, [], '/', new URLSearchParams()))!.body; }
  finally { store.close(); }
}

describe('demo overview', () => {
  it('labels the demo and treats absent data as unknown', async () => {
    const html = await overview();
    expect(html).toContain('Records may be synthetic');
    expect(html).toContain('UNKNOWN');
    expect(html).not.toContain('Operational');
    expect(html).not.toContain('NO ERRORS REPORTED');
  });
  it.each(['2020-01-01T00:00:00Z', 'invalid', '2999-01-01T00:00:00Z'])('ignores stale or invalid observations: %s', async (date) => {
    expect(await overview(date, 5)).not.toContain('ERRORS REPORTED');
  });
  it('excludes unverified observations', async () => {
    expect(await overview(new Date().toISOString(), 5, false)).not.toContain('ERRORS REPORTED');
  });
  it('summarizes recent reports without claiming provider-wide health', async () => {
    expect(await overview(new Date().toISOString(), 5)).toContain('5 reported error(s)');
    expect(await overview(new Date().toISOString())).toContain('NO ERRORS REPORTED');
  });
});
