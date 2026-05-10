import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentLinkPlugin } from "./src/channel.js";
import { getAgentLinkBus } from "./src/bus.js";
import { resolveAccount } from "./src/config.js";
import { persistOutboundToSenderTranscript } from "./src/runtime-bridge.js";
import { getLiveCfg } from "./src/runtime-state.js";

export default defineChannelPluginEntry({
  id: "agent-link",
  name: "Agent Link",
  description: "Canal de comunicación inter-agente de confianza.",
  plugin: agentLinkPlugin,
  registerFull(api) {
    const bus = getAgentLinkBus();

    api.registerGatewayMethod?.(
      "agentlink.send",
      async (opts) => {
        const o = opts as unknown as {
          params: Record<string, unknown>;
          respond: (
            ok: boolean,
            payload?: unknown,
            error?: { code?: string; message?: string },
          ) => void;
          context?: { getRuntimeConfig?: () => unknown };
        };
        try {
          const p = o.params ?? {};
          const from = p.from as string;
          const to = p.to as string;
          const text = p.text as string;
          const replyToId = p.replyToId as string | undefined;
          if (!from || !to || !text) {
            o.respond(false, undefined, {
              code: "invalid-params",
              message: "agentlink.send: from, to, text are required",
            });
            return;
          }
          const cfg = o.context?.getRuntimeConfig?.() ?? getLiveCfg();
          if (cfg) {
            const account = resolveAccount(cfg as never, from);
            if (!account.allowedPeers.includes(to)) {
              o.respond(false, undefined, {
                code: "pair-not-configured",
                message: `agentlink.send: pair ${from}->${to} not configured`,
              });
              return;
            }
          }
          const event = bus.send({ from, to, text, replyToId });
          o.respond(true, { messageId: event.messageId });

          // Best-effort: persist sender's outbound to its own session
          // transcript so it isn't blind to its own message when later
          // activated by the reply. Fire-and-forget; errors are swallowed
          // inside the helper. Only effective once openclaw exposes
          // `openclaw/plugin-sdk/transcript.runtime` (no-op until then).
          void persistOutboundToSenderTranscript({
            cfg: cfg ?? null,
            from,
            to,
            text,
            messageId: event.messageId,
          });
        } catch (err) {
          o.respond(false, undefined, {
            code: "internal",
            message: String(err),
          });
        }
      },
    );
  },
});
