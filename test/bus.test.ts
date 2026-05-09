import { describe, it, expect, beforeEach } from "vitest";
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
