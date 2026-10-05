import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "../src/webhook/signature.js";
import { APP_SECRET, harness, payloadWith, textMessage } from "./helpers.js";

describe("verifySignature", () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts a signature made with the app secret", () => {
    expect(verifySignature(body, signPayload(body, APP_SECRET), APP_SECRET)).toBe(true);
  });

  it("is case-insensitive on the hex digest", () => {
    const sig = signPayload(body, APP_SECRET);
    expect(verifySignature(body, "sha256=" + sig.slice(7).toUpperCase(), APP_SECRET)).toBe(true);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifySignature(body, signPayload(body, "other-secret"), APP_SECRET)).toBe(false);
  });

  it("rejects when one byte of the body changes", () => {
    const sig = signPayload(body, APP_SECRET);
    expect(verifySignature(body.replace("[]", "[ ]"), sig, APP_SECRET)).toBe(false);
  });

  it.each([
    ["missing header", undefined],
    ["empty header", ""],
    ["no sha256= prefix", signPayload(body, APP_SECRET).slice(7)],
    ["sha1 prefix", "sha1=" + "a".repeat(40)],
    ["truncated digest", signPayload(body, APP_SECRET).slice(0, -2)],
    ["non-hex digest", "sha256=" + "z".repeat(64)],
  ])("rejects %s", (_label, header) => {
    expect(verifySignature(body, header, APP_SECRET)).toBe(false);
  });

  it("rejects everything when the app secret is empty", () => {
    expect(verifySignature(body, signPayload(body, ""), "")).toBe(false);
  });
});

describe("POST /webhook signature gate", () => {
  it("returns 401 and does no work when the signature is wrong", async () => {
    const h = harness();
    const payload = payloadWith({ messages: [textMessage("wamid.1", "hi", { timestampSec: h.time.nowSec() })] });

    const res = await h.post(payload, signPayload("something else", APP_SECRET));

    expect(res.status).toBe(401);
    expect(h.process).not.toHaveBeenCalled();
    expect(h.transport.send).not.toHaveBeenCalled();
  });

  it("returns 200 and processes the payload when the signature is valid", async () => {
    const h = harness();
    const payload = payloadWith({ messages: [textMessage("wamid.1", "hi", { timestampSec: h.time.nowSec() })] });

    const res = await h.post(payload);

    expect(res.status).toBe(200);
    expect(h.process).toHaveBeenCalledTimes(1);
  });
});

describe("GET /webhook verification", () => {
  it("echoes the challenge when the verify token matches", async () => {
    const { app } = harness();
    const res = await app.request(
      "/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=1158201444",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("returns 403 when the verify token is wrong", async () => {
    const { app } = harness();
    const res = await app.request("/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1");
    expect(res.status).toBe(403);
  });
});
