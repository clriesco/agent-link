import { describe, it, expect } from "vitest";
import { resolveAccount, inspectAccount, isPairAllowed } from "../src/config.js";

const cfg = {
  channels: {
    "agent-link": {
      pairs: [
        { from: "roy", to: "evacastro" },
        { from: "evacastro", to: "roy" },
        { from: "roy", to: "paco" },
      ],
    },
  },
} as const;

describe("config.resolveAccount", () => {
  it("scopes pairs and peers to the requested account", () => {
    const acc = resolveAccount(cfg as never, "roy");
    expect(acc.accountId).toBe("roy");
    expect(acc.allowedPeers.sort()).toEqual(["evacastro", "paco"]);
    expect(acc.dmPolicy).toBe("allowlist");
    expect(acc.pairs.length).toBe(3);
  });

  it("returns empty peers when no accountId provided", () => {
    const acc = resolveAccount(cfg as never, null);
    expect(acc.allowedPeers).toEqual([]);
  });

  it("falls back to allowlist when dmSecurity is not set", () => {
    const acc = resolveAccount({ channels: { "agent-link": {} } } as never, "roy");
    expect(acc.dmPolicy).toBe("allowlist");
    expect(acc.allowedPeers).toEqual([]);
  });
});

describe("config.inspectAccount", () => {
  it("reports configured when pairs exist", () => {
    const insp = inspectAccount(cfg as never, "roy");
    expect(insp.configured).toBe(true);
    expect(insp.enabled).toBe(true);
    expect(insp.pairsCount).toBe(3);
  });

  it("reports unconfigured when section is empty", () => {
    const insp = inspectAccount({ channels: {} } as never, "roy");
    expect(insp.configured).toBe(false);
  });
});

describe("config.isPairAllowed", () => {
  it("matches direction strictly", () => {
    const pairs = [{ from: "roy", to: "evacastro" }];
    expect(isPairAllowed(pairs, "roy", "evacastro")).toBe(true);
    expect(isPairAllowed(pairs, "evacastro", "roy")).toBe(false);
  });
});
