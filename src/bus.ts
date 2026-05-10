import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

const DEFAULT_MAX_CACHE_ENTRIES = 1000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_CACHE_FILE_PATH = join(
  homedir(),
  ".openclaw",
  "state",
  "agent-link",
  "cache.json",
);

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
  /**
   * Path to a JSON file used to persist the cache across process restarts.
   * `null` (the default for direct construction) disables persistence —
   * tests construct buses without writing to disk. The singleton accessor
   * `getAgentLinkBus()` injects a real path so production runs persist.
   */
  cacheFilePath?: string | null;
}

interface PersistedCacheV1 {
  version: 1;
  entries: CachedAgentLinkMessage[];
}

export class AgentLinkBus {
  private readonly emitter = new EventEmitter();
  private readonly cache = new Map<string, CachedAgentLinkMessage>();
  private readonly maxCacheEntries: number;
  private readonly cacheTtlMs: number;
  private readonly cacheFilePath: string | null;
  /** Serialised tail of pending disk writes; new flushes chain off this. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts?: AgentLinkBusOptions) {
    this.emitter.setMaxListeners(64);
    this.maxCacheEntries = opts?.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheFilePath = opts?.cacheFilePath ?? null;
    this.loadFromDisk();
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
    this.scheduleFlush();
  }

  /** Await any queued disk writes. Used by tests. */
  async drainPendingWrites(): Promise<void> {
    await this.writeChain;
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
    this.scheduleFlush();
  }

  private evictExpired(): void {
    const now = Date.now();
    let mutated = false;
    for (const [id, msg] of this.cache) {
      if (now - msg.timestampMs > this.cacheTtlMs) {
        this.cache.delete(id);
        mutated = true;
      } else {
        // Map iteration is in insertion order; once we hit a non-expired
        // entry the rest are also non-expired.
        break;
      }
    }
    if (mutated) this.scheduleFlush();
  }

  private loadFromDisk(): void {
    if (!this.cacheFilePath) return;
    if (!existsSync(this.cacheFilePath)) return;
    try {
      const raw = readFileSync(this.cacheFilePath, "utf-8");
      const data = JSON.parse(raw) as Partial<PersistedCacheV1> | undefined;
      const entries = Array.isArray(data?.entries) ? data!.entries : [];
      const now = Date.now();
      for (const e of entries) {
        if (
          e &&
          typeof e === "object" &&
          typeof e.messageId === "string" &&
          typeof e.from === "string" &&
          typeof e.to === "string" &&
          typeof e.text === "string" &&
          typeof e.timestampMs === "number" &&
          now - e.timestampMs <= this.cacheTtlMs
        ) {
          this.cache.set(e.messageId, e);
        }
      }
    } catch {
      // Corrupted or unreadable: start with an empty cache.
    }
  }

  private scheduleFlush(): void {
    if (!this.cacheFilePath) return;
    const snapshot = Array.from(this.cache.values());
    const path = this.cacheFilePath;
    const writer = () => this.flushSnapshotToDisk(snapshot, path);
    this.writeChain = this.writeChain.then(writer, writer);
  }

  private async flushSnapshotToDisk(
    entries: CachedAgentLinkMessage[],
    path: string,
  ): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const payload: PersistedCacheV1 = { version: 1, entries };
      await writeFile(tmp, JSON.stringify(payload), "utf-8");
      await rename(tmp, path);
    } catch {
      // Disk write failures must not crash the bus; the in-memory cache still
      // serves the same process. Worst case: a restart loses recent entries.
    }
  }
}

const SINGLETON_KEY = "__agentLinkBusSingleton__";

interface SingletonHolder {
  [SINGLETON_KEY]?: AgentLinkBus;
}

export function getAgentLinkBus(): AgentLinkBus {
  const g = globalThis as SingletonHolder;
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = new AgentLinkBus({
      cacheFilePath:
        process.env.AGENTLINK_CACHE_FILE ?? DEFAULT_CACHE_FILE_PATH,
    });
  }
  return g[SINGLETON_KEY]!;
}

export function resetAgentLinkBusForTests(): void {
  const g = globalThis as SingletonHolder;
  g[SINGLETON_KEY]?.removeAll();
  delete g[SINGLETON_KEY];
}
