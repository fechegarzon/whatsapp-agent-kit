import Anthropic from "@anthropic-ai/sdk";
import type { Conversation } from "../conversation/store.js";
import type { Logger } from "../logger.js";
import type { Agent, AgentReply } from "./types.js";

const SYSTEM_PROMPT = `You are a helpful assistant answering customers over WhatsApp for a fictional apartment building.
Keep replies short: two or three sentences, plain text, no markdown.
If you do not know something, say so and offer to connect them with a person.
Never ask for passwords, card numbers or government ID numbers.`;

export interface AnthropicAgentOptions {
  apiKey: string;
  model: string;
  logger: Logger;
  /** Override for tests or proxies. */
  client?: Anthropic;
}

/**
 * Optional agent backed by Claude. Only wired in when ANTHROPIC_API_KEY is
 * set. Not used in tests.
 */
export class AnthropicAgent implements Agent {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicAgentOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: 30_000, maxRetries: 2 });
  }

  async respond(conversation: Conversation): Promise<AgentReply | null> {
    const messages = toMessages(conversation);
    if (messages.length === 0) return null;

    const response = await this.client.beta.messages.create({
      model: this.opts.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages,
      // Chat replies do not need deep reasoning; low effort keeps latency down.
      output_config: { effort: "low" },
      // If a safety classifier declines, let the API retry on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      this.opts.logger.warn("agent.refusal", { model: response.model });
      return null; // stay quiet; a human can pick it up
    }

    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    return text ? { text } : null;
  }
}

/** Claude expects alternating user/assistant turns that start with the user. */
function toMessages(conversation: Conversation): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of conversation.turns) {
    const role = turn.role === "user" ? "user" : "assistant";
    const prev = out.at(-1);
    if (prev && prev.role === role && typeof prev.content === "string") {
      prev.content += `\n${turn.text}`;
    } else {
      out.push({ role, content: turn.text });
    }
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}
