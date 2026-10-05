/**
 * Every reason the kit refuses to send. Callers can switch on `code` and
 * decide what to do: queue a template, alert a human, or drop the reply.
 */
export type OutboundErrorCode =
  | "agent_disabled"
  | "group_recipient"
  | "not_allowlisted"
  | "window_closed"
  | "invalid_template";

export abstract class OutboundError extends Error {
  abstract readonly code: OutboundErrorCode;
}

export class AgentDisabledError extends OutboundError {
  readonly code = "agent_disabled" as const;
  constructor() {
    super("AGENT_ENABLED is false: outbound messages are switched off");
  }
}

export class GroupRecipientError extends OutboundError {
  readonly code = "group_recipient" as const;
  constructor(readonly recipient: string) {
    super("Refusing to send to a non 1:1 recipient");
  }
}

export class NotAllowlistedError extends OutboundError {
  readonly code = "not_allowlisted" as const;
  constructor(readonly recipient: string) {
    super("Recipient is not in OUTBOUND_ALLOWLIST");
  }
}

export class WindowClosedError extends OutboundError {
  readonly code = "window_closed" as const;
  constructor(
    readonly recipient: string,
    readonly closedAt: number | undefined,
  ) {
    super(
      closedAt === undefined
        ? "No inbound message from this contact yet: only an approved template can open the conversation"
        : "The 24-hour service window is closed: send an approved template instead",
    );
  }
}

export class TemplateValidationError extends OutboundError {
  readonly code = "invalid_template" as const;
  constructor(message: string) {
    super(message);
  }
}
