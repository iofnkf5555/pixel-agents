import { useCallback, useEffect, useState } from 'react';

import { serverToken } from '../transport/serverToken.js';
import type { AgentTeamState } from './useExtensionMessages.js';

export type ChatDeliveryMode =
  'codex-queue' | 'codex-exec' | 'agy-print' | 'claude-pty' | 'claude-resume' | 'unsupported';

export interface ChatTargetInfo {
  agentId: number;
  canChat: boolean;
  reason?: 'subagent' | 'cli_missing';
  providerId: string;
  mode: ChatDeliveryMode;
}

function chatTargetsUrl(): string {
  return serverToken
    ? `/api/chat/targets?token=${encodeURIComponent(serverToken)}`
    : '/api/chat/targets';
}

interface UseChatTargetsInput {
  agents: readonly number[];
  agentTeams: Record<number, AgentTeamState>;
  officeReadOnly: boolean;
}

export interface ChatTargetsController {
  chatTargets: Record<number, ChatTargetInfo>;
  canChatAgent: (id: number) => boolean;
  refreshTargets: () => Promise<void>;
}

export function useChatTargets({
  agents,
  agentTeams,
  officeReadOnly,
}: UseChatTargetsInput): ChatTargetsController {
  const [chatTargets, setChatTargets] = useState<Record<number, ChatTargetInfo>>({});

  const refreshTargets = useCallback(async () => {
    if (officeReadOnly) {
      setChatTargets({});
      return;
    }
    try {
      const res = await fetch(chatTargetsUrl());
      if (!res.ok) return;
      const data = (await res.json()) as { targets?: Record<string, ChatTargetInfo> };
      if (!data.targets || typeof data.targets !== 'object') return;
      const parsed: Record<number, ChatTargetInfo> = {};
      for (const [k, v] of Object.entries(data.targets)) {
        const num = Number(k);
        if (Number.isInteger(num) && v) {
          parsed[num] = v;
        }
      }
      setChatTargets(parsed);
    } catch {
      /* ignore transient fetch failure */
    }
  }, [officeReadOnly]);

  const agentsKey = agents.join(',');
  const teamsKey = Object.entries(agentTeams)
    .map(
      ([id, t]) =>
        `${id}:${t.leadAgentId ?? ''}:${t.isTeamLead ? '1' : '0'}:${t.isReviewer ? '1' : '0'}`,
    )
    .join(',');

  useEffect(() => {
    if (officeReadOnly) {
      setChatTargets({});
      return;
    }
    let cancelled = false;
    void fetch(chatTargetsUrl())
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { targets?: Record<string, ChatTargetInfo> };
        if (cancelled || !data.targets || typeof data.targets !== 'object') return;
        const parsed: Record<number, ChatTargetInfo> = {};
        for (const [k, v] of Object.entries(data.targets)) {
          const num = Number(k);
          if (Number.isInteger(num) && v) {
            parsed[num] = v;
          }
        }
        setChatTargets(parsed);
      })
      .catch(() => {
        /* ignore transient fetch failure */
      });
    return () => {
      cancelled = true;
    };
  }, [officeReadOnly, agentsKey, teamsKey]);

  const canChatAgent = useCallback(
    (id: number): boolean => {
      if (officeReadOnly || id <= 0) return false;
      if (agentTeams[id]?.leadAgentId !== undefined || agentTeams[id]?.isReviewer) return false;
      return chatTargets[id]?.canChat === true;
    },
    [officeReadOnly, agentTeams, chatTargets],
  );

  return { chatTargets, canChatAgent, refreshTargets };
}
