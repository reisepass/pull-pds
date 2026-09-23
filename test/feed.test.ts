import { describe, it, expect } from 'vitest';
import { parseFeed, FeedError } from '../src/pds-websub/feed.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import { parseFeed, FeedError } from '../src/pds-websub/feed.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
const COLL = 'app.omniroute.errorReport';
const DID = 'did:web:node.test.example';
const opts = { expectedDid: DID, allowedCollections: [COLL], maxRecords: 100 };
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

function feed(records: unknown[], over: Record<string, unknown> = {}) {
  return enc({ $type: 'app.pullpds.feed', did: DID, records, ...over });
}
function rec(rkey: string, n = 1, collection = COLL) {
  return { collection, rkey, record: { $type: COLL, count429: n } };
}

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO-THROW';
  } catch (e) {
    return e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
  }
}

describe('parseFeed - happy path', () => {
  it('parses a valid snapshot', () => {
    const r = parseFeed(feed([rec('current', 5)]), opts);
    expect(r.did).toBe(DID);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ collection: COLL, rkey: 'current' });
  });
  it('accepts an empty records array (deletes-everything snapshot)', () => {
    const r = parseFeed(feed([]), opts);
    expect(r.records).toHaveLength(0);
  });
});

describe('parseFeed - structural rejects', () => {
  it('invalid JSON', () => expect(code(() => parseFeed(new TextEncoder().encode('{bad'), opts))).toBe('invalid-json'));
  it('not an object', () => expect(code(() => parseFeed(enc([1, 2]), opts))).toBe('not-a-feed'));
  it('wrong $type', () => expect(code(() => parseFeed(enc({ $type: 'x', did: DID, records: [] }), opts))).toBe('not-a-feed'));
  it('missing did', () => expect(code(() => parseFeed(enc({ $type: 'app.pullpds.feed', records: [] }), opts))).toBe('not-a-feed'));
  it('did mismatch', () => expect(code(() => parseFeed(enc({ $type: 'app.pullpds.feed', did: 'did:web:other', records: [] }), opts))).toBe('did-mismatch'));
  it('records not an array', () => expect(code(() => parseFeed(enc({ $type: 'app.pullpds.feed', did: DID, records: {} }), opts))).toBe('not-a-feed'));
});

describe('parseFeed - record-level rejects (batch atomic)', () => {
  it('too many records', () => expect(code(() => parseFeed(feed(Array.from({ length: 101 }, (_, i) => rec(`k${i}`))), opts))).toBe('too-many-records'));
  it('non-object record entry', () => expect(code(() => parseFeed(feed(['nope']), opts))).toBe('invalid-record'));
  it('non-string collection/rkey', () => expect(code(() => parseFeed(feed([{ collection: 1, rkey: 'a', record: {} }]), opts))).toBe('invalid-record'));
  it('invalid NSID collection', () => expect(code(() => parseFeed(feed([{ collection: 'not_an_nsid', rkey: 'a', record: {} }]), opts))).toBe('invalid-record'));
  it('off-allowlist collection', () => expect(code(() => parseFeed(feed([rec('a', 1, 'app.bsky.feed.post')]), opts))).toBe('collection-not-allowed'));
  it('record value not an object', () => expect(code(() => parseFeed(feed([{ collection: COLL, rkey: 'a', record: 'str' }]), opts))).toBe('invalid-record'));
  it('duplicate key', () => expect(code(() => parseFeed(feed([rec('dup'), rec('dup')]), opts))).toBe('duplicate-key'));

  // Record-key validity (F-6): keys that would corrupt the MST data key.
  it.each(['../../etc/passwd', '', '.', '..', 'has space', 'a/b', 'x'.repeat(600)])(
    'invalid rkey %j => invalid-record',
    (rkey) => expect(code(() => parseFeed(feed([{ collection: COLL, rkey, record: { $type: COLL } }]), opts))).toBe('invalid-record'),
  );
  it.each(['current', '3lqrecord0001', 'valid-key_1', 'a.b~c:d'])(
    'valid rkey %j => accepted',
    (rkey) => expect(code(() => parseFeed(feed([{ collection: COLL, rkey, record: { $type: COLL } }]), opts))).toBe('NO-THROW'),
  );
});

describe('parseFeed - lexicon validation (SPEC-COMPLIANCE §4, F-2/Q6 closed)', () => {
  const validate = buildRecordValidator();
  const vopts = { ...opts, validateRecord: validate };
  // The settled canonical shape (REDESIGN-TASK §1).
  const good = {
    $type: COLL,
    provider: 'openai',
    model: 'gpt-4',
    window: '5m',
    errors: [{ code: '429', count: 5 }],
    totalErrors: 5,
    observedAt: '2026-07-21T00:00:00.000Z',
    seq: 1,
    emittedAt: '2026-07-21T00:00:00.000Z',
  };
  const one = (record: unknown) => feed([{ collection: COLL, rkey: 'current', record }]);

  it('a valid settled-shape record passes and enters the batch', () => {
    const r = parseFeed(one(good), vopts);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ collection: COLL, rkey: 'current' });
  });

  it('a bad field TYPE is rejected (lexicon-invalid), nothing reaches the MST', () => {
    const bad = { ...good, totalErrors: 'five' };
    expect(code(() => parseFeed(one(bad), vopts))).toBe('lexicon-invalid');
  });

  it('a MISSING required field is rejected (lexicon-invalid)', () => {
    const missing = { ...good } as Record<string, unknown>;
    delete missing.totalErrors;
    expect(code(() => parseFeed(one(missing), vopts))).toBe('lexicon-invalid');
  });

  it('an UNKNOWN extra field is rejected (lexicon-invalid), even though @atproto/lexicon is open-world', () => {
    const extra = { ...good, surprise: 'not-in-lexicon' };
    expect(code(() => parseFeed(one(extra), vopts))).toBe('lexicon-invalid');
  });

  it('the whole batch rejects atomically when ONE of several records is invalid', () => {
    const bad = { ...good, totalErrors: 'five' };
    const mixed = feed([
      { collection: COLL, rkey: 'good1', record: good },
      { collection: COLL, rkey: 'bad', record: bad },
      { collection: COLL, rkey: 'good2', record: { ...good, provider: 'anthropic' } },
    ]);
    // A FeedError is thrown, so parseFeed returns NO records at all - the caller
    // never gets a partial batch, so nothing (not even the two valid records)
    // reaches the diff/MST.
    expect(code(() => parseFeed(mixed, vopts))).toBe('lexicon-invalid');
    let threw = false;
    try {
      parseFeed(mixed, vopts);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('the rejection reason is human-readable and names the field', () => {
    const extra = { ...good, surprise: 1 };
    let msg = '';
    try {
      parseFeed(one(extra), vopts);
    } catch (e) {
      msg = (e as FeedError).message;
    }
    expect(msg).toMatch(/unknown field "surprise"/);
  });

  it('without a validator, deep validation is skipped (structural only, back-compat)', () => {
    // The old shape has no required fields met, but with no validateRecord it is
    // accepted as a structurally-valid JSON object.
    expect(code(() => parseFeed(one({ $type: COLL, count429: 5 }), opts))).toBe('NO-THROW');
  });
});

describe('parseFeed - record depth (F-11)', () => {
  it('rejects a pathologically deep record before it can overflow the CBOR encoder', () => {
    // Build a depth-500 record as a JSON string (well under maxFeedBytes).
    let deep = '{"$type":"x"}';
    for (let i = 0; i < 500; i++) deep = `{"c":${deep}}`;
    const bytes = new TextEncoder().encode(
      `{"$type":"app.pullpds.feed","did":"${DID}","records":[{"collection":"${COLL}","rkey":"a","record":${deep}}]}`,
    );
    expect(code(() => parseFeed(bytes, opts))).toBe('record-too-deep');
  });

  it('accepts a reasonably-nested record (depth < 32)', () => {
    const rec5 = { $type: COLL, a: { b: { c: { d: { e: 1 } } } } };
    expect(code(() => parseFeed(feed([{ collection: COLL, rkey: 'a', record: rec5 }]), opts))).toBe('NO-THROW');
  });
});

describe('parseFeed - no prototype pollution', () => {
  it('a __proto__ key in a record does not pollute Object.prototype', () => {
    parseFeed(feed([{ collection: COLL, rkey: 'a', record: { $type: COLL, ['__proto__']: { polluted: true } } }]), opts);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('parseFeed - lexicon validation seam (unified schema, ISP-SERVICETYPE)', () => {
  const EM = 'org.peertelemetry.errorMetrics';
  const emOpts = { expectedDid: DID, allowedCollections: [EM], maxRecords: 100 };
  const validate = buildRecordValidator();
  const withValidator = { ...emOpts, validateRecord: validate };
  const nowUs = Date.parse('2026-07-27T12:00:00Z') * 1000;
  const goodIsp = {
    $type: EM, serviceType: 'isp', 'gen_ai.provider.name': 'telekom',
    windowStartUnixMicro: nowUs, windowEndUnixMicro: nowUs + 300000000,
    errors: [{ code: 'link_down', count: 1 }], totalErrors: 1, requestVolumeBucket: '100-999',
    'telemetry.distro.name': 'netreport-sim', observedAt: '2026-07-27T12:00:00.000Z',
    emittedAt: '2026-07-27T12:00:00.100Z', seq: 1,
  };

  it('accepts a schema-valid isp errorMetrics record', () => {
    expect(code(() => parseFeed(feed([{ collection: EM, rkey: 'fiber.de-by', record: goodIsp }]), withValidator))).toBe('NO-THROW');
  });
  it('rejects a record with an undeclared field (homeIp) as lexicon-invalid', () => {
    const leak = { ...goodIsp, homeIp: '84.1.2.3' };
    expect(code(() => parseFeed(feed([{ collection: EM, rkey: 'fiber.de-by', record: leak }]), withValidator))).toBe('lexicon-invalid');
  });
  it('is batch-atomic: one lexicon-invalid record fails the whole feed', () => {
    const bad = { ...goodIsp, requestVolumeBucket: 'not-a-bucket' }; // outside the enum
    const bytes = feed([
      { collection: EM, rkey: 'ok', record: goodIsp },
      { collection: EM, rkey: 'bad', record: bad },
    ]);
    expect(code(() => parseFeed(bytes, withValidator))).toBe('lexicon-invalid');
  });
  it('without a validator the record passes structural checks only (back-compat)', () => {
    const leak = { ...goodIsp, homeIp: '84.1.2.3' };
    expect(code(() => parseFeed(feed([{ collection: EM, rkey: 'fiber.de-by', record: leak }]), emOpts))).toBe('NO-THROW');
  });
});
