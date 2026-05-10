import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLinkBus, resetAgentLinkBusForTests } from "../src/bus.js";

beforeEach(() => {
  resetAgentLinkBusForTests();
});

describe("AgentLinkBus", () => {
  it("delivers a message from sender to recipient subscriber", async () => {
    const bus = new AgentLinkBus();
    const received: string[] = [];
    bus.subscribe("evacastro", (e) => {
      received.push(`${e.from}->${e.to}:${e.text}`);
      return;
    });
    bus.send({ from: "roy", to: "evacastro", text: "ping" });
    await Promise.resolve();
    expect(received).toEqual(["roy->evacastro:ping"]);
  });

  it("supports round-trip in both directions", async () => {
    const bus = new AgentLinkBus();
    const royInbox: string[] = [];
    const evaInbox: string[] = [];
    bus.subscribe("roy", (e) => {
      royInbox.push(e.text);
    });
    bus.subscribe("evacastro", (e) => {
      evaInbox.push(e.text);
    });
    bus.send({ from: "roy", to: "evacastro", text: "hola" });
    bus.send({ from: "evacastro", to: "roy", text: "hola, Roy" });
    await Promise.resolve();
    expect(evaInbox).toEqual(["hola"]);
    expect(royInbox).toEqual(["hola, Roy"]);
  });

  it("does not leak messages to non-target listeners", async () => {
    const bus = new AgentLinkBus();
    const pacoInbox: string[] = [];
    bus.subscribe("paco", (e) => {
      pacoInbox.push(e.text);
    });
    bus.send({ from: "roy", to: "evacastro", text: "secret" });
    await Promise.resolve();
    expect(pacoInbox).toEqual([]);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new AgentLinkBus();
    const inbox: string[] = [];
    const unsub = bus.subscribe("evacastro", (e) => {
      inbox.push(e.text);
    });
    unsub();
    bus.send({ from: "roy", to: "evacastro", text: "after-unsub" });
    await Promise.resolve();
    expect(inbox).toEqual([]);
  });

  it("assigns unique messageIds", () => {
    const bus = new AgentLinkBus();
    const a = bus.send({ from: "roy", to: "evacastro", text: "a" });
    const b = bus.send({ from: "roy", to: "evacastro", text: "b" });
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("coerces non-string text payloads to JSON strings", async () => {
    const bus = new AgentLinkBus();
    const inbox: string[] = [];
    bus.subscribe("evacastro", (e) => {
      inbox.push(e.text);
    });
    bus.send({
      from: "roy",
      to: "evacastro",
      // Caller passed an object instead of a stringified payload.
      text: { tipo: "ping", n: 7 } as unknown as string,
    });
    bus.send({
      from: "roy",
      to: "evacastro",
      text: ["a", "b"] as unknown as string,
    });
    bus.send({
      from: "roy",
      to: "evacastro",
      text: 42 as unknown as string,
    });
    bus.send({
      from: "roy",
      to: "evacastro",
      text: null as unknown as string,
    });
    await Promise.resolve();
    expect(inbox).toEqual([
      '{"tipo":"ping","n":7}',
      '["a","b"]',
      "42",
      "",
    ]);
  });
});

describe("AgentLinkBus cache hardening", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-link-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("expires entries past the TTL", () => {
    const bus = new AgentLinkBus({ cacheTtlMs: 50 });
    const ev = bus.send({ from: "roy", to: "evacastro", text: "hi" });
    expect(bus.getCachedMessage(ev.messageId)?.text).toBe("hi");
    // Force the cached timestamp into the past to avoid sleeping in tests.
    const cached = (bus as unknown as {
      cache: Map<string, { timestampMs: number }>;
    }).cache.get(ev.messageId);
    if (cached) cached.timestampMs = Date.now() - 1000;
    expect(bus.getCachedMessage(ev.messageId)).toBeUndefined();
  });

  it("evicts the oldest entry when the cap is reached", () => {
    const bus = new AgentLinkBus({ maxCacheEntries: 3 });
    const a = bus.send({ from: "roy", to: "evacastro", text: "1" });
    const b = bus.send({ from: "roy", to: "evacastro", text: "2" });
    const c = bus.send({ from: "roy", to: "evacastro", text: "3" });
    bus.send({ from: "roy", to: "evacastro", text: "4" });
    expect(bus.getCachedMessage(a.messageId)).toBeUndefined();
    expect(bus.getCachedMessage(b.messageId)?.text).toBe("2");
    expect(bus.getCachedMessage(c.messageId)?.text).toBe("3");
  });

  it("persists the cache to disk and reloads it on a fresh bus", async () => {
    const path = join(tmpDir, "cache.json");
    const writer = new AgentLinkBus({ cacheFilePath: path });
    const ev = writer.send({ from: "roy", to: "evacastro", text: "persisted" });
    await writer.drainPendingWrites();

    const reader = new AgentLinkBus({ cacheFilePath: path });
    expect(reader.getCachedMessage(ev.messageId)?.text).toBe("persisted");
  });

  it("starts with an empty cache when the file is corrupted", () => {
    const path = join(tmpDir, "cache.json");
    writeFileSync(path, "{not json", "utf-8");
    const bus = new AgentLinkBus({ cacheFilePath: path });
    // Sending must still work; cache is just empty initially.
    const ev = bus.send({ from: "roy", to: "evacastro", text: "ok" });
    expect(bus.getCachedMessage(ev.messageId)?.text).toBe("ok");
  });

  it("drops entries older than the TTL when reloading from disk", async () => {
    const path = join(tmpDir, "cache.json");
    const writer = new AgentLinkBus({
      cacheFilePath: path,
      cacheTtlMs: 50,
    });
    const ev = writer.send({ from: "roy", to: "evacastro", text: "stale" });
    await writer.drainPendingWrites();
    // Rewrite the persisted file with an old timestamp to simulate a long
    // gap between gateway runs.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          {
            from: "roy",
            to: "evacastro",
            text: "stale",
            messageId: ev.messageId,
            timestampMs: Date.now() - 60_000,
          },
        ],
      }),
      "utf-8",
    );
    const reader = new AgentLinkBus({
      cacheFilePath: path,
      cacheTtlMs: 50,
    });
    expect(reader.getCachedMessage(ev.messageId)).toBeUndefined();
  });

  it("does not write to disk when persistence is disabled", () => {
    const path = join(tmpDir, "cache.json");
    const bus = new AgentLinkBus({ cacheFilePath: null });
    bus.send({ from: "roy", to: "evacastro", text: "ephemeral" });
    // No file should have been created.
    expect(() => readFileOrNull(path)).not.toThrow();
    expect(readFileOrNull(path)).toBeNull();
  });
});

import { existsSync, readFileSync } from "node:fs";
function readFileOrNull(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}
