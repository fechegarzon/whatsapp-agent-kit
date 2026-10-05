import { z } from "zod";

/*
 * Meta's webhook payload, validated in two passes:
 *
 * 1. The envelope (entry[].changes[].value) is checked strictly enough to
 *    trust the shape, but each message and status is only checked for the
 *    fields we need to route it (id, type, status).
 * 2. Each message is then parsed on its own with a discriminated union.
 *
 * Why two passes: Meta batches several messages in one POST. If one of them
 * is a type we have never seen, a single strict schema would reject the whole
 * batch and we would drop the valid messages too.
 *
 * Every object uses z.looseObject (Zod 4's passthrough). Meta adds fields
 * without notice and we do not want a new field to break production.
 */

const WaId = z.string().regex(/^\d{6,20}$/, "expected a digits-only WhatsApp id");

// ---------- message pass 1: just enough to route ----------

export const MessageEnvelopeSchema = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string().min(1),
});

export const StatusEnvelopeSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  timestamp: z.string().regex(/^\d+$/),
  recipient_id: z.string().min(1),
});

const ContactSchema = z.looseObject({
  wa_id: z.string(),
  profile: z.looseObject({ name: z.string() }).optional(),
});

export const ChangeValueSchema = z.looseObject({
  messaging_product: z.literal("whatsapp").optional(),
  metadata: z
    .looseObject({
      display_phone_number: z.string(),
      phone_number_id: z.string(),
    })
    .optional(),
  contacts: z.array(ContactSchema).optional(),
  messages: z.array(MessageEnvelopeSchema).optional(),
  statuses: z.array(StatusEnvelopeSchema).optional(),
});

export const WebhookPayloadSchema = z.looseObject({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(
        z.looseObject({
          field: z.string(),
          value: ChangeValueSchema,
        }),
      ),
    }),
  ),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;
export type StatusEnvelope = z.infer<typeof StatusEnvelopeSchema>;

// ---------- message pass 2: full shape per type ----------

const Base = {
  id: z.string().min(1),
  from: WaId,
  timestamp: z.string().regex(/^\d+$/),
  context: z.looseObject({ from: z.string().optional(), id: z.string().optional() }).optional(),
  // Present when a message comes from a group conversation.
  group_id: z.string().optional(),
};

const Media = {
  id: z.string().min(1),
  mime_type: z.string().min(1),
  sha256: z.string().optional(),
};

export const TextMessageSchema = z.looseObject({
  ...Base,
  type: z.literal("text"),
  text: z.looseObject({ body: z.string() }),
});

export const InteractiveMessageSchema = z.looseObject({
  ...Base,
  type: z.literal("interactive"),
  interactive: z.discriminatedUnion("type", [
    z.looseObject({
      type: z.literal("button_reply"),
      button_reply: z.looseObject({ id: z.string(), title: z.string() }),
    }),
    z.looseObject({
      type: z.literal("list_reply"),
      list_reply: z.looseObject({
        id: z.string(),
        title: z.string(),
        description: z.string().optional(),
      }),
    }),
  ]),
});

/** Quick-reply button on a template message. */
export const ButtonMessageSchema = z.looseObject({
  ...Base,
  type: z.literal("button"),
  button: z.looseObject({ text: z.string(), payload: z.string().optional() }),
});

export const AudioMessageSchema = z.looseObject({
  ...Base,
  type: z.literal("audio"),
  audio: z.looseObject({ ...Media, voice: z.boolean().optional() }),
});

export const ImageMessageSchema = z.looseObject({
  ...Base,
  type: z.literal("image"),
  image: z.looseObject({ ...Media, caption: z.string().optional() }),
});

export const DocumentMessageSchema = z.looseObject({
  ...Base,
  type: z.literal("document"),
  document: z.looseObject({
    ...Media,
    filename: z.string().optional(),
    caption: z.string().optional(),
  }),
});

export const InboundMessageSchema = z.discriminatedUnion("type", [
  TextMessageSchema,
  InteractiveMessageSchema,
  ButtonMessageSchema,
  AudioMessageSchema,
  ImageMessageSchema,
  DocumentMessageSchema,
]);

export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export const SUPPORTED_MESSAGE_TYPES: ReadonlySet<string> = new Set<string>(
  InboundMessageSchema.options.map((o) => o.shape.type.value),
);

export const KNOWN_STATUSES = ["sent", "delivered", "read", "failed"] as const;

export type ParsedMessage =
  | { kind: "ok"; message: InboundMessage }
  | { kind: "unsupported"; id: string; type: string }
  | { kind: "invalid"; id: string; type: string; issues: string[] };

export function parseMessage(envelope: MessageEnvelope): ParsedMessage {
  if (!SUPPORTED_MESSAGE_TYPES.has(envelope.type)) {
    return { kind: "unsupported", id: envelope.id, type: envelope.type };
  }
  const result = InboundMessageSchema.safeParse(envelope);
  if (!result.success) {
    return {
      kind: "invalid",
      id: envelope.id,
      type: envelope.type,
      issues: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { kind: "ok", message: result.data };
}

/** Turns any supported message into the text the agent will see. */
export function messageToText(msg: InboundMessage): string {
  switch (msg.type) {
    case "text":
      return msg.text.body;
    case "interactive":
      return msg.interactive.type === "button_reply"
        ? msg.interactive.button_reply.title
        : msg.interactive.list_reply.title;
    case "button":
      return msg.button.text;
    case "audio":
      return "[voice note]";
    case "image":
      return msg.image.caption ? `[image] ${msg.image.caption}` : "[image]";
    case "document":
      return `[document${msg.document.filename ? `: ${msg.document.filename}` : ""}]`;
  }
}
