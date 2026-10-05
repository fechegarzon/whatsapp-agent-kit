import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * WhatsApp lets a business send free-form messages only within 24 hours of
 * the customer's last message. After that, only approved templates go
 * through. Meta enforces this on their side too, but by then the send has
 * failed and the user is left waiting. Better to know before calling the API.
 */
export interface ContactStateStore {
  getLastInboundAt(waId: string): Promise<number | undefined>;
  setLastInboundAt(waId: string, atMs: number): Promise<void>;
}

export class MemoryContactStateStore implements ContactStateStore {
  private readonly lastInbound = new Map<string, number>();

  async getLastInboundAt(waId: string): Promise<number | undefined> {
    return this.lastInbound.get(waId);
  }

  async setLastInboundAt(waId: string, atMs: number): Promise<void> {
    this.lastInbound.set(waId, atMs);
  }
}

export interface ServiceWindowOptions {
  /** Treat the window as closing this much earlier, to absorb clock skew and send latency. */
  safetyMarginMs?: number;
  windowMs?: number;
}

export class ServiceWindow {
  private readonly safetyMarginMs: number;
  private readonly windowMs: number;

  constructor(
    private readonly store: ContactStateStore,
    private readonly clock: Clock = systemClock,
    opts: ServiceWindowOptions = {},
  ) {
    this.safetyMarginMs = opts.safetyMarginMs ?? 5 * 60 * 1000;
    this.windowMs = opts.windowMs ?? SERVICE_WINDOW_MS;
  }

  /**
   * Uses Meta's message timestamp, not our receive time. A webhook replayed
   * hours later must not reopen a window that is already closed.
   * Out-of-order deliveries never move the timestamp backwards.
   */
  async recordInbound(waId: string, metaTimestampSec: number): Promise<void> {
    const atMs = metaTimestampSec * 1000;
    const prev = await this.store.getLastInboundAt(waId);
    if (prev === undefined || atMs > prev) await this.store.setLastInboundAt(waId, atMs);
  }

  async isOpen(waId: string): Promise<boolean> {
    const closesAt = await this.closesAt(waId);
    return closesAt !== undefined && this.clock() < closesAt;
  }

  /** When the window closes (with the safety margin applied), or undefined if it never opened. */
  async closesAt(waId: string): Promise<number | undefined> {
    const last = await this.store.getLastInboundAt(waId);
    if (last === undefined) return undefined;
    return last + this.windowMs - this.safetyMarginMs;
  }
}
