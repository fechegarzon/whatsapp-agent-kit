import type { Conversation } from "../conversation/store.js";
import type { Agent, AgentReply } from "./types.js";

interface FaqEntry {
  keywords: string[];
  answer: string;
}

/** Synthetic FAQ for a fictional apartment building. Replace with your own. */
export const DEMO_FAQ: FaqEntry[] = [
  {
    keywords: ["hours", "open", "office"],
    answer: "The leasing office is open Monday to Friday, 9am to 6pm.",
  },
  {
    keywords: ["tour", "visit", "see the"],
    answer: "Happy to set up a tour. What day works for you this week?",
  },
  {
    keywords: ["pet", "dog", "cat"],
    answer: "Pets are welcome. There is a one-time pet fee and a 2-pet limit.",
  },
  {
    keywords: ["human", "agent", "person", "someone"],
    answer: "Got it. A person from our team will reply here shortly.",
  },
];

/**
 * Deterministic agent: keyword FAQ, then echo. No network, no randomness,
 * so tests and local runs behave the same every time.
 */
export class FaqAgent implements Agent {
  readonly name = "faq";

  constructor(private readonly faq: FaqEntry[] = DEMO_FAQ) {}

  async respond(conversation: Conversation): Promise<AgentReply | null> {
    const last = conversation.turns.at(-1);
    if (!last || last.role !== "user") return null;

    const text = last.text.toLowerCase();
    if (text.startsWith("[voice note]") || text.startsWith("[image]") || text.startsWith("[document")) {
      return { text: "Thanks! I can only read text for now. Could you type your question?" };
    }

    const hit = this.faq.find((e) => e.keywords.some((k) => text.includes(k)));
    if (hit) return { text: hit.answer };

    return { text: `You said: "${last.text}". Ask me about office hours, tours or pets.` };
  }
}
