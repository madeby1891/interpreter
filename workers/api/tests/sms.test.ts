// Tests for the Twilio inbound-SMS handler.
//
// The two cases we MUST cover (per HANDOFF.md / DISASTER_RECOVERY.md):
//   1. A signature that Twilio actually computed → verify returns true.
//   2. Any tampered field → verify returns false.
//
// We additionally cover the body normaliser, since the action mapping is the
// one piece that's both stateful and easy to get subtly wrong.

import { describe, it, expect } from "vitest";
import { verifyTwilioSignature, parseInboundBody } from "../src/sms";

// Reference signature reproduced exactly the way Twilio's docs describe it:
//   signature = base64(HMAC-SHA1(authToken, fullUrl + sortedConcat(params)))
// We compute it inside the test with the Web Crypto API (Node 20+ ships it
// globally), then hand the result to verifyTwilioSignature.
async function signLikeTwilio(
  fullUrl: string,
  params: Record<string, string>,
  authToken: string
): Promise<string> {
  const keys = Object.keys(params).sort();
  let payload = fullUrl;
  for (const k of keys) payload += k + params[k];
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  );
  let bin = "";
  for (let i = 0; i < mac.length; i++) bin += String.fromCharCode(mac[i]!);
  return btoa(bin);
}

const TOKEN = "twilio-auth-token-for-tests";
const URL_INBOUND = "https://api.1891interpreter.com/v1/sms/inbound";
const PARAMS = {
  AccountSid: "ACxxxx",
  From: "+13015551234",
  To: "+13015550000",
  Body: "YES",
  MessageSid: "SM0123456789abcdef"
};

describe("verifyTwilioSignature", () => {
  it("accepts a signature Twilio would have produced", async () => {
    const sig = await signLikeTwilio(URL_INBOUND, PARAMS, TOKEN);
    expect(await verifyTwilioSignature(URL_INBOUND, PARAMS, sig, TOKEN)).toBe(true);
  });

  it("rejects a signature when the body has been tampered", async () => {
    const sig = await signLikeTwilio(URL_INBOUND, PARAMS, TOKEN);
    const tampered = { ...PARAMS, Body: "NO" };
    expect(await verifyTwilioSignature(URL_INBOUND, tampered, sig, TOKEN)).toBe(false);
  });

  it("rejects a signature when the URL has been tampered", async () => {
    const sig = await signLikeTwilio(URL_INBOUND, PARAMS, TOKEN);
    const otherUrl = URL_INBOUND + "?evil=1";
    expect(await verifyTwilioSignature(otherUrl, PARAMS, sig, TOKEN)).toBe(false);
  });

  it("rejects when the signature itself is mutated", async () => {
    const sig = await signLikeTwilio(URL_INBOUND, PARAMS, TOKEN);
    // Flip the first character.
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(await verifyTwilioSignature(URL_INBOUND, PARAMS, flipped, TOKEN)).toBe(false);
  });

  it("rejects when the auth token is wrong", async () => {
    const sig = await signLikeTwilio(URL_INBOUND, PARAMS, TOKEN);
    expect(await verifyTwilioSignature(URL_INBOUND, PARAMS, sig, "wrong-token")).toBe(false);
  });

  it("rejects empty signature or token", async () => {
    expect(await verifyTwilioSignature(URL_INBOUND, PARAMS, "", TOKEN)).toBe(false);
    expect(await verifyTwilioSignature(URL_INBOUND, PARAMS, "anything", "")).toBe(false);
  });
});

describe("parseInboundBody", () => {
  it("maps YES family to accept", () => {
    for (const w of ["yes", "Y", " yes ", "ACCEPT", "claim", "ok"]) {
      expect(parseInboundBody(w).action).toBe("accept");
    }
  });

  it("maps NO family to decline", () => {
    for (const w of ["no", "N", "decline", "PASS", "skip"]) {
      expect(parseInboundBody(w).action).toBe("decline");
    }
  });

  it("maps STOP family to optout", () => {
    for (const w of ["stop", "STOPALL", "Unsubscribe", "cancel", "end", "quit"]) {
      expect(parseInboundBody(w).action).toBe("optout");
    }
  });

  it("maps HELP family to help", () => {
    expect(parseInboundBody("HELP").action).toBe("help");
    expect(parseInboundBody("info").action).toBe("help");
  });

  it("treats anything else as unknown and normalises whitespace", () => {
    const out = parseInboundBody("  hey   what's   up  ");
    expect(out.action).toBe("unknown");
    expect(out.normalised).toBe("HEY WHAT'S UP");
  });
});
