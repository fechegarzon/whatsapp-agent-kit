import { describe, expect, it } from "vitest";
import { MemoryIdempotencyStore, RedisIdempotencyStore, type RedisLike } from "../src/store/idempotency.js";
import { fakeClock } from "./helpers.js";

describe("MemoryIdempotencyStore", () => {
  it("claims a key once", async () => {
    const store = new MemoryIdempotencyStore();
    expect(await store.claim("k", 1000)).toBe(true);
    expect(await store.claim("k", 1000)).toBe(false);
  });

  it("lets a key be claimed again after it expires", async () => {
    const time = fakeClock();
    const store = new MemoryIdempotencyStore(time.clock);
    await store.claim("k", 1000);
    time.advance(1001);
    expect(await store.claim("k", 1000)).toBe(true);
  });

  it("lets a released key be claimed again", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim("k", 1000);
    await store.release("k");
    expect(await store.claim("k", 1000)).toBe(true);
  });

  it("stays bounded in size", async () => {
    const store = new MemoryIdempotencyStore(undefined, 3);
    for (const k of ["a", "b", "c", "d", "e"]) await store.claim(k, 60_000);
    expect(store.size).toBeLessThanOrEqual(3);
  });
});

describe("RedisIdempotencyStore", () => {
  /** Mimics SET NX PX semantics. */
  function fakeRedis(): RedisLike {
    const keys = new Set<string>();
    return {
      setNxPx: async (k) => (keys.has(k) ? null : (keys.add(k), "OK")),
      del: async (k) => keys.delete(k),
    };
  }

  it("maps SET NX to claim()", async () => {
    const store = new RedisIdempotencyStore(fakeRedis());
    expect(await store.claim("k", 1000)).toBe(true);
    expect(await store.claim("k", 1000)).toBe(false);
    await store.release("k");
    expect(await store.claim("k", 1000)).toBe(true);
  });
});
