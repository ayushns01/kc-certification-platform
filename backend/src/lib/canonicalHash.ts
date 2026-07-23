/**
 * Canonical JSON serialization + keccak256 hashing.
 *
 * The same logical metadata object must always hash to the same value
 * regardless of the order its keys were constructed in (JS object key order
 * is otherwise insertion-order, which is NOT a stable serialization). We
 * recursively sort object keys before stringifying, then hash the resulting
 * whitespace-free string with keccak256 so it can be anchored on-chain and
 * recomputed later for tamper detection.
 */
import { keccak256, toUtf8Bytes } from "ethers";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = sortKeysDeep(record[key]);
    }
    return result;
  }
  return value;
}

/** Recursively sort keys, then JSON.stringify with no whitespace. */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj) as JsonValue);
}

/** keccak256(canonicalize(obj)), 0x-prefixed. */
export function canonicalHash(obj: unknown): string {
  return keccak256(toUtf8Bytes(canonicalize(obj)));
}
