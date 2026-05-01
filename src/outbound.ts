import type { AgentLinkBus } from "./bus.js";
import type { AgentId } from "./types.js";

interface SendTextParams {
  to: string | number;
  text: string;
  accountId?: string;
  replyToId?: string;
}

interface SendTextResult {
  channel: string;
  messageId: string;
}

export function buildSendText(bus: AgentLinkBus) {
  return async (params: SendTextParams): Promise<SendTextResult> => {
    const fromAgent = (params.accountId ?? "") as AgentId;
    const toAgent = String(params.to) as AgentId;

    if (!fromAgent) {
      throw new Error("agent-link outbound: missing accountId (sender)");
    }

    const event = bus.send({
      from: fromAgent,
      to: toAgent,
      text: params.text,
      replyToId: params.replyToId,
    });

    return { channel: "agent-link", messageId: event.messageId };
  };
}
