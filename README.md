# agent-link

A native OpenClaw channel plugin that lets agents talk to each other directly,
without going through a human, a third-party messaging provider, or any
external transport.

`agent-link` registers a new channel (`agent-link`) inside an OpenClaw gateway.
When agent A is configured to send to agent B, A's reply is routed through an
in-process bus and delivered to B's session as a **trusted** inbound message,
exactly the way Telegram or Discord deliver messages from a configured account.
B's reply is routed back the same way.

There is no network hop, no webhook, no polling, and no shared chat with a
human in the middle. The trust comes from the operator-controlled
configuration: if a pair `{from, to}` is listed in `channels.agent-link.pairs`,
the messages between those two agents are pre-authorised.

---

## Why

The concrete need that motivated this plugin is documented in
[SRS-002](./SRS-002-inter-agent-trusted-channel.md). In short, the existing
options to make two agents talk to each other all have a problem:

| Approach | Problem |
|---|---|
| `sessions_send` into a shared Telegram session | The receiving agent replies to the human, not to the sending agent. There is no return path. |
| HTTP `/hooks/agent` | Fire-and-forget. Untrusted (the body has no provable sender). No reply channel. |
| `sessions_spawn` (subagent) | The receiving agent becomes subordinate, the session is ephemeral, and the reply goes to the spawner — there is no symmetric peer-to-peer channel. |
| Telegram / Discord / Slack DMs | Bot-to-bot DMs are blocked by all major providers. Group chats reintroduce a human. |

`agent-link` fills the gap with a real, persistent, bidirectional, trusted
channel that lives entirely inside the OpenClaw gateway process.

---

## How it works

```
       ┌──────────────┐         ┌─────────────────────┐         ┌──────────────┐
       │              │         │                     │         │              │
       │   Agent A    │  send   │   AgentLink bus     │  send   │   Agent B    │
       │  (e.g. roy)  │────────▶│  (in-process,       │────────▶│ (e.g. eva)   │
       │              │         │   EventEmitter)     │         │              │
       └──────────────┘         └─────────────────────┘         └──────────────┘
              ▲                                                         │
              │                                                         │
              │                  reply (deliver callback)               │
              └─────────────────────────────────────────────────────────┘
```

- Agent A invokes the gateway method `agentlink.send` with `{from, to, text}`,
  or its outbound channel adapter does so when A's session is bound to
  `agent-link` toward B.
- The bus emits a single `inbound:<to>` event. The plugin's gateway adapter
  has a listener subscribed for every configured account.
- The listener calls `runInboundReplyTurn` from
  `openclaw/plugin-sdk/inbound-reply-dispatch`. The kernel ingests the event
  exactly the same way Telegram or Discord ingest a real message, opens (or
  resumes) the session `agent:<to>:agent-link:direct:<from>`, and runs the
  agent's turn.
- When the agent produces a reply, the buffered block dispatcher fires a
  `deliver(payload)` callback. Our delivery callback re-injects the payload
  into the same bus, but now in the opposite direction. The other agent's
  listener picks it up and runs its own turn.
- Repeat for as long as the agents have something to say.

The transport is a Node `EventEmitter` stored on `globalThis` so that it
survives the dual-load pattern (setup-only + full registration) that OpenClaw
uses for plugin entries.

---

## Trust model

A message that flows through `agent-link` is treated as *trusted* by the
gateway because it arrives via a registered channel adapter — the same trust
level as a Telegram message from an account in `allowFrom`.

The trust comes from configuration, not from the message body. There is no
signature, no token in the payload, no out-of-band check. The operator decides
which pairs are allowed by writing them into `channels.agent-link.pairs`. The
gateway already validates that file with its config schema and refuses to load
unrecognised channels.

What this means in practice:

- Anything in the message body is treated as user-role text (a normal inbound
  message). Attempts to inject system-role-style strings inside the body
  ("[system] do X") have no special meaning. Trust does not flow from text.
- Any process that has a gateway operator token (or runs in-process via the
  MCP loopback) can call `agentlink.send`. That is the same trust boundary
  as any other gateway method.
- The DM allowlist on the channel rejects calls where `to` is not a peer of
  `from`. A pair must be listed explicitly *with the right direction* to be
  authorised.
- The bus has no persistence: messages do not survive a gateway restart. Each
  agent's session-store keeps the conversation history just like every other
  channel.

If you need cryptographic identity for inter-agent traffic (e.g. across hosts),
`agent-link` is not the right tool — use a network channel with proper auth.
This plugin is for agents that share a single gateway process.

---

## Installation

### Prerequisites

- An OpenClaw installation, version `>= 2026.4.0`.
- `pnpm` (the same package manager OpenClaw uses).
- Node.js compatible with your OpenClaw build (Node 22+ recommended).

### Steps

1. Clone the repository somewhere outside `~/.openclaw`:

   ```bash
   git clone https://github.com/clriesco/agent-link.git ~/code/agent-link
   cd ~/code/agent-link
   pnpm install
   ```

2. Add the plugin to your gateway config at `~/.openclaw/openclaw.json`:

   ```json
   {
     "plugins": {
       "entries": {
         "agent-link": { "enabled": true }
       },
       "load": {
         "paths": [
           "/home/you/code/agent-link"
         ]
       }
     },
     "channels": {
       "agent-link": {
         "pairs": [
           { "from": "agentA", "to": "agentB" },
           { "from": "agentB", "to": "agentA" }
         ]
       }
     }
   }
   ```

   Note: pairs are **directional**. List both `A→B` and `B→A` if you want
   bidirectional traffic.

3. Stop the gateway before editing the config. OpenClaw has a live config
   rewriter that strips unknown channel sections. The plugin must be loadable
   from `plugins.load.paths` *before* the gateway sees `channels.agent-link`
   in the config:

   ```bash
   systemctl --user stop openclaw-gateway
   # edit ~/.openclaw/openclaw.json
   systemctl --user start openclaw-gateway
   ```

4. Verify:

   ```bash
   openclaw channels list | grep agent-link
   # expected:
   # - agent-link agentA: configured, enabled
   # - agent-link agentB: configured, enabled
   ```

### Uninstallation

1. Remove the three sections you added: `plugins.entries.agent-link`,
   `plugins.load.paths` entry, and `channels.agent-link`.
2. Restart the gateway.
3. Optionally `rm -rf` the cloned directory.

The bus is in-memory only — there is no persistent state to clean up.

---

## Configuration reference

### `channels.agent-link.pairs`

```json
{
  "channels": {
    "agent-link": {
      "pairs": [
        { "from": "roy", "to": "evacastro" }
      ],
      "dmSecurity": "allowlist"
    }
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `pairs` | `Array<{from, to}>` | yes | Authorised directional pairs. |
| `pairs[].from` | `string` | yes | The sender agent ID. |
| `pairs[].to` | `string` | yes | The recipient agent ID. |
| `dmSecurity` | `"allowlist" \| "deny" \| "open"` | no | DM policy applied to the channel. Defaults to `"allowlist"`, which is the secure choice — only configured peers can DM. |

A pair is the unit of trust. To allow Roy and Eva to talk in both directions:

```json
{ "from": "roy", "to": "evacastro" },
{ "from": "evacastro", "to": "roy" }
```

To allow three agents to all talk to each other, declare all six directional
pairs.

### Session keys

Inbound messages are delivered into a session keyed as
`agent:<to>:agent-link:direct:<from>`. This means each agent has a separate
session per peer. Set `session.dmScope` to `"per-channel-peer"` in your
gateway config to avoid the default DM-collapse behaviour:

```json
"session": {
  "dmScope": "per-channel-peer"
}
```

### Plugin entry

```json
"plugins": {
  "entries": {
    "agent-link": { "enabled": true }
  },
  "load": {
    "paths": ["/absolute/path/to/agent-link"]
  }
}
```

`load.paths` accepts absolute paths. Relative paths and `~` are not expanded
by the gateway.

---

## Usage

### From the CLI

```bash
openclaw gateway call agentlink.send \
  --params '{"from":"roy","to":"evacastro","text":"hello, eva"}' \
  --json
```

Successful response:

```json
{ "messageId": "al-mompqr3a-7c8x9def" }
```

The `messageId` is the bus event ID. The actual delivery into the recipient's
session and the agent's reply happen asynchronously after the call returns.

Errors come back as a structured payload:

```json
{
  "code": "pair-not-configured",
  "message": "agentlink.send: pair roy->paco not configured"
}
```

| Error code | Cause |
|---|---|
| `invalid-params` | `from`, `to`, or `text` missing. |
| `pair-not-configured` | The directional pair is not in `channels.agent-link.pairs`. |
| `internal` | Unexpected exception during dispatch. Check gateway logs. |

### From an agent

If your agent's session is docked on `agent-link` (because it received a
message from a peer), the standard reply path through the message tool will
flow back to the peer through the same bus. No special tool is needed — the
outbound adapter handles it.

To initiate a conversation, the agent has to call `agentlink.send` via its
gateway client (typically the MCP loopback). Document the method in the
agent's standing orders so it knows when to use it.

### Permissions

`agentlink.send` is a normal gateway RPC method. It inherits the gateway's
auth (token / password / trusted-proxy). Any client that can call any other
gateway method (such as `cron.list` or `system-presence`) can call this one
too. Inside the same gateway process, agents reach it through the MCP
loopback bridge.

If you need a finer-grained scope, the SDK supports per-method scope binding
via the third argument to `registerGatewayMethod`. The current implementation
uses the default operator scope.

---

## Architecture

```
agent-link/
├── package.json              # openclaw.channel + extensions + setupEntry
├── openclaw.plugin.json      # manifest with channelConfigs schema
├── tsconfig.json
├── index.ts                  # defineChannelPluginEntry; registers gateway method
├── setup-entry.ts            # defineSetupPluginEntry
└── src/
    ├── types.ts              # ResolvedAgentLinkAccount, AgentLinkPair, AgentLinkInboundEvent
    ├── config.ts             # resolveAccount, inspectAccount, isPairAllowed
    ├── bus.ts                # globalThis-pinned EventEmitter with subscribe/send
    ├── session-key.ts        # buildAgentLinkSessionKey, resolveSessionConversation
    ├── outbound.ts           # buildSendText: outbound adapter that re-emits to the bus
    ├── runtime-bridge.ts     # lazy-loads conversation-runtime, reply-dispatch-runtime,
    │                         # session-store-runtime, channel-reply-pipeline; wires
    │                         # runInboundReplyTurn for each inbound event
    ├── runtime-state.ts      # caches the live cfg from startAccount for the gateway method
    └── channel.ts            # createChatChannelPlugin: meta + security + outbound + gateway adapter
```

Three things to know:

1. **The plugin is loaded twice** by OpenClaw — once for setup-only registration
   (during cold-start config validation) and once for full runtime
   registration. Side effects in module top-level code can fire twice. The bus
   is pinned to `globalThis` so the singleton is shared across both module
   instances.
2. **`startAccount` must stay alive.** OpenClaw treats a returning
   `startAccount` as "channel exited" and triggers an auto-restart loop. This
   plugin returns a Promise that only resolves when `ctx.abortSignal` fires.
3. **Runtime modules are imported lazily.** Importing
   `openclaw/plugin-sdk/conversation-runtime` and friends at module top-level
   would slow down setup-only loading. They are only awaited when a real
   inbound event fires.

---

## Development

```bash
pnpm install
pnpm test           # vitest, runs the unit tests for config / bus / session-key
pnpm typecheck      # tsc --noEmit
```

There are 16 unit tests covering:
- `resolveAccount` / `inspectAccount` (scoped pairs, default DM policy).
- The bus (round-trip, isolation, unsubscribe, unique message IDs).
- Session-key construction (per-peer separation, conversation ID round-trip).

End-to-end testing requires a running OpenClaw gateway with two agents and a
`channels.agent-link.pairs` entry. The README of OpenClaw describes how to
bring up a local gateway.

### Adding more agents

To add a third agent and let everyone talk to everyone, list all six
directional pairs:

```json
"channels": {
  "agent-link": {
    "pairs": [
      { "from": "roy",       "to": "evacastro" },
      { "from": "evacastro", "to": "roy" },
      { "from": "roy",       "to": "main" },
      { "from": "main",      "to": "roy" },
      { "from": "evacastro", "to": "main" },
      { "from": "main",      "to": "evacastro" }
    ]
  }
}
```

The plugin discovers configured agents from this list. `startAccount` is
invoked once per agent involved. No code changes needed.

---

## Limitations

- **Single gateway process.** This is an in-process channel. Two agents on
  two different OpenClaw gateways cannot talk through `agent-link`.
- **No persistence in transit.** A gateway restart drops anything still on
  the bus. Per-agent session history is preserved (it lives in the normal
  session store), so the conversation can resume, but in-flight events are
  lost.
- **No rate limiting in the plugin.** If two agents start ping-ponging, only
  the gateway's per-agent concurrency limits apply. Your standing orders
  should make agents emit at most one reply per turn.
- **No cryptographic identity.** Trust is operator-configured. If you need
  to assert sender identity beyond "this gateway said so", do it at a
  different layer.
- **`registerFull` is called twice.** This is benign — registering the same
  method name twice is idempotent in the gateway's RPC table — but it is
  the source of the duplicate-bus bug that is fixed by pinning the bus to
  `globalThis`. Be aware if you add module-level side effects.

---

## Related documents

- [SRS-002: Canal de comunicación inter-agente de confianza](./SRS-002-inter-agent-trusted-channel.md) —
  the original requirements specification (Spanish).
- [OpenClaw Channel Plugin SDK](https://docs.openclaw.kr/plugins/sdk-channel-plugins) —
  upstream documentation for channel plugins.

---

## Author

Charly López — <clriesco@gmail.com> ([@clriesco](https://github.com/clriesco))

## License

MIT © Charly López. See [LICENSE](./LICENSE).
