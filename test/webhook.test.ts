import { describe, expect, it } from "vitest";
import { signPayload } from "../src/webhook/signature.js";
import { APP_SECRET, CUSTOMER, harness, payloadWith, textMessage } from "./helpers.js";

describe("POST /webhook processing", () => {
  it("answers 200 before the agent finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      agent: {
        name: "slow",
        respond: async () => {
          await gate;
          return { text: "done" };
        },
      },
    });
    const raw = payloadWith({ messages: [textMessage("wamid.slow", "hi", { timestampSec: h.time.nowSec() })] });

    // Call the app directly so we can look at the state before draining.
    const body = JSON.stringify(raw);
    const res = await h.app.request("/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": signPayload(body, APP_SECRET) },
      body,
    });

    expect(res.status).toBe(200);
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(h.background.size).toBe(1);

    release();
    await h.background.drain();
    expect(h.transport.send).toHaveBeenCalledTimes(1);
  });

  it("replies once to a message and ignores the duplicate delivery", async () => {
    const h = harness();
    const payload = payloadWith({
      messages: [textMessage("wamid.dup", "what are your office hours?", { timestampSec: h.time.nowSec() })],
    });

    await h.post(payload);
    await h.post(payload);

    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.transport.send).toHaveBeenCalledTimes(1);
    expect(h.transport.sent[0]).toMatchObject({ kind: "text", to: CUSTOMER, replyTo: "wamid.dup" });
    expect(await h.process.mock.results[1]?.value).toMatchObject({ messages: { "wamid.dup": "duplicate" } });
  });

  it("dedupes the same id inside one batch", async () => {
    const h = harness();
    const msg = textMessage("wamid.same", "hello", { timestampSec: h.time.nowSec() });

    await h.post(payloadWith({ messages: [msg, msg] }));

    expect(h.transport.send).toHaveBeenCalledTimes(1);
  });

  it("dedupes statuses by id + status, but lets each new status through", async () => {
    const h = harness();
    const ts = String(h.time.nowSec());
    const status = (s: string) => ({ id: "wamid.out.1", status: s, timestamp: ts, recipient_id: CUSTOMER });

    await h.post(payloadWith({ statuses: [status("sent"), status("delivered")] }));
    await h.post(payloadWith({ statuses: [status("delivered"), status("read")] }));

    const results = await Promise.all(h.process.mock.results.map((r) => r.value));
    expect(results[0]).toMatchObject({ statuses: { processed: 2, duplicates: 0 } });
    expect(results[1]).toMatchObject({ statuses: { processed: 1, duplicates: 1 } });
  });

  it("keeps processing a batch when one message is malformed or unsupported", async () => {
    const h = harness();
    const ts = h.time.nowSec();

    await h.post(
      payloadWith({
        messages: [
          { from: CUSTOMER, id: "wamid.bad", timestamp: String(ts), type: "text" }, // no text.body
          { from: CUSTOMER, id: "wamid.sticker", timestamp: String(ts), type: "sticker", sticker: { id: "x" } },
          textMessage("wamid.good", "do you allow pets?", { timestampSec: ts }),
        ],
      }),
    );

    expect(await h.process.mock.results[0]?.value).toMatchObject({
      messages: { "wamid.bad": "invalid", "wamid.sticker": "unsupported", "wamid.good": "replied" },
    });
    expect(h.transport.send).toHaveBeenCalledTimes(1);
  });

  it("parses interactive, button and media messages", async () => {
    const h = harness();
    const ts = String(h.time.nowSec());
    const base = { from: CUSTOMER, timestamp: ts };

    await h.post(
      payloadWith({
        messages: [
          { ...base, id: "m1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Book a tour" } } },
          { ...base, id: "m2", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "l1", title: "Pets", description: "Pet policy" } } },
          { ...base, id: "m3", type: "button", button: { text: "Yes", payload: "CONFIRM" } },
          { ...base, id: "m4", type: "audio", audio: { id: "media1", mime_type: "audio/ogg; codecs=opus", voice: true } },
          { ...base, id: "m5", type: "image", image: { id: "media2", mime_type: "image/jpeg", caption: "front door" } },
          { ...base, id: "m6", type: "document", document: { id: "media3", mime_type: "application/pdf", filename: "lease.pdf" } },
        ],
      }),
    );

    const summary = await h.process.mock.results[0]?.value;
    expect(Object.values(summary.messages)).toEqual(Array(6).fill("replied"));
  });

  it("does not reply to messages that come from a group", async () => {
    const h = harness();
    await h.post(
      payloadWith({
        messages: [{ ...textMessage("wamid.g", "hi all", { timestampSec: h.time.nowSec() }), group_id: "120363000000000001" }],
      }),
    );

    expect(h.respond).not.toHaveBeenCalled();
    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it("records the message but stays quiet when AGENT_ENABLED is false", async () => {
    const h = harness({ switches: { agentEnabled: false } });
    await h.post(payloadWith({ messages: [textMessage("wamid.off", "hello", { timestampSec: h.time.nowSec() })] }));

    expect(h.respond).not.toHaveBeenCalled();
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(await h.window.isOpen(CUSTOMER)).toBe(true);
  });

  it("returns 200 for an authentic payload with an unexpected shape, without processing it", async () => {
    const h = harness();
    const res = await h.post({ object: "page", entry: [] });

    expect(res.status).toBe(200);
    expect(h.process).not.toHaveBeenCalled();
  });

  it("releases the dedupe key when processing crashes, so a redelivery can retry", async () => {
    let calls = 0;
    const h = harness({
      agent: {
        name: "flaky",
        respond: async () => {
          calls++;
          if (calls === 1) throw new Error("model timeout");
          return { text: "second try worked" };
        },
      },
    });
    const payload = payloadWith({ messages: [textMessage("wamid.retry", "hi", { timestampSec: h.time.nowSec() })] });

    await h.post(payload);
    await h.post(payload);

    expect(calls).toBe(2);
    expect(h.transport.send).toHaveBeenCalledTimes(1);
  });
});
