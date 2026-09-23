import { describe, it, expect } from 'vitest';
import { WebSubHub, hmacSha256, type HubDeps, type Subscription } from '../src/websub/hub.js';

/**
 * End-to-end WebSub content distribution (spec §4.4): a subscriber whose intent
 * was verified receives the fetched feed content when the topic is published,
 * with an X-Hub-Signature when it supplied a secret. Wires the hub's own
 * triggerIngest->distribute path (the gap where distribute was never called in
 * production - F-8).
 */

const TOPIC = 'https://node.test.example/atproto/feed.json';
const CALLBACK = 'https://subscriber.example/cb';

describe('WebSub end-to-end distribution', () => {
  it('a publish after subscribe delivers the feed body + signature to the subscriber', async () => {
    const delivered: Array<{ callback: string; body: string; sig?: string }> = [];
    let clock = 1_000_000;
    const feedBody = new TextEncoder().encode('{"$type":"app.pullpds.feed","records":[]}');

    const deps: HubDeps = {
      verifyIntent: async () => true,
      // triggerIngest simulates ingest completing, then distributes the body.
      triggerIngest: async (topic) => {
        await hub.distribute(topic, feedBody);
      },
      distribute: async (sub, body, headers) => {
        delivered.push({
          callback: sub.callback,
          body: new TextDecoder().decode(body),
          ...(headers['X-Hub-Signature'] ? { sig: headers['X-Hub-Signature'] } : {}),
        });
      },
      now: () => clock,
    };
    const hub = new WebSubHub(deps, 0);

    // Subscriber subscribes with a secret (A7: 16+ bytes) and intent verifies.
    await hub.subscribe(
      new URLSearchParams({ 'hub.callback': CALLBACK, 'hub.topic': TOPIC, 'hub.secret': 'sekret-key-long-enough' }),
    );
    await flush();

    // Publisher pings -> triggerIngest -> distribute.
    await hub.publish(new URLSearchParams({ 'hub.mode': 'publish', 'hub.url': TOPIC }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.callback).toBe(CALLBACK);
    expect(delivered[0]!.body).toContain('app.pullpds.feed');
    expect(delivered[0]!.sig).toBe(`sha256=${hmacSha256('sekret-key-long-enough', feedBody)}`);
  });

  it('only subscribers of the matching topic receive a distribution', async () => {
    const delivered: string[] = [];
    let clock = 1_000_000;
    const deps: HubDeps = {
      verifyIntent: async () => true,
      triggerIngest: async (topic) => hub.distribute(topic, new TextEncoder().encode('{}')),
      distribute: async (sub: Subscription) => void delivered.push(sub.callback),
      now: () => clock,
    };
    const hub = new WebSubHub(deps, 0);
    await hub.subscribe(new URLSearchParams({ 'hub.callback': 'https://a.example/cb', 'hub.topic': TOPIC }));
    await hub.subscribe(new URLSearchParams({ 'hub.callback': 'https://b.example/cb', 'hub.topic': 'https://other.example/feed.json' }));
    await flush();

    await hub.publish(new URLSearchParams({ 'hub.url': TOPIC }));
    expect(delivered).toEqual(['https://a.example/cb']);
  });
});

/** Flush the microtask queue so fire-and-forget async intent verification settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
