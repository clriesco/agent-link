import type { AgentId } from "./types.js";

const CHANNEL_ID = "agent-link";

export function buildAgentLinkSessionKey(
  agentId: AgentId,
  peerId: AgentId,
): string {
  return `agent:${agentId}:${CHANNEL_ID}:direct:${peerId}`;
}

export function buildConversationId(
  agentId: AgentId,
  peerId: AgentId,
): string {
  return `${agentId}::${peerId}`;
}

export function parseConversationId(
  raw: string,
): { agentId: AgentId; peerId: AgentId } | null {
  const idx = raw.indexOf("::");
  if (idx < 0) return null;
  const agentId = raw.slice(0, idx);
  const peerId = raw.slice(idx + 2);
  if (!agentId || !peerId) return null;
  return { agentId, peerId };
}

export function resolveSessionConversation(rawId: string): {
  baseConversationId: string;
  parentConversationCandidates?: string[];
} {
  return { baseConversationId: rawId };
}
