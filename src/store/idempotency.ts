import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";

/**
 * Meta delivers webhooks at least once. The same message id can arrive twice
 * (retries, replays after an outage, two app subscriptions). The agent must
 * answer it once.
 */
export interface IdempotencyStore {
  /**
   * Atomically claims a key. Returns true the first time, false if the key
   * was already claimed and has not expired.
   */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Gives the key back so a later delivery can retry it. */
  release(key: string): Promise<void>;
}

/** Meta keeps retrying failed webhook deliveries for up to 7 days, so remember ids that long. */
export const DEFAULT_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function messageKey(messageId: string): string {
  return `wa:msg:${messageId}`;
}

/** A status id is the message id, so the status itself has to be part of the key. */
export function statusKey(messageId: string, status: string): string {
  return `wa:status:${messageId}:${status}`;
}

/**
 * Fine for one process and for tests. Lost on restart, not shared between
 * replicas. Use a shared store (see RedisIdempotencyStore) when you scale out.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly maxEntries = 100_000,
  ) {}

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = this.clock();
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;

    this.entries.set(key, now + ttlMs);
    if (this.entries.size > this.maxEntries) this.evict(now);
    return true;
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [k, exp] of this.entries) {
      if (exp <= now) this.entries.delete(k);
    }
    // Still too big: drop the oldest inserts (Map keeps insertion order).
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
    }
  }
}

/**
 * The two commands this adapter needs. node-redis v4+ and ioredis can both be
 * wrapped to fit this in a few lines, so the kit does not depend on either.
 *
 *   // node-redis
 *   const client = createClient({ url });
 *   const redisLike: RedisLike = {
 *     setNxPx: (k, v, ms) => client.set(k, v, { NX: true, PX: ms }),
 *     del: (k) => client.del(k),
 *   };
 *
 *   // ioredis
 *   const redisLike: RedisLike = {
 *     setNxPx: (k, v, ms) => redis.set(k, v, "PX", ms, "NX"),
 *     del: (k) => redis.del(k),
 *   };
 */
export interface RedisLike {
  /** SET key value NX PX ttl. Resolves "OK" when set, null when the key exists. */
  setNxPx(key: string, value: string, ttlMs: number): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** Shared across replicas. SET NX is atomic, so two workers cannot both win. */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisLike) {}

  async claim(key: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.setNxPx(key, "1", ttlMs)) === "OK";
  }

  async release(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
