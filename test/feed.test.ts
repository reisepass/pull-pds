import { describe, it, expect } from 'vitest';
import { parseFeed, FeedError } from '../src/pds-websub/feed.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import { EXAMPLE_READING_NSID as READING } from '../src/collections.js';
import { parseFeed, FeedError } from '../src/pds-websub/feed.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
// A custom collection with no bundled lexicon: structural checks only.
const COLL = 'com.example.custom.record';
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

describe('parseFeed - lexicon validation against a bundled lexicon', () => {
  const validate = buildRecordValidator();
  const vopts = { ...opts, allowedCollections: [READING, COLL], validateRecord: validate };
  const good = {
    $type: READING,
    sensorId: 'station-7',
    metric: 'co2',
    value: 412,
    unit: 'ppm',
    observedAt: '2026-07-21T00:00:00.000Z',
  };
  const one = (record: unknown) => feed([{ collection: READING, rkey: 'current', record }]);

  it('a valid record passes and enters the batch', () => {
    const r = parseFeed(one(good), vopts);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ collection: READING, rkey: 'current' });
  });

  it('a bad field TYPE is rejected (lexicon-invalid), nothing reaches the MST', () => {
    const bad = { ...good, value: 'high' };
    expect(code(() => parseFeed(one(bad), vopts))).toBe('lexicon-invalid');
  });

  it('a MISSING required field is rejected (lexicon-invalid)', () => {
    const missing = { ...good } as Record<string, unknown>;
    delete missing.value;
    expect(code(() => parseFeed(one(missing), vopts))).toBe('lexicon-invalid');
  });

  it('an UNKNOWN extra field is rejected (lexicon-invalid), even though @atproto/lexicon is open-world', () => {
    const extra = { ...good, surprise: 'not-in-lexicon' };
    expect(code(() => parseFeed(one(extra), vopts))).toBe('lexicon-invalid');
  });

  it('the whole batch rejects atomically when ONE of several records is invalid', () => {
    const bad = { ...good, value: 'high' };
    const mixed = feed([
      { collection: READING, rkey: 'good1', record: good },
      { collection: READING, rkey: 'bad', record: bad },
      { collection: READING, rkey: 'good2', record: { ...good, sensorId: 'station-8' } },
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

  it('without a validator, deep validation is skipped (structural only)', () => {
    const noValidator = { ...vopts, validateRecord: undefined };
    expect(code(() => parseFeed(one({ $type: READING, value: 'high' }), noValidator))).toBe('NO-THROW');
  });

  it('a collection without a bundled lexicon receives structural checks only', () => {
    const custom = feed([{ collection: COLL, rkey: 'a', record: { $type: COLL, anything: 1 } }]);
    expect(code(() => parseFeed(custom, vopts))).toBe('NO-THROW');
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
