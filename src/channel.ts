import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import { resolveAccount, inspectAccount } from "./config.js";
import { buildSendText } from "./outbound.js";
import { getAgentLinkBus } from "./bus.js";
import { dispatchAgentLinkInbound } from "./runtime-bridge.js";
import { setLiveCfg } from "./runtime-state.js";
import type { ResolvedAgentLinkAccount } from "./types.js";

const CHANNEL_ID = "agent-link";

const channelBase = createChannelPluginBase<ResolvedAgentLinkAccount>({
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Agent Link",
    selectionLabel: "Agent Link (inter-agent direct)",
    detailLabel: "Agent Link",
    docsPath: "/channels/agent-link",
    docsLabel: "agent-link",
    blurb: "Canal directo entre agentes del sistema, sin humano y sin proveedor externo.",
    markdownCapable: true,
  },
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
  config: {
    listAccountIds: (cfg) => {
      const section = (cfg as { channels?: Record<string, unknown> }).channels?.[
        CHANNEL_ID
      ] as { pairs?: Array<{ from: string }> } | undefined;
      const ids = new Set<string>();
      for (const pair of section?.pairs ?? []) ids.add(pair.from);
      return [...ids];
    },
    resolveAccount: (cfg, accountId) =>
      resolveAccount(cfg as never, accountId ?? null),
    inspectAccount: (cfg, accountId) =>
      inspectAccount(cfg as never, accountId ?? null),
  },
});

export const agentLinkPlugin = createChatChannelPlugin<ResolvedAgentLinkAccount>({
  base: {
    ...(channelBase as Record<string, unknown>),
    gateway: {
      startAccount: async (ctx: {
        cfg: unknown;
        accountId: string;
        abortSignal: AbortSignal;
        log?: { info?: (msg: string) => void; error?: (msg: string) => void };
      }) => {
        setLiveCfg(ctx.cfg);
        const bus = getAgentLinkBus();
        const log = (
          level: "info" | "warn" | "error",
          msg: string,
          meta?: unknown,
        ) => {
          if (level === "error") ctx.log?.error?.(`${msg} ${String(meta ?? "")}`);
          else ctx.log?.info?.(msg);
        };

        const unsubscribe = bus.subscribe(ctx.accountId, async (event) => {
          if (ctx.abortSignal.aborted) return;
          try {
            await dispatchAgentLinkInbound({
              event,
              cfg: ctx.cfg,
              bus,
              log,
            });
          } catch (err) {
            log("error", "inbound dispatch failed", err);
          }
        });

        log("info", `agent-link: subscribed (accountId=${ctx.accountId})`);

        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) {
            unsubscribe();
            resolve();
            return;
          }
          ctx.abortSignal.addEventListener(
            "abort",
            () => {
              unsubscribe();
              resolve();
            },
            { once: true },
          );
        });
      },
      stopAccount: async () => {
        // unsubscribe is bound to abortSignal in startAccount
      },
    },
  } as never,

  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowedPeers,
      defaultPolicy: "allowlist",
    },
  },

  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: buildSendText(getAgentLinkBus()) as never,
    },
  },
});
