import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalize } from "./canonicalHash";

describe("canonicalize", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { name: "Asha", event: "Bharatanatyam", marks: 87 };
    const b = { marks: 87, name: "Asha", event: "Bharatanatyam" };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("sorts nested object keys recursively", () => {
    const a = { outer: { z: 1, a: 2 }, top: 1 };
    const b = { top: 1, outer: { a: 2, z: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("preserves array order (arrays are not sorted)", () => {
    const a = { list: [3, 1, 2] };
    const b = { list: [1, 2, 3] };
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });

  it("produces different output for genuinely different content", () => {
    const a = { name: "Asha", marks: 87 };
    const b = { name: "Asha", marks: 88 };
    expect(canonicalize(a)).not.toBe(canonicalize(b));
  });
});

describe("canonicalHash", () => {
  it("is invariant to key order", () => {
    const a = { name: "Asha", event: "Bharatanatyam", marks: 87 };
    const b = { marks: 87, name: "Asha", event: "Bharatanatyam" };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("changes when the underlying data changes", () => {
    const a = { name: "Asha", marks: 87 };
    const b = { name: "Asha", marks: 88 };
    expect(canonicalHash(a)).not.toBe(canonicalHash(b));
  });

  it("returns a 0x-prefixed 32-byte hex string", () => {
    const hash = canonicalHash({ a: 1 });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
