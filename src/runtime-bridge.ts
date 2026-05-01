import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
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

  const ctxPayload = reply.finalizeInboundContext({
    Body: event.text,
    BodyForAgent: event.text,
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
  const { onModelSelected, ...dispatcherOptions } = replyPipeline as Record<
    string,
    unknown
  > & { onModelSelected?: unknown };

  try {
    await runInboundReplyTurn({
      channel: "agent-link",
      accountId: agentId,
      raw: event,
      adapter: {
        ingest: () => ({
          id: event.messageId,
          rawText: event.text,
          textForAgent: event.text,
          textForCommands: event.text,
          raw: event,
        }),
        resolveTurn: () => ({
          channel: "agent-link",
          accountId: agentId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: conv.recordInboundSession,
          runDispatch: () =>
            (reply.dispatchReplyWithBufferedBlockDispatcher as (
              args: unknown,
            ) => Promise<unknown>)({
              ctx: ctxPayload,
              cfg,
              replyOptions: { onModelSelected },
              dispatcherOptions: {
                ...dispatcherOptions,
                deliver: async (payload: { text?: string }) => {
                  const text = payload.text ?? "";
                  if (!text) return;
                  bus.send({
                    from: agentId,
                    to: peerId,
                    text,
                    replyToId: event.messageId,
                  });
                },
              },
            }),
        }),
      } as never,
    });
  } catch (err) {
    log?.("error", `agent-link: dispatch failed (to=${agentId})`, err);
    throw err;
  }
}
