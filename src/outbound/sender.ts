import type { Logger } from "../logger.js";
import { maskWaId } from "../logger.js";
import type { ServiceWindow } from "../store/service-window.js";
import { AgentDisabledError, NotAllowlistedError, WindowClosedError } from "./errors.js";
import type { TemplatePayload } from "./templates.js";
import type { OutboundPayload, Transport } from "./transport.js";
import { assertIndividualRecipient, toGraphBody } from "./transport.js";

export interface SafetySwitches {
  /** Kill switch. When false nothing is sent, dry run or not. */
  agentEnabled: boolean;
  /** Rehearsal mode. The whole pipeline runs, the payload is logged, the transport is never called. */
  dryRun: boolean;
  /** When non-empty, only these wa_ids can receive messages. */
  allowlist: readonly string[];
}

export type SendOutcome =
  | { status: "sent"; messageId: string }
  | { status: "dry_run"; body: Record<string, unknown> };

/** WhatsApp's limit for a text body. */
export const MAX_TEXT_LENGTH = 4096;

/**
 * Every outbound message goes through here. The checks run in a fixed order
 * and each one fails closed with a typed error:
 *
 *   kill switch -> 1:1 recipient -> allowlist -> 24h window -> dry run -> transport
 */
export class GuardedSender {
  private readonly allow: ReadonlySet<string>;

  constructor(
    private readonly transport: Transport,
    private readonly window: ServiceWindow,
    private readonly switches: SafetySwitches,
    private readonly logger: Logger,
  ) {
    this.allow = new Set(switches.allowlist);
  }

  /** Free-form text. Only allowed while the 24-hour window is open. */
  async sendText(to: string, body: string, opts: { replyTo?: string } = {}): Promise<SendOutcome> {
    this.preflight(to);
    if (!(await this.window.isOpen(to))) {
      throw new WindowClosedError(to, await this.window.closesAt(to));
    }
    const text = body.length > MAX_TEXT_LENGTH ? body.slice(0, MAX_TEXT_LENGTH - 1) + "…" : body;
    return this.dispatch({ kind: "text", to, body: text, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) });
  }

  /**
   * Approved template. Allowed outside the window. Build the payload with
   * buildTemplate() so the parameters are checked first.
   */
  async sendTemplate(to: string, template: TemplatePayload): Promise<SendOutcome> {
    this.preflight(to);
    return this.dispatch({ kind: "template", to, template });
  }

  private preflight(to: string): void {
    if (!this.switches.agentEnabled) throw new AgentDisabledError();
    assertIndividualRecipient(to);
    if (this.allow.size > 0 && !this.allow.has(to)) throw new NotAllowlistedError(to);
  }

  private async dispatch(payload: OutboundPayload): Promise<SendOutcome> {
    if (this.switches.dryRun) {
      const body = toGraphBody(payload);
      this.logger.info("dry_run.would_send", { to: maskWaId(payload.to), kind: payload.kind, body: redactTo(body) });
      return { status: "dry_run", body };
    }
    const { messageId } = await this.transport.send(payload);
    this.logger.info("outbound.sent", { to: maskWaId(payload.to), kind: payload.kind, messageId });
    return { status: "sent", messageId };
  }
}

function redactTo(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, to: typeof body.to === "string" ? maskWaId(body.to) : body.to };
}
