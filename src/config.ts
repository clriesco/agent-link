import type {
  AgentId,
  AgentLinkChannelSection,
  AgentLinkPair,
  ResolvedAgentLinkAccount,
} from "./types.js";

interface OpenClawConfigShape {
  channels?: Record<string, unknown>;
}

function readSection(cfg: OpenClawConfigShape): AgentLinkChannelSection {
  const raw = cfg.channels?.["agent-link"];
  return (raw ?? {}) as AgentLinkChannelSection;
}

function pairsForAccount(
  pairs: AgentLinkPair[],
  accountId: AgentId | null,
): AgentLinkPair[] {
  if (!accountId) return pairs;
  return pairs.filter((p) => p.from === accountId || p.to === accountId);
}

function peersForAccount(
  pairs: AgentLinkPair[],
  accountId: AgentId | null,
): AgentId[] {
  if (!accountId) return [];
  const peers = new Set<AgentId>();
  for (const pair of pairs) {
    if (pair.from === accountId) peers.add(pair.to);
    if (pair.to === accountId) peers.add(pair.from);
  }
  return [...peers];
}

export function resolveAccount(
  cfg: OpenClawConfigShape,
  accountId?: AgentId | null,
): ResolvedAgentLinkAccount {
  const section = readSection(cfg);
  const pairs = section.pairs ?? [];
  const id = accountId ?? null;
  return {
    accountId: id,
    pairs: pairsForAccount(pairs, id),
    allowedPeers: peersForAccount(pairs, id),
    dmPolicy: section.dmSecurity ?? "allowlist",
  };
}

export function inspectAccount(
  cfg: OpenClawConfigShape,
  accountId?: AgentId | null,
): {
  enabled: boolean;
  configured: boolean;
  pairsCount: number;
} {
  const section = readSection(cfg);
  const pairs = section.pairs ?? [];
  const scoped = pairsForAccount(pairs, accountId ?? null);
  return {
    enabled: pairs.length > 0,
    configured: pairs.length > 0,
    pairsCount: scoped.length,
  };
}

export function isPairAllowed(
  pairs: AgentLinkPair[],
  from: AgentId,
  to: AgentId,
): boolean {
  return pairs.some((p) => p.from === from && p.to === to);
}
