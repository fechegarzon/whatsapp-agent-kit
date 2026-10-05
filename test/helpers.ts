import { vi } from "vitest";
import { FaqAgent } from "../src/agent/faq-agent.js";
import type { Agent } from "../src/agent/types.js";
import { createApp } from "../src/app.js";
import { BackgroundTasks } from "../src/background.js";
import { MemoryConversationStore } from "../src/conversation/store.js";
import { silentLogger } from "../src/logger.js";
import { GuardedSender, type SafetySwitches } from "../src/outbound/sender.js";
import type { OutboundPayload, SendResult, Transport } from "../src/outbound/transport.js";
import { MemoryIdempotencyStore } from "../src/store/idempotency.js";
import { MemoryContactStateStore, ServiceWindow } from "../src/store/service-window.js";
import { WebhookProcessor } from "../src/webhook/processor.js";
import { signPayload } from "../src/webhook/signature.js";

// Synthetic data only. 555 numbers are reserved for fiction.
export const APP_SECRET = "test-app-secret";
export const VERIFY_TOKEN = "test-verify-token";
export const CUSTOMER = "15555550123";
export const OTHER_CUSTOMER = "15555550199";
export const BUSINESS_PHONE_ID = "100000000000001";

/** A controllable clock. Starts at a fixed date so tests are reproducible. */
export function fakeClock(start = Date.UTC(2026, 0, 15, 12, 0, 0)) {
  let now = start;
  const clock = () => now;
  return {
    clock,
    nowSec: () => Math.floor(now / 1000),
    advance(ms: number) {
      now += ms;
    },
  };
}

export class FakeTransport implements Transport {
  readonly sent: OutboundPayload[] = [];
  readonly send = vi.fn(async (payload: OutboundPayload): Promise<SendResult> => {
    this.sent.push(payload);
    return { messageId: `wamid.out.${this.sent.length}` };
  });
}

export function textMessage(id: string, body: string, opts: { from?: string; timestampSec: number }) {
  return {
    from: opts.from ?? CUSTOMER,
    id,
    timestamp: String(opts.timestampSec),
    type: "text",
    text: { body },
  };
}

export function payloadWith(value: { messages?: unknown[]; statuses?: unknown[] }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "200000000000002",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15555550100", phone_number_id: BUSINESS_PHONE_ID },
              contacts: [{ wa_id: CUSTOMER, profile: { name: "Test Customer" } }],
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export interface HarnessOptions {
  switches?: Partial<SafetySwitches>;
  agent?: Agent;
}

/** Wires the real app with in-memory stores, a fake clock and a fake transport. */
export function harness(opts: HarnessOptions = {}) {
  const time = fakeClock();
  const transport = new FakeTransport();
  const window = new ServiceWindow(new MemoryContactStateStore(), time.clock);
  const switches: SafetySwitches = { agentEnabled: true, dryRun: false, allowlist: [], ...opts.switches };
  const agent = opts.agent ?? new FaqAgent();
  const respond = vi.spyOn(agent, "respond");
  const sender = new GuardedSender(transport, window, switches, silentLogger);
  const idempotency = new MemoryIdempotencyStore(time.clock);
  const processor = new WebhookProcessor({
    idempotency,
    window,
    conversations: new MemoryConversationStore(),
    agent,
    sender,
    agentEnabled: switches.agentEnabled,
    logger: silentLogger,
    clock: time.clock,
  });
  const process = vi.spyOn(processor, "process");
  const background = new BackgroundTasks(silentLogger);
  const app = createApp({
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    processor,
    background,
    logger: silentLogger,
  });

  async function post(body: unknown, signature?: string) {
    const raw = JSON.stringify(body);
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature ?? signPayload(raw, APP_SECRET),
      },
      body: raw,
    });
    await background.drain();
    return res;
  }

  return { app, post, time, transport, window, sender, processor, process, respond, idempotency, background };
}
