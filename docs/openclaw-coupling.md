# OpenClaw coupling

`agent-link` is a third-party channel plugin for OpenClaw. It runs inside the
OpenClaw gateway process and consumes parts of OpenClaw's public plugin SDK.
This document records every place where the plugin's behaviour depends on
OpenClaw's surface, what guarantees we rely on, and what is pending an
upstream change.

Treat this as the operational map between the two repositories. If you upgrade
OpenClaw and something breaks here, this is the first file to read.

---

## OpenClaw APIs we already consume

All of these are imported from public `openclaw/plugin-sdk/...` subpaths in the
package's `exports` map. They are stable consumer surface; if upstream ever
removes or renames them, the plugin will fail at gateway boot.

| Symbol | Subpath | Used in | Purpose |
|---|---|---|---|
| `defineChannelPluginEntry` | `plugin-sdk/channel-core` | `index.ts` | Register the plugin entry. |
| `createChatChannelPlugin`, `createChannelPluginBase` | `plugin-sdk/channel-core` | `src/channel.ts` | Build the channel runtime descriptor. |
| `recordInboundSession` | `plugin-sdk/conversation-runtime` | `src/runtime-bridge.ts` | Persist a peer's inbound message into the receiving agent's session transcript. |
| `dispatchInboundReplyWithBase`, `finalizeInboundContext` | `plugin-sdk/inbound-reply-dispatch`, `plugin-sdk/reply-dispatch-runtime` | `src/runtime-bridge.ts` | Drive the Claude turn that replies to a received agent-link message. |
| `resolveStorePath` | `plugin-sdk/session-store-runtime` | `src/runtime-bridge.ts` | Resolve the on-disk path of an agent's session-store. |
| `createChannelReplyPipeline` | `plugin-sdk/channel-reply-pipeline` | `src/runtime-bridge.ts` | Resolve the reply pipeline (model selection, etc.) for the receiving agent. |

The `peerDependencies` range in `package.json` is intentionally open
(`openclaw: ">=2026.4.0"`). We track upstream releases by hand. A breaking
change in any of the symbols above is the most likely reason a previously
working `agent-link` would fail after a `brew upgrade openclaw`. If that
happens, the corresponding `import` statement is the place to start looking.

---

## Pending upstream change: `plugin-sdk/transcript.runtime`

### What

`appendAssistantMessageToSessionTranscript` (and its sibling
`appendExactAssistantMessageToSessionTranscript`) already exist inside
OpenClaw at `src/config/sessions/transcript.runtime.ts`, but the
`plugin-sdk/transcript.runtime` subpath is **not** in OpenClaw's public
`exports` map yet. There is no public way to append an assistant turn to a
session transcript without reaching into internal paths.

Our pending PR adds that subpath:

- Upstream PR: <https://github.com/openclaw/openclaw/pull/80208>
- Changes: 1 new file (`src/plugin-sdk/transcript.runtime.ts`) + 1 entry in
  `scripts/lib/plugin-sdk-entrypoints.json` + auto-synced lines in
  `package.json` `exports`. No new behavior; pure exposure.

### Why we want it

When agent A sends a first message to agent B via `agentlink.send` (typically
from A's Telegram session, by an agent's `Bash` tool call), the outbound is
recorded only in the in-memory bus cache (see `src/bus.ts`). A's own session
for the agent-link conversation (`agent:<A>:agent-link:direct:<B>`) stays
empty until B replies. That is fine for reasoning — the inbound from B carries
an `↪ Tu envío anterior` block reconstructing A's prior outbound from the bus
cache — but A's transcript on disk has no record of the outbound turn. If you
look at `~/.openclaw/agents/<A>/sessions/<...>.jsonl`, you see only B's
inbound and A's reply.

With the public export merged, `agentlink.send` can additionally call
`appendAssistantMessageToSessionTranscript` so A's transcript reflects the
outbound at send time — useful for UI, logs, audit, and as a safety net when
the bus cache is unavailable (gateway restarts mid-flight, TTL expires past
24 h, message evicted under load).

### How the plugin handles "merged" vs "not merged"

The integration is opt-in by feature detection. See
`src/runtime-bridge.ts → loadTranscriptRuntime` and
`persistOutboundToSenderTranscript`.

```ts
// runtime-bridge.ts (paraphrased)
const modulePath = "openclaw/plugin-sdk/transcript.runtime";
const mod = (await import(modulePath)) as Partial<TranscriptRuntime>;
if (typeof mod.appendAssistantMessageToSessionTranscript === "function") {
  transcriptRuntime = mod as TranscriptRuntime;
} else {
  transcriptRuntime = null;
}
```

The dynamic specifier is a string variable (not a literal) so TypeScript does
not try to resolve it at compile time. That keeps the plugin compilable and
runnable on OpenClaw versions that pre-date the upstream merge.

| OpenClaw state | `loadTranscriptRuntime` returns | Effect on `agentlink.send` |
|---|---|---|
| Subpath not exported (current published versions) | `null` (cached after first attempt) | Helper silently no-ops. Plan A (bus cache + `↪` block) carries the load. |
| Subpath exported (post-merge release) | The runtime module | Helper appends an assistant turn to A's session transcript on every send. Plan A still active; persistence becomes a complementary safety net. |
| Subpath exported but signature changed | Either resolves and throws at call time, or fails the `typeof === "function"` guard | Wrapped in `try/catch`. Logs a `warn` and continues. The send is **never** blocked by transcript persistence failures. |

### What to do when upstream merges

Once the PR is in a published release of `openclaw`:

1. `brew upgrade openclaw` (or whatever channel you install from).
2. `systemctl --user restart openclaw-gateway.service` so the new binary's
   `plugin-sdk/transcript.runtime` is visible to the plugin loader.
3. (Optional verification) trigger a smoke `agentlink.send` and check that
   the sender's `agent:<sender>:agent-link:direct:<peer>.jsonl` now contains
   an `assistant` message with the outbound text **before** the inbound
   `user` turn arrives. Without the merge that file would only contain the
   inbound and the agent's reply.

No changes to this repository are required. The dynamic import flips from
`null` to the runtime module on its first call after the gateway restart.

### What to do if the upstream API changes shape

Two realistic drift scenarios after the PR lands:

1. **Function renamed.** Update the symbol name and the
   `TranscriptRuntime` interface in `src/runtime-bridge.ts`. The dynamic
   import path may also need to change if upstream renames the subpath.
2. **Parameters changed.** Adjust the call site in
   `persistOutboundToSenderTranscript` to match the new signature. Update
   the `TranscriptRuntime` interface. Tests do not currently exercise this
   path (it is a fire-and-forget side effect with no observable return),
   so detection requires either a manual smoke test or watching gateway
   logs for the `agent-link: outbound transcript persist skipped` warn line.

In either case, the plugin keeps working on the previous OpenClaw release
because the dynamic import is wrapped in `try/catch` and degrades gracefully.

### What to do if the upstream PR is rejected or stalls indefinitely

This block is the only piece of the plugin that depends on a non-merged
upstream change. If it becomes clear the PR will not be accepted in any
form, the options are:

1. **Drop the helper.** Remove `loadTranscriptRuntime` /
   `persistOutboundToSenderTranscript` from `src/runtime-bridge.ts` and
   the call site in `index.ts`. The plugin still works; agents reason
   correctly via the cache-based `↪` block (Plan A). The only loss is the
   nicety of seeing the sender's outbound in its own transcript file.
2. **Inline the logic.** Reach into OpenClaw's internal source path
   (`openclaw/dist/plugin-sdk/src/config/sessions/transcript.runtime.js`)
   or replicate the helper inside this plugin. **Not recommended** — the
   helper coordinates write locks and parent-id chains with the OpenClaw
   runtime, and replicating it without that coordination risks corrupting
   transcripts under concurrency.

Option 1 is the lower-risk default if the PR is closed.

---

## Bus cache persistence (Plan A hardening)

Independent of the upstream PR, the bus cache that backs the `↪ Tu envío
anterior` block is now persisted to disk. Defaults:

| Field | Value | Where |
|---|---|---|
| Cache file path | `~/.openclaw/state/agent-link/cache.json` | `DEFAULT_CACHE_FILE_PATH` in `src/bus.ts` |
| TTL | 24 hours | `DEFAULT_CACHE_TTL_MS` in `src/bus.ts` |
| Capacity | 1000 entries | `DEFAULT_MAX_CACHE_ENTRIES` in `src/bus.ts` |
| Truncate length of quoted prior outbound | 2000 chars | inline constant in `src/runtime-bridge.ts:buildBodyForAgent` |

Override the cache file path with the `AGENTLINK_CACHE_FILE` env var (the
gateway reads `.env` on startup). Pass `cacheFilePath: null` to the bus
constructor in tests to disable persistence entirely.

### Operational notes

- **Do not delete the cache file while conversations are in flight.** A
  reply that arrives after the cache file is wiped will not be able to
  reconstruct the `↪ Tu envío anterior` block, and the receiving agent may
  fall back to the "I didn't send that" failure mode that the cache exists
  to prevent.
- **A clean restart preserves the cache.** Restarting the gateway no longer
  loses the bus, because the singleton is rehydrated from the JSON snapshot
  on construction. Corrupted JSON (manual edit gone wrong, partial write
  during a crash) is silently ignored — the bus starts empty rather than
  throwing.
- **The cache is not a transcript.** It is a short-lived lookup keyed by
  `messageId`. If you want a persistent record of inter-agent messages, use
  the session transcript files in `~/.openclaw/agents/<id>/sessions/`.
