/**
 * Collection NSIDs known to this PDS.
 *
 * The bundled lexicon is a toy example. Operators choose the collections they
 * accept with ALLOWED_COLLECTIONS and add matching lexicon files; collections
 * without a bundled lexicon receive structural checks only.
 */

/** Toy example collection with a bundled lexicon (lexicons/com/example/sensor/reading.json). */
export const EXAMPLE_READING_NSID = 'com.example.sensor.reading';

/** Default collection allowlist when ALLOWED_COLLECTIONS is unset. */
export const DEFAULT_ALLOWED_COLLECTIONS: readonly string[] = [EXAMPLE_READING_NSID];

/**
 * Namespaces a Pull-PDS never accepts. A Pull-PDS publishes data records, not
 * social content: it never carries posts, likes, follows, reposts, or chat that
 * the Bluesky app would show. Refusing these namespaces keeps Pull-PDS nodes
 * useless as a spam channel into social timelines, and keeps protocol-level
 * records under the control of the reference implementation.
 */
export const BLOCKED_NAMESPACES: readonly string[] = ['app.bsky.', 'chat.bsky.', 'com.atproto.', 'tools.ozone.'];

/** True when a collection falls in a namespace a Pull-PDS never accepts. */
export function isBlockedCollection(nsid: string): boolean {
  return BLOCKED_NAMESPACES.some((prefix) => nsid.startsWith(prefix));
}
