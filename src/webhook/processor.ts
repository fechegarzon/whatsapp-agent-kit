import type { Agent } from "../agent/types.js";
import { describe } from "../background.js";
import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { ConversationStore } from "../conversation/store.js";
import type { Logger } from "../logger.js";
import { maskWaId } from "../logger.js";
import { OutboundError } from "../outbound/errors.js";
import type { GuardedSender } from "../outbound/sender.js";
import type { IdempotencyStore } from "../store/idempotency.js";
import { DEFAULT_DEDUPE_TTL_MS, messageKey, statusKey } from "../store/idempotency.js";
import type { ServiceWindow } from "../store/service-window.js";
import type { MessageEnvelope, StatusEnvelope, WebhookPayload } from "./schema.js";
import { messageToText, parseMessage } from "./schema.js";

export interface ProcessorDeps {
  idempotency: IdempotencyStore;
  window: ServiceWindow;
  conversations: ConversationStore;
  agent: Agent;
  sender: GuardedSender;
  agentEnabled: boolean;
  logger: Logger;
  clock?: Clock;
  dedupeTtlMs?: number;
  /** Hook for delivery receipts: update a CRM, alert on failures, etc. */
  onStatus?: (status: StatusEnvelope) => void | Promise<void>;
}

export type MessageOutcome =
  | "replied"
  | "dry_run"
  | "no_reply"
  | "duplicate"
  | "unsupported"
  | "invalid"
  | "group_ignored"
  | "agent_disabled"
  | "refused"
  | "error";

export interface ProcessSummary {
  messages: Record<string, MessageOutcome>;
  statuses: { processed: number; duplicates: number };
}

// Meta error codes worth calling out in logs.
const RE_ENGAGEMENT_REQUIRED = 131047; // sent outside the 24-hour window

export class WebhookProcessor {
  private readonly clock: Clock;
  private readonly ttl: number;

  constructor(private readonly deps: ProcessorDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ttl = deps.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  }

  async process(payload: WebhookPayload): Promise<ProcessSummary> {
    const summary: ProcessSummary = { messages: {}, statuses: { processed: 0, duplicates: 0 } };

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== "messages") continue;
        const { value } = change;

        for (const status of value.statuses ?? []) {
          const fresh = await this.handleStatus(status);
          if (fresh) summary.statuses.processed++;
          else summary.statuses.duplicates++;
        }

        for (const envelope of value.messages ?? []) {
          const name = value.contacts?.find((c) => c.wa_id === envelope.from)?.profile?.name;
          summary.messages[envelope.id] = await this.handleMessage(envelope, name);
        }
      }
    }
    return summary;
  }

  private async handleStatus(status: StatusEnvelope): Promise<boolean> {
    const { logger } = this.deps;
    if (!(await this.deps.idempotency.claim(statusKey(status.id, status.status), this.ttl))) {
      logger.debug("status.duplicate", { id: status.id, status: status.status });
      return false;
    }

    if (status.status === "failed") {
      const errors = (status as { errors?: Array<{ code?: number; title?: string }> }).errors ?? [];
      const outsideWindow = errors.some((e) => e.code === RE_ENGAGEMENT_REQUIRED);
      logger.warn("status.failed", {
        id: status.id,
        to: maskWaId(status.recipient_id),
        errors: errors.map((e) => ({ code: e.code, title: e.title })),
        ...(outsideWindow ? { hint: "sent outside the 24h window; use a template" } : {}),
      });
    } else {
      logger.debug("status", { id: status.id, status: status.status });
    }

    try {
      await this.deps.onStatus?.(status);
    } catch (err) {
      logger.error("status.hook_failed", { id: status.id, error: describe(err) });
    }
    return true;
  }

  private async handleMessage(envelope: MessageEnvelope, contactName?: string): Promise<MessageOutcome> {
    const { idempotency, logger } = this.deps;
    const key = messageKey(envelope.id);

    if (!(await idempotency.claim(key, this.ttl))) {
      logger.info("message.duplicate", { id: envelope.id });
      return "duplicate";
    }

    try {
      return await this.handleClaimedMessage(envelope, contactName);
    } catch (err) {
      // Unexpected failure: give the id back so a redelivery can try again.
      await idempotency.release(key);
      logger.error("message.failed", { id: envelope.id, error: describe(err) });
      return "error";
    }
  }

  private async handleClaimedMessage(envelope: MessageEnvelope, contactName?: string): Promise<MessageOutcome> {
    const { logger } = this.deps;
    const parsed = parseMessage(envelope);

    if (parsed.kind === "unsupported") {
      logger.info("message.unsupported", { id: parsed.id, type: parsed.type });
      return "unsupported";
    }
    if (parsed.kind === "invalid") {
      logger.warn("message.invalid", { id: parsed.id, type: parsed.type, issues: parsed.issues });
      return "invalid";
    }

    const msg = parsed.message;
    if (msg.group_id) {
      // Never let a group message drive a reply. The transport would refuse
      // the send anyway; this keeps the group out of the conversation store too.
      logger.warn("message.group_ignored", { id: msg.id });
      return "group_ignored";
    }

    await this.deps.window.recordInbound(msg.from, Number(msg.timestamp));
    const conversation = await this.deps.conversations.append(
      msg.from,
      { role: "user", text: messageToText(msg), at: Number(msg.timestamp) * 1000 },
      contactName,
    );

    if (!this.deps.agentEnabled) {
      logger.info("message.received_agent_disabled", { id: msg.id, from: maskWaId(msg.from) });
      return "agent_disabled";
    }

    const reply = await this.deps.agent.respond(conversation);
    if (!reply) return "no_reply";

    try {
      const outcome = await this.deps.sender.sendText(msg.from, reply.text, { replyTo: msg.id });
      await this.deps.conversations.append(msg.from, { role: "agent", text: reply.text, at: this.clock() });
      return outcome.status === "dry_run" ? "dry_run" : "replied";
    } catch (err) {
      if (err instanceof OutboundError) {
        // A policy said no. That is a decision, not a crash: do not retry.
        logger.warn("outbound.refused", { id: msg.id, code: err.code, reason: err.message });
        return "refused";
      }
      throw err;
    }
  }
}
