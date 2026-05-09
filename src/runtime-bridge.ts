import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { AgentLinkInboundEvent } from "./types.js";
import { buildAgentLinkSessionKey } from "./session-key.js";
import type { AgentLinkBus } from "./bus.js";

interface ConversationRuntime {
  recordInboundSession: unknown;
}
interface ReplyDispatchRuntime {
  dispatchReplyWithBufferedBlockDispatcher: unknown;
  finalizeInboundContext: (input: Record<string, unknown>) => unknown;
  resolveChunkMode?: unknown;
}
interface SessionStoreRuntime {
  resolveStorePath: (
    store: unknown,
    params: { agentId: string },
  ) => string;
}
interface ChannelReplyPipelineRuntime {
  createChannelReplyPipeline: (params: {
    cfg: unknown;
    agentId: string;
    channel: string;
    accountId: string;
  }) => Record<string, unknown> & { onModelSelected?: unknown };
}

let conversationRuntime: ConversationRuntime | null = null;
let replyDispatchRuntime: ReplyDispatchRuntime | null = null;
let sessionStoreRuntime: SessionStoreRuntime | null = null;
let replyPipelineRuntime: ChannelReplyPipelineRuntime | null = null;

async function loadRuntimes(): Promise<{
  conv: ConversationRuntime;
  reply: ReplyDispatchRuntime;
  store: SessionStoreRuntime;
  pipeline: ChannelReplyPipelineRuntime;
}> {
  if (!conversationRuntime) {
    conversationRuntime = (await import(
      "openclaw/plugin-sdk/conversation-runtime"
    )) as unknown as ConversationRuntime;
  }
  if (!replyDispatchRuntime) {
    replyDispatchRuntime = (await import(
      "openclaw/plugin-sdk/reply-dispatch-runtime"
    )) as unknown as ReplyDispatchRuntime;
  }
  if (!sessionStoreRuntime) {
    sessionStoreRuntime = (await import(
      "openclaw/plugin-sdk/session-store-runtime"
    )) as unknown as SessionStoreRuntime;
  }
  if (!replyPipelineRuntime) {
    replyPipelineRuntime = (await import(
      "openclaw/plugin-sdk/channel-reply-pipeline"
    )) as unknown as ChannelReplyPipelineRuntime;
  }
  return {
    conv: conversationRuntime,
    reply: replyDispatchRuntime,
    store: sessionStoreRuntime,
    pipeline: replyPipelineRuntime,
  };
}

export interface DispatchInboundParams {
  event: AgentLinkInboundEvent;
  cfg: unknown;
  bus: AgentLinkBus;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

export async function dispatchAgentLinkInbound(
  params: DispatchInboundParams,
): Promise<void> {
  const { event, cfg, bus, log } = params;
  const { conv, reply, store, pipeline } = await loadRuntimes();

  const agentId = event.to;
  const peerId = event.from;
  const sessionKey = buildAgentLinkSessionKey(agentId, peerId);

  const sessionStoreCfg = (cfg as { session?: { store?: unknown } }).session
    ?.store;
  const storePath = store.resolveStorePath(sessionStoreCfg, { agentId });

  const bodyForAgent = buildBodyForAgent(event, bus);

  const ctxPayload = reply.finalizeInboundContext({
    Body: event.text,
    BodyForAgent: bodyForAgent,
    RawBody: event.text,
    CommandBody: event.text,
    From: `agent-link:${peerId}`,
    To: `agent-link:${agentId}`,
    SessionKey: sessionKey,
    AccountId: agentId,
    ChatType: "dm",
    ConversationLabel: peerId,
    SenderName: peerId,
    SenderId: peerId,
    Provider: "agent-link",
    Surface: "agent-link",
    OriginatingChannel: "agent-link",
    OriginatingTo: peerId,
    WasMentioned: true,
    CommandAuthorized: false,
    CommandSource: "text",
    MessageSid: event.messageId,
    Timestamp: new Date(event.timestampMs).toISOString(),
  });

  const replyPipeline = pipeline.createChannelReplyPipeline({
    cfg,
    agentId,
    channel: "agent-link",
    accountId: agentId,
  });
  const { onModelSelected } = replyPipeline as { onModelSelected?: unknown };

  try {
    await dispatchInboundReplyWithBase({
      cfg: cfg as never,
      channel: "agent-link",
      accountId: agentId,
      route: { agentId, sessionKey },
      storePath,
      ctxPayload: ctxPayload as never,
      core: {
        channel: {
          session: {
            recordInboundSession: conv.recordInboundSession as never,
          },
          reply: {
            dispatchReplyWithBufferedBlockDispatcher:
              reply.dispatchReplyWithBufferedBlockDispatcher as never,
          },
        },
      },
      deliver: async (payload: { text?: string } & Record<string, unknown>) => {
        const text = payload.text ?? "";
        if (!text) return;
        bus.send({
          from: agentId,
          to: peerId,
          text,
          replyToId: event.messageId,
        });
      },
      onRecordError: (err: unknown) => {
        log?.("error", `agent-link: record error (to=${agentId})`, err);
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        log?.(
          "error",
          `agent-link: dispatch error (to=${agentId}, kind=${info.kind})`,
          err,
        );
      },
      replyOptions: { onModelSelected } as never,
    });
  } catch (err) {
    log?.("error", `agent-link: dispatch failed (to=${agentId})`, err);
    throw err;
  }
}

/**
 * Build the version of the message body that the receiving agent sees in its
 * prompt. The raw text is preserved verbatim in `Body` / `RawBody` for system
 * consumers; only `BodyForAgent` is enriched with conversational metadata so
 * the agent can recognise replies and recall what it sent earlier — even when
 * the originating send happened in a different session (e.g. the sender
 * initiated via `agentlink.send` from its Telegram session, and the reply
 * lands in `agent:<sender>:agent-link:direct:<peer>` with no prior history).
 */
function buildBodyForAgent(
  event: AgentLinkInboundEvent,
  bus: AgentLinkBus,
): string {
  const headerParts = [
    `from=${event.from}`,
    `msgId=${event.messageId}`,
  ];
  if (event.replyToId) headerParts.push(`in_reply_to=${event.replyToId}`);
  headerParts.push(`thread=${event.to}↔${event.from}`);
  const header = `[agent-link · ${headerParts.join(" · ")}]`;

  const sections: string[] = [header];

  if (event.replyToId) {
    const original = bus.getCachedMessage(event.replyToId);
    if (original) {
      const elapsed = formatElapsed(event.timestampMs - original.timestampMs);
      const truncated = truncate(original.text, 200);
      const quoted = truncated
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      sections.push(
        `↪ Tu envío anterior (msgId ${original.messageId}, hace ${elapsed}):\n${quoted}`,
      );
    }
  }

  sections.push("");
  sections.push(event.text);
  return sections.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}
