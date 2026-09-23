import { describe, it, expect } from 'vitest';
import { listRepos } from '../src/server/xrpc.js';
import type { Pds } from '../src/pds-websub/app.js';

/**
 * listRepos pagination must be robust to a stale cursor (F-10). The DID list is
 * sorted, so pagination is a strictly-greater-than scan: a cursor whose exact
 * DID was since deleted resumes at the right place and never restarts from the
 * top (which would infinite-loop a crawler).
 */

function fakeAgg(dids: string[]): Pds {
  return {
    meta: { listDids: () => dids, isActive: () => true, status: () => null },
    repoFor: async (did: string) => ({
      getRoot: () => ({ toString: () => `cid-${did}` }),
      getRev: () => `rev-${did}`,
    }),
  } as unknown as Pds;
}

const dids = ['did:web:a', 'did:web:b', 'did:web:c', 'did:web:d'];

async function page(pds: Pds, limit: number, cursor?: string) {
  const r = await listRepos(pds, limit, cursor);
  const body = r.json as { repos: Array<{ did: string }>; cursor?: string };
  return { dids: body.repos.map((x) => x.did), cursor: body.cursor };
}

describe('listRepos pagination', () => {
  it('walks all repos in order across pages', async () => {
    const pds = fakeAgg(dids);
    const p1 = await page(pds, 2);
    expect(p1.dids).toEqual(['did:web:a', 'did:web:b']);
    expect(p1.cursor).toBe('did:web:b');
    const p2 = await page(pds, 2, p1.cursor);
    expect(p2.dids).toEqual(['did:web:c', 'did:web:d']);
    // Last full page returns the last did as cursor; the next page is empty.
    const p3 = await page(pds, 2, p2.cursor);
    expect(p3.dids).toEqual([]);
  });

  it('a stale cursor for a since-deleted repo resumes, does not restart (F-10)', async () => {
    const pds = fakeAgg(dids);
    // Cursor "did:web:bb" sorts between b and c (as if b's successor was deleted).
    const p = await page(pds, 10, 'did:web:bb');
    expect(p.dids).toEqual(['did:web:c', 'did:web:d']); // NOT a,b,c,d
  });

  it('a cursor at or past the last did yields an empty page, not a restart', async () => {
    const pds = fakeAgg(dids);
    expect((await page(pds, 10, 'did:web:d')).dids).toEqual([]);
    expect((await page(pds, 10, 'did:web:zzz')).dids).toEqual([]);
  });

  it('no cursor starts at the beginning', async () => {
    const pds = fakeAgg(dids);
    expect((await page(pds, 10)).dids).toEqual(dids);
  });
});
