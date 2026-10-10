/**
 * Version handshake.
 *
 * The relay and the extension are separately deployable, so every wire message
 * carries a protocol version. A mismatch is a refusal, not a negotiation: a
 * partially understood contract is more dangerous than no connection.
 */

/** Bumped whenever the tool contract or wire envelopes change incompatibly. */
export const PROTOCOL_VERSION = "2.1.0";

/**
 * The relay accepts only the version it was built against.
 *
 * One version space on purpose: an earlier draft advertised a "2.1" family and
 * sent "2.1.0" on the wire, so the relay rejected its own handshake. When a
 * second version is genuinely supported, add it here and let compareProtocolVersions
 * decide the ordering.
 */
export const SUPPORTED_EXTENSION_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const;

export type ExtensionProtocolVersion = (typeof SUPPORTED_EXTENSION_PROTOCOL_VERSIONS)[number];

export function isSupportedExtensionProtocolVersion(
  value: unknown,
): value is ExtensionProtocolVersion {
  return (
    typeof value === "string" &&
    (SUPPORTED_EXTENSION_PROTOCOL_VERSIONS as readonly string[]).includes(value)
  );
}

/** Semver-ish compare good enough for "2.1" style protocol tags. */
export function compareProtocolVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
