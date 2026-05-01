import { EventEmitter } from "node:events";
import type {
  AgentId,
  AgentLinkInboundEvent,
  AgentLinkSendParams,
} from "./types.js";

export type InboundListener = (event: AgentLinkInboundEvent) => void | Promise<void>;

function inboundEventName(agentId: AgentId): string {
  return `inbound:${agentId}`;
}

function generateMessageId(): string {
  return `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class AgentLinkBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(64);
  }

  subscribe(agentId: AgentId, listener: InboundListener): () => void {
    const wrapped = (event: AgentLinkInboundEvent) => {
      void listener(event);
    };
    this.emitter.on(inboundEventName(agentId), wrapped);
    return () => this.emitter.off(inboundEventName(agentId), wrapped);
  }

  send(params: AgentLinkSendParams): AgentLinkInboundEvent {
    const event: AgentLinkInboundEvent = {
      from: params.from,
      to: params.to,
      text: params.text,
      replyToId: params.replyToId,
      messageId: generateMessageId(),
      timestampMs: Date.now(),
    };
    this.emitter.emit(inboundEventName(params.to), event);
    return event;
  }

  listenerCount(agentId: AgentId): number {
    return this.emitter.listenerCount(inboundEventName(agentId));
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}

const SINGLETON_KEY = "__agentLinkBusSingleton__";

interface SingletonHolder {
  [SINGLETON_KEY]?: AgentLinkBus;
}

export function getAgentLinkBus(): AgentLinkBus {
  const g = globalThis as SingletonHolder;
  if (!g[SINGLETON_KEY]) g[SINGLETON_KEY] = new AgentLinkBus();
  return g[SINGLETON_KEY]!;
}

export function resetAgentLinkBusForTests(): void {
  const g = globalThis as SingletonHolder;
  g[SINGLETON_KEY]?.removeAll();
  delete g[SINGLETON_KEY];
}
