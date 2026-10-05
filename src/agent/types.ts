import type { Conversation } from "../conversation/store.js";

export interface AgentReply {
  text: string;
}

/**
 * The only thing an agent has to do. It gets the conversation so far and
 * returns a reply, or null to stay quiet (for example, to hand off to a human).
 *
 * The agent never sends anything itself. Sending goes through GuardedSender,
 * so a buggy or prompt-injected agent still cannot bypass the safety rails.
 */
export interface Agent {
  readonly name: string;
  respond(conversation: Conversation): Promise<AgentReply | null>;
}
