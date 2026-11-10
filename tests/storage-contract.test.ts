import { describe, expect, it } from "vitest";
import { legacyStorageMethods, validateLegacyStorage } from "../server/storageContract";

describe("complete application storage contract", () => {
  it("accepts the complete interface and rejects every missing method", () => {
    const complete = Object.fromEntries(legacyStorageMethods.map(name => [name, () => {}]));
    expect(() => validateLegacyStorage(complete)).not.toThrow();
    for (const missing of legacyStorageMethods) {
      const incomplete = { ...complete };
      delete incomplete[missing];
      expect(() => validateLegacyStorage(incomplete)).toThrow(missing);
    }
  });
});
