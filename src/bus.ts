import { EventEmitter } from "node:events";
import type {
  AgentId,
  AgentLinkInboundEvent,
  AgentLinkSendParams,
} from "./types.js";

export type InboundListener = (
  event: AgentLinkInboundEvent,
) => void | Promise<void>;

export interface CachedAgentLinkMessage {
  from: AgentId;
  to: AgentId;
  text: string;
  messageId: string;
  timestampMs: number;
}

const DEFAULT_MAX_CACHE_ENTRIES = 200;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

function inboundEventName(agentId: AgentId): string {
  return `inbound:${agentId}`;
}

function generateMessageId(): string {
  return `al-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Coerce a `text` payload to a string regardless of what the caller passed.
 * Strings pass through. Objects/arrays/numbers/booleans get JSON-serialised.
 * Null/undefined become "". This prevents the receiver from seeing
 * "[object Object]" when a caller forgot to stringify before sending.
 */
function coerceToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface AgentLinkBusOptions {
  maxCacheEntries?: number;
  cacheTtlMs?: number;
}

export class AgentLinkBus {
  private readonly emitter = new EventEmitter();
  private readonly cache = new Map<string, CachedAgentLinkMessage>();
  private readonly maxCacheEntries: number;
  private readonly cacheTtlMs: number;

  constructor(opts?: AgentLinkBusOptions) {
    this.emitter.setMaxListeners(64);
    this.maxCacheEntries = opts?.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
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
      text: coerceToString(params.text),
      replyToId: params.replyToId,
      messageId: generateMessageId(),
      timestampMs: Date.now(),
    };
    this.recordInCache(event);
    this.emitter.emit(inboundEventName(params.to), event);
    return event;
  }

  /**
   * Look up a previously sent message by id. Returns undefined if not in cache,
   * expired, or evicted. Used by the inbound dispatcher to inject the original
   * outbound text as context when delivering a reply (so the receiving agent
   * has the conversational thread visible without relying on transcript
   * history that lives in a different session than where the send happened).
   */
  getCachedMessage(messageId: string): CachedAgentLinkMessage | undefined {
    this.evictExpired();
    return this.cache.get(messageId);
  }

  listenerCount(agentId: AgentId): number {
    return this.emitter.listenerCount(inboundEventName(agentId));
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
    this.cache.clear();
  }

  private recordInCache(event: AgentLinkInboundEvent): void {
    this.evictExpired();
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(event.messageId, {
      from: event.from,
      to: event.to,
      text: event.text,
      messageId: event.messageId,
      timestampMs: event.timestampMs,
    });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, msg] of this.cache) {
      if (now - msg.timestampMs > this.cacheTtlMs) {
        this.cache.delete(id);
      } else {
        // Map iteration is in insertion order; once we hit a non-expired
        // entry the rest are also non-expired.
        return;
      }
    }
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
