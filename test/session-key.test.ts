import { describe, it, expect } from "vitest";
import {
  buildAgentLinkSessionKey,
  buildConversationId,
  parseConversationId,
  resolveSessionConversation,
} from "../src/session-key.js";

describe("session-key", () => {
  it("produces SRS-shaped session keys per (agent, peer)", () => {
    expect(buildAgentLinkSessionKey("roy", "evacastro")).toBe(
      "agent:roy:agent-link:direct:evacastro",
    );
    expect(buildAgentLinkSessionKey("evacastro", "roy")).toBe(
      "agent:evacastro:agent-link:direct:roy",
    );
  });

  it("produces distinct sessions per peer (no collapse)", () => {
    const a = buildAgentLinkSessionKey("roy", "evacastro");
    const b = buildAgentLinkSessionKey("roy", "paco");
    expect(a).not.toBe(b);
  });

  it("conversation id round-trips", () => {
    const id = buildConversationId("roy", "evacastro");
    expect(parseConversationId(id)).toEqual({ agentId: "roy", peerId: "evacastro" });
  });

  it("parseConversationId returns null for malformed input", () => {
    expect(parseConversationId("nope")).toBeNull();
    expect(parseConversationId("::peer")).toBeNull();
    expect(parseConversationId("agent::")).toBeNull();
  });

  it("resolveSessionConversation passes raw id through", () => {
    const r = resolveSessionConversation("anything");
    expect(r.baseConversationId).toBe("anything");
  });
});
