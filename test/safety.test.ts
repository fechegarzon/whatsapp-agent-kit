import { describe, expect, it, vi } from "vitest";
import { AgentDisabledError, GroupRecipientError, NotAllowlistedError } from "../src/outbound/errors.js";
import { buildTemplate } from "../src/outbound/templates.js";
import { GraphApiTransport, assertIndividualRecipient } from "../src/outbound/transport.js";
import { CUSTOMER, OTHER_CUSTOMER, harness, payloadWith, textMessage } from "./helpers.js";

const GROUP_IDS = [
  "120363000000000001@g.us",
  "15555550123-1600000000@g.us",
  "status@broadcast",
  "+15555550123", // even a 1:1 number must be digits only
  "015555550123",
  "",
];

describe("group chats are blocked at the transport layer", () => {
  it.each(GROUP_IDS)("assertIndividualRecipient refuses %j", (to) => {
    expect(() => assertIndividualRecipient(to)).toThrow(GroupRecipientError);
  });

  it("accepts a plain wa_id", () => {
    expect(() => assertIndividualRecipient(CUSTOMER)).not.toThrow();
  });

  it("GraphApiTransport never calls fetch for a group recipient", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = new GraphApiTransport({ accessToken: "t", phoneNumberId: "1", apiVersion: "v23.0", fetch });

    await expect(transport.send({ kind: "text", to: "120363000000000001@g.us", body: "hi" })).rejects.toThrow(
      GroupRecipientError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("GraphApiTransport always sends recipient_type individual", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ messages: [{ id: "wamid.out.1" }] }),
    );
    const transport = new GraphApiTransport({ accessToken: "t", phoneNumberId: "1", apiVersion: "v23.0", fetch });

    await transport.send({ kind: "text", to: CUSTOMER, body: "hi" });

    const init = fetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({ recipient_type: "individual", to: CUSTOMER });
  });

  it("the sender refuses a group even for templates (which skip the window check)", async () => {
    const { sender, transport } = harness();
    const template = buildTemplate({ name: "hello", language: "en_US", body: "Hello" }, []);

    await expect(sender.sendTemplate("120363000000000001@g.us", template)).rejects.toThrow(GroupRecipientError);
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe("dry run", () => {
  it("runs the whole pipeline but never calls the HTTP transport", async () => {
    const h = harness({ switches: { dryRun: true } });

    await h.post(payloadWith({ messages: [textMessage("wamid.dry", "office hours?", { timestampSec: h.time.nowSec() })] }));

    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(await h.process.mock.results[0]?.value).toMatchObject({ messages: { "wamid.dry": "dry_run" } });
  });

  it("returns the exact body that would have been sent", async () => {
    const { sender, window, time, transport } = harness({ switches: { dryRun: true } });
    await window.recordInbound(CUSTOMER, time.nowSec());

    const outcome = await sender.sendText(CUSTOMER, "hello");

    expect(outcome).toEqual({
      status: "dry_run",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: CUSTOMER,
        type: "text",
        text: { body: "hello", preview_url: false },
      },
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("still enforces the window and the group block", async () => {
    const { sender } = harness({ switches: { dryRun: true } });
    await expect(sender.sendText(CUSTOMER, "hi")).rejects.toMatchObject({ code: "window_closed" });
    await expect(sender.sendText("120363000000000001@g.us", "hi")).rejects.toMatchObject({ code: "group_recipient" });
  });
});

describe("kill switch and allowlist", () => {
  it("AGENT_ENABLED=false refuses every send, even a template", async () => {
    const { sender, transport } = harness({ switches: { agentEnabled: false } });
    const template = buildTemplate({ name: "hello", language: "en_US", body: "Hello" }, []);

    await expect(sender.sendTemplate(CUSTOMER, template)).rejects.toThrow(AgentDisabledError);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("with an allowlist, only listed numbers can receive messages", async () => {
    const { sender, window, time, transport } = harness({ switches: { allowlist: [CUSTOMER] } });
    await window.recordInbound(CUSTOMER, time.nowSec());
    await window.recordInbound(OTHER_CUSTOMER, time.nowSec());

    await expect(sender.sendText(CUSTOMER, "hi")).resolves.toMatchObject({ status: "sent" });
    await expect(sender.sendText(OTHER_CUSTOMER, "hi")).rejects.toThrow(NotAllowlistedError);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
