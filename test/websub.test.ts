import { describe, it, expect } from 'vitest';
import { WebSubHub, hmacSha256, type HubDeps, type Subscription, type SubscriptionStore } from '../src/websub/hub.js';

const TOPIC = 'https://node.test.example/atproto/feed.json';
const CALLBACK = 'https://subscriber.example/cb';

function mkHub(over: Partial<HubDeps> = {}, minPingSec = 60, store?: SubscriptionStore) {
  const ingested: string[] = [];
  const intentCalls: Array<{ callback: string; mode: string; challenge: string }> = [];
  const distributed: Array<{ sub: Subscription; headers: Record<string, string> }> = [];
  let clock = 1_000_000;
  let chalCounter = 0;
  const deps: HubDeps = {
    verifyIntent: async (callback, p) => {
      intentCalls.push({ callback, mode: p.mode, challenge: p.challenge });
      return true;
    },
    triggerIngest: async (t) => void ingested.push(t),
    distribute: async (sub, _body, headers) => void distributed.push({ sub, headers }),
    now: () => clock,
    challenge: () => `test-chal-${++chalCounter}`, // deterministic for tests
    ...over,
  };
  const hub = new WebSubHub(deps, minPingSec, store);
  return { hub, ingested, intentCalls, distributed, tick: (ms: number) => (clock += ms), setClock: (v: number) => (clock = v) };
}

function params(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj);
}

/** Flush the microtask queue so fire-and-forget async verification settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** In-memory SubscriptionStore test double (mirrors MetaStore semantics). */
function memStore() {
  const map = new Map<string, Subscription>();
  const store: SubscriptionStore = {
    upsert: (s) => void map.set(`${s.callback}\n${s.topic}`, { ...s }),
    remove: (cb, tp) => void map.delete(`${cb}\n${tp}`),
    all: () => [...map.values()].map((s) => ({ ...s })),
  };
  return { store, map };
}

describe('WebSub publish', () => {
  it('accepts hub.url and triggers an ingest', async () => {
    const { hub, ingested } = mkHub();
    const r = await hub.publish(params({ 'hub.mode': 'publish', 'hub.url': TOPIC }));
    expect(r.accepted).toBe(true);
    expect(ingested).toEqual([TOPIC]);
  });

  it('accepts hub.topic (W3C WebSub) as an alias for the topic', async () => {
    const { hub, ingested } = mkHub();
    await hub.publish(params({ 'hub.mode': 'publish', 'hub.topic': TOPIC }));
    expect(ingested).toEqual([TOPIC]);
  });

  it('debounces rapid pings from the same origin', async () => {
    const { hub, ingested, tick } = mkHub({}, 60);
    await hub.publish(params({ 'hub.url': TOPIC }));
    const r2 = await hub.publish(params({ 'hub.url': TOPIC }));
    expect(r2.debounced).toBe(true);
    expect(ingested.length).toBe(1); // second ping did not trigger ingest
    tick(60_000);
    await hub.publish(params({ 'hub.url': TOPIC }));
    expect(ingested.length).toBe(2); // after the window, a new ping goes through
  });

  it('debounce is per-origin, not global', async () => {
    const { hub, ingested } = mkHub({}, 60);
    await hub.publish(params({ 'hub.url': TOPIC }));
    await hub.publish(params({ 'hub.url': 'https://other.example/atproto/feed.json' }));
    expect(ingested.length).toBe(2);
  });

  it('rejects a missing topic', async () => {
    const { hub } = mkHub();
    const r = await hub.publish(params({ 'hub.mode': 'publish' }));
    expect(r.accepted).toBe(false);
  });
});

describe('WebSub subscribe / intent verification (A2 async)', () => {
  it('answers accepted immediately, then verifies intent and stores a lease', async () => {
    const { hub, intentCalls } = mkHub();
    const r = await hub.subscribe(
      params({ 'hub.mode': 'subscribe', 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.lease_seconds': '86400' }),
    );
    // A2: 202-shaped immediate acceptance, before verification completes.
    expect(r.status).toBe('accepted');
    await flush();
    expect(intentCalls[0]?.mode).toBe('subscribe');
    expect(hub.activeSubscriptions().length).toBe(1);
  });

  it('A6: the intent-verification challenge is present and unguessable-shaped', async () => {
    const { hub, intentCalls } = mkHub({ challenge: undefined });
    await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    await flush();
    // Real crypto-random challenge (base64url of 32 bytes = 43 chars).
    expect(intentCalls[0]?.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never stores a lease when the callback does not echo the challenge', async () => {
    const { hub } = mkHub({ verifyIntent: async () => false });
    const r = await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    expect(r.status).toBe('accepted'); // 202 still; failure is async + logged
    await flush();
    expect(hub.activeSubscriptions().length).toBe(0);
  });

  it('A7: rejects a too-short hub.secret up front', async () => {
    const { hub } = mkHub();
    const r = await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.secret': 'short' }));
    expect(r.status).toBe('invalid');
    expect(hub.activeSubscriptions().length).toBe(0);
  });

  it('A7: rejects an absurdly long hub.secret', async () => {
    const { hub } = mkHub();
    const r = await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.secret': 'x'.repeat(300) }));
    expect(r.status).toBe('invalid');
  });

  it('A9: rejects a subscriber requesting an unoffered signature algorithm (sha512)', async () => {
    const { hub } = mkHub();
    const r = await hub.subscribe(
      params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.algorithm': 'sha512' }),
    );
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.message).toMatch(/sha256 only/);
    expect(hub.activeSubscriptions().length).toBe(0);
  });

  it('A9: an explicit sha256 request (any case) is accepted', async () => {
    const { hub } = mkHub();
    const r = await hub.subscribe(
      params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.algorithm': 'SHA256' }),
    );
    expect(r.status).toBe('accepted');
    await flush();
    expect(hub.activeSubscriptions().length).toBe(1);
  });

  it('unsubscribe verifies intent and drops the lease', async () => {
    const { hub } = mkHub();
    await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    await flush();
    expect(hub.activeSubscriptions().length).toBe(1);
    const r = await hub.unsubscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    expect(r.status).toBe('accepted');
    await flush();
    expect(hub.activeSubscriptions().length).toBe(0);
  });

  it('an expired lease is not distributed to and is pruned', async () => {
    const { hub, distributed, setClock } = mkHub();
    await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.lease_seconds': '1' }));
    await flush();
    setClock(1_000_000 + 2000); // 2s later, lease (1s) expired
    await hub.distribute(TOPIC, new TextEncoder().encode('{}'));
    expect(distributed.length).toBe(0);
    expect(hub.activeSubscriptions().length).toBe(0);
  });
});

describe('WebSub hub.mode=denied (A3)', () => {
  it('drops any stored lease for (callback, topic) without verification', async () => {
    const { hub } = mkHub();
    await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    await flush();
    expect(hub.activeSubscriptions().length).toBe(1);
    const r = await hub.denied(params({ 'hub.mode': 'denied', 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    expect(r.status).toBe('accepted');
    expect(hub.activeSubscriptions().length).toBe(0);
  });

  it('denied on an unknown pair is a harmless accepted no-op', async () => {
    const { hub } = mkHub();
    const r = await hub.denied(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    expect(r.status).toBe('accepted');
  });

  it('denied requires callback + topic', async () => {
    const { hub } = mkHub();
    const r = await hub.denied(params({ 'hub.mode': 'denied' }));
    expect(r.status).toBe('invalid');
  });
});

describe('WebSub persisted subscriptions (A8)', () => {
  it('upserts the lease into the store on verified subscribe', async () => {
    const { store, map } = memStore();
    const { hub } = mkHub({}, 60, store);
    await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.secret': 'a-very-good-secret-key' }));
    await flush();
    expect(map.size).toBe(1);
    expect([...map.values()][0]?.secret).toBe('a-very-good-secret-key');
  });

  it('a new hub over the same store reloads live leases (survives restart)', async () => {
    const { store } = memStore();
    const first = mkHub({}, 60, store);
    await first.hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    await flush();
    // "Restart": a brand-new hub over the same store, no new subscribe call.
    const second = mkHub({}, 60, store);
    expect(second.hub.activeSubscriptions().length).toBe(1);
  });

  it('drops the persisted lease on unsubscribe and on expired-load', async () => {
    // Clock is shared across "restarts" so a lease written by hub 1 is judged
    // by the same wall clock hub 2 loads with.
    let clock = 1_000_000;
    const { store, map } = memStore();
    const first = mkHub({ now: () => clock }, 60, store);
    await first.hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.lease_seconds': '1' }));
    await flush();
    expect(map.size).toBe(1);
    // Expire it (1s lease, advance 5s), then "restart": the new hub prunes the
    // dead lease from the store on load.
    clock += 5000;
    mkHub({ now: () => clock }, 60, store);
    expect(map.size).toBe(0);
  });

  it('unsubscribe removes the persisted lease', async () => {
    const { store, map } = memStore();
    const { hub } = mkHub({}, 60, store);
    await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    await flush();
    expect(map.size).toBe(1);
    await hub.unsubscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    await flush();
    expect(map.size).toBe(0);
  });
});

describe('WebSub content distribution', () => {
  it('signs distribution with X-Hub-Signature when a secret was given', async () => {
    const { hub, distributed } = mkHub();
    await hub.subscribe(
      params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.secret': 's3cr3t-key-long-enough' }),
    );
    await flush();
    const body = new TextEncoder().encode('{"hello":"world"}');
    await hub.distribute(TOPIC, body);
    expect(distributed.length).toBe(1);
    const sig = distributed[0]!.headers['X-Hub-Signature'];
    expect(sig).toBe(`sha256=${hmacSha256('s3cr3t-key-long-enough', body)}`);
  });

  it('omits the signature when no secret was given', async () => {
    const { hub, distributed } = mkHub();
    await hub.subscribe(params({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC }));
    await flush();
    await hub.distribute(TOPIC, new TextEncoder().encode('{}'));
    expect(distributed[0]!.headers['X-Hub-Signature']).toBeUndefined();
  });
});
