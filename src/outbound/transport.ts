import { GroupRecipientError } from "./errors.js";
import type { TemplatePayload } from "./templates.js";

export type OutboundPayload =
  | { kind: "text"; to: string; body: string; replyTo?: string }
  | { kind: "template"; to: string; template: TemplatePayload };

export interface SendResult {
  messageId: string;
}

/** The only thing that talks to Meta. Swap it for a fake in tests. */
export interface Transport {
  send(payload: OutboundPayload): Promise<SendResult>;
}

/**
 * A 1:1 recipient is a wa_id: digits only, E.164 without the plus sign.
 * Group ids, "@g.us" style JIDs, broadcast lists and anything else fail.
 *
 * This lives in the transport on purpose. The agent, the processor and any
 * future caller can all get it wrong; the last function before the network
 * cannot be skipped.
 */
const INDIVIDUAL_WA_ID = /^[1-9]\d{6,14}$/;

export function assertIndividualRecipient(to: string): void {
  if (!INDIVIDUAL_WA_ID.test(to)) throw new GroupRecipientError(to);
}

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`WhatsApp Cloud API returned HTTP ${status}`);
  }
}

export interface GraphApiTransportOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class GraphApiTransport implements Transport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GraphApiTransportOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async send(payload: OutboundPayload): Promise<SendResult> {
    assertIndividualRecipient(payload.to);

    const url = `https://graph.facebook.com/${this.opts.apiVersion}/${this.opts.phoneNumberId}/messages`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.opts.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(toGraphBody(payload)),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw new GraphApiError(res.status, body);

    const id = (body as { messages?: Array<{ id?: string }> } | undefined)?.messages?.[0]?.id;
    if (!id) throw new GraphApiError(res.status, body);
    return { messageId: id };
  }
}

export function toGraphBody(payload: OutboundPayload): Record<string, unknown> {
  const base = {
    messaging_product: "whatsapp",
    // Always explicit. Never let a default decide whether this is a group send.
    recipient_type: "individual",
    to: payload.to,
  };
  if (payload.kind === "template") return { ...base, type: "template", template: payload.template };
  return {
    ...base,
    type: "text",
    text: { body: payload.body, preview_url: false },
    ...(payload.replyTo ? { context: { message_id: payload.replyTo } } : {}),
  };
}
