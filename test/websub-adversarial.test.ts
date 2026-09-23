import { describe, it, expect } from 'vitest';
import { WebSubHub, type HubDeps, type Subscription } from '../src/websub/hub.js';

/**
 * Adversarial WebSub hub coverage (ADVERSARIAL-TESTS.md "WebSub hub"). Focus:
 * subscriber-side abuse that a hub must tolerate without harming honest
 * subscribers, and the F-13 fan-out isolation regression.
 */

const TOPIC = 'https://node.test.example/atproto/feed.json';

/** Flush the microtask queue so fire-and-forget async verification settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// F-13: content distribution was a sequential await loop, so ONE subscriber
// whose callback hangs blocks delivery to every other subscriber of the topic
// until its per-request timeout. Fan-out must isolate subscribers from each
// other.
// ---------------------------------------------------------------------------

describe('F-13: one hanging subscriber must not block the others', () => {
  it('a fast subscriber is delivered to while a slow one is still hanging', async () => {
    const order: string[] = [];
    let releaseSlow: (() => void) | null = null;
    const deps: HubDeps = {
      verifyIntent: async () => true,
      triggerIngest: async () => {},
      distribute: async (sub) => {
        order.push('start:' + sub.callback);
        if (sub.callback.includes('slow')) {
          await new Promise<void>((r) => { releaseSlow = r; });
        }
        order.push('done:' + sub.callback);
      },
      now: () => 1_000_000,
      challenge: () => 'c',
    };
    const hub = new WebSubHub(deps, 0);
    // Subscribe slow first so a sequential loop would reach it before the fast one.
    for (const cb of ['https://slow.example/cb', 'https://fast.example/cb']) {
      await hub.subscribe(new URLSearchParams({ 'hub.callback': cb, 'hub.topic': TOPIC }));
    }
    await flush();

    const distributing = hub.distribute(TOPIC, new TextEncoder().encode('{}'));
    // Give the fan-out a few turns; the slow one is still hanging.
    await flush();

    // The fast subscriber must already be delivered even though slow has not
    // resolved. A sequential-await loop leaves order == ['start:slow'] here.
    expect(order).toContain('done:https://fast.example/cb');

    releaseSlow?.();
    await distributing;
  });
});

// ---------------------------------------------------------------------------
// Subscriber-side abuse that already fails closed - pin it.
// ---------------------------------------------------------------------------

describe('WebSub subscribe/unsubscribe abuse (pinned)', () => {
  function mkHub() {
    let clock = 1_000_000;
    const verified: string[] = [];
    const deps: HubDeps = {
      verifyIntent: async (cb) => { verified.push(cb); return true; },
      triggerIngest: async () => {},
      now: () => clock,
      challenge: () => 'c',
    };
    return { hub: new WebSubHub(deps, 0), verified };
  }

  it('unsubscribe for a lease you never held is a harmless accepted no-op', async () => {
    const { hub } = mkHub();
    const r = await hub.unsubscribe(new URLSearchParams({ 'hub.callback': 'https://x.example/cb', 'hub.topic': TOPIC }));
    expect(r.status).toBe('accepted');
    await flush();
    expect(hub.activeSubscriptions()).toHaveLength(0);
  });

  it('a hub.secret of exactly 256 bytes is accepted; 257 is rejected (boundary)', async () => {
    const { hub } = mkHub();
    const ok = await hub.subscribe(new URLSearchParams({ 'hub.callback': 'https://x.example/cb', 'hub.topic': TOPIC, 'hub.secret': 'x'.repeat(256) }));
    expect(ok.status).toBe('accepted');
    const bad = await hub.subscribe(new URLSearchParams({ 'hub.callback': 'https://x.example/cb', 'hub.topic': TOPIC, 'hub.secret': 'x'.repeat(257) }));
    expect(bad.status).toBe('invalid');
  });

  it('a multibyte hub.secret is measured in bytes, not characters (256 bytes = accept, 258 = reject)', async () => {
    const { hub } = mkHub();
    // 'é' is 2 bytes in UTF-8.
    const ok = await hub.subscribe(new URLSearchParams({ 'hub.callback': 'https://x.example/cb', 'hub.topic': TOPIC, 'hub.secret': 'é'.repeat(128) }));
    expect(ok.status).toBe('accepted');
    const bad = await hub.subscribe(new URLSearchParams({ 'hub.callback': 'https://x.example/cb', 'hub.topic': TOPIC, 'hub.secret': 'é'.repeat(129) }));
    expect(bad.status).toBe('invalid');
  });

  it('a callback that fails intent verification never gets a stored lease', async () => {
    let clock = 1_000_000;
    const deps: HubDeps = {
      verifyIntent: async () => false, // subscriber does not echo the challenge
      triggerIngest: async () => {},
      now: () => clock,
      challenge: () => 'c',
    };
    const hub = new WebSubHub(deps, 0);
    const r = await hub.subscribe(new URLSearchParams({ 'hub.callback': 'https://liar.example/cb', 'hub.topic': TOPIC }));
    expect(r.status).toBe('accepted'); // A2: 202 immediately
    await flush();
    expect(hub.activeSubscriptions()).toHaveLength(0); // but no lease was stored
  });

  it('a subscribe with a non-http(s) callback is rejected synchronously', async () => {
    const { hub, verified } = mkHub();
    const r = await hub.subscribe(new URLSearchParams({ 'hub.callback': 'file:///etc/passwd', 'hub.topic': TOPIC }));
    expect(r.status).toBe('invalid');
    await flush();
    expect(verified).toHaveLength(0); // never even attempted an intent GET
  });
});
