export type AgentId = string;

export interface AgentLinkPair {
  from: AgentId;
  to: AgentId;
}

export interface AgentLinkChannelSection {
  pairs?: AgentLinkPair[];
  dmSecurity?: "allowlist" | "deny" | "open";
}

export interface ResolvedAgentLinkAccount {
  accountId: AgentId | null;
  pairs: AgentLinkPair[];
  allowedPeers: AgentId[];
  dmPolicy: "allowlist" | "deny" | "open";
}

export interface AgentLinkInboundEvent {
  from: AgentId;
  to: AgentId;
  text: string;
  replyToId?: string;
  messageId: string;
  timestampMs: number;
}

export interface AgentLinkSendParams {
  from: AgentId;
  to: AgentId;
  text: string;
  replyToId?: string;
}
