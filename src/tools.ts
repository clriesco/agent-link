import { Type } from "typebox";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { getAgentLinkBus } from "./bus.js";
import { resolveAccount } from "./config.js";

const SendToolSchema = Type.Object(
  {
    from: Type.String({
      description:
        "Sender agent id. Must match the calling agent's own identity. Pairs are validated against channels.agent-link.pairs.",
    }),
    to: Type.String({
      description:
        "Recipient agent id (e.g. 'roy', 'evacastro', 'main'). Must be a configured peer of the sender.",
    }),
    text: Type.String({
      description: "Message body in natural language.",
    }),
    replyToId: Type.Optional(
      Type.String({
        description:
          "Optional id of the prior agent-link message you are replying to.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createAgentLinkSendTool(getCfg: () => unknown) {
  return {
    name: "agentlink_send",
    label: "Agent Link · send",
    description:
      "Send a trusted message to another agent through the agent-link channel. " +
      "The pair {from -> to} must be declared in channels.agent-link.pairs. " +
      "Delivery is asynchronous; the recipient will reply through the same channel.",
    parameters: SendToolSchema,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const p = (rawParams ?? {}) as {
        from?: string;
        to?: string;
        text?: string;
        replyToId?: string;
      };
      const from = (p.from ?? "").trim();
      const to = (p.to ?? "").trim();
      const text = p.text ?? "";
      if (!from || !to || !text) {
        return jsonResult({
          ok: false,
          error: "agentlink_send: 'from', 'to' and 'text' are required",
        });
      }
      const cfg = getCfg();
      if (cfg) {
        const account = resolveAccount(cfg as never, from);
        if (!account.allowedPeers.includes(to)) {
          return jsonResult({
            ok: false,
            error: `agentlink_send: pair ${from}->${to} not configured in channels.agent-link.pairs`,
          });
        }
      }
      const event = getAgentLinkBus().send({
        from,
        to,
        text,
        replyToId: p.replyToId,
      });
      return jsonResult({
        ok: true,
        messageId: event.messageId,
        from,
        to,
        note: "Delivery is asynchronous; the recipient will reply via the same channel.",
      });
    },
  };
}
