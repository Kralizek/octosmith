/** Describes a deterministic content hash. */
export interface ContentHash {
  readonly algorithm: "sha256";
  readonly hash: string;
}

/** Return a canonical JSON-compatible representation with sorted object keys. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

/** Hash arbitrary JSON-compatible semantic data deterministically. */
export async function hashCanonical(value: unknown): Promise<ContentHash> {
  const encoded = new TextEncoder().encode(
    JSON.stringify(canonicalize(value)),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return {
    algorithm: "sha256",
    hash: Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
  };
}

/** Compare two content hashes. */
export function equalContentHash(
  left: ContentHash,
  right: ContentHash,
): boolean {
  return left.algorithm === right.algorithm && left.hash === right.hash;
}
