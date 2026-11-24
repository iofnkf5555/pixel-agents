import { useCallback, useEffect, useMemo } from 'react';

import type { TabStatus } from './AgentCard.js';
import { getProviderBadge, pickNextTarget } from './providerBadge.js';
import { PixelIcon } from './ui/PixelIcon.js';

// eslint-disable-next-line react-refresh/only-export-components
export { pickNextTarget };

interface AgentStatusHudProps {
  agentIds: number[];
  statusFor: (agentId: number) => TabStatus | null;
  agentProviders: Record<number, string>;
  focusedAgentId: number | null;
  onFocusAgent: (agentId: number) => void;
  hotkeySuppressed: boolean;
  meetingRoomCount?: number;
  onOpenMeetingRooms?: () => void;
  canChatFocused?: boolean;
  onOpenChatFocused?: () => void;
  onOpenBookshelf?: () => void;
  onToggleFloating?: () => void;
  isFloatingOpen?: boolean;
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.closest('.xterm')) return true;
  return false;
}

/**
 * Age of Empires-style top HUD showing live Working / Idle / Needs-Approval counts,
 * per-provider breakdown (Claude / Codex / Antigravity), and `.` hotkey to jump to
 * the next idle or attention-needing agent.
 */
export function AgentStatusHud({
  agentIds,
  statusFor,
  agentProviders,
  focusedAgentId,
  onFocusAgent,
  hotkeySuppressed,
  meetingRoomCount = 0,
  onOpenMeetingRooms,
  canChatFocused = false,
  onOpenChatFocused,
  onOpenBookshelf,
  onToggleFloating,
  isFloatingOpen = false,
}: AgentStatusHudProps) {
  const { workingIds, idleIds, attentionIds, providerCounts } = useMemo(() => {
    const working: number[] = [];
    const idle: number[] = [];
    const attention: number[] = [];
    const counts: Record<string, number> = { claude: 0, codex: 0, antigravity: 0 };

    for (const id of agentIds) {
      const status = statusFor(id);
      if (status === 'attention') {
        attention.push(id);
      } else if (status === 'working') {
        working.push(id);
      } else {
        // Treat 'idle' or recién-adopted null status as idle/standby so every visible
        // villager is accounted for immediately.
        idle.push(id);
      }
      const p = agentProviders[id] ?? 'claude';
      counts[p] = (counts[p] ?? 0) + 1;
    }

    return {
      workingIds: working,
      idleIds: idle,
      attentionIds: attention,
      providerCounts: counts,
    };
  }, [agentIds, statusFor, agentProviders]);

  const cycleWorking = useCallback(() => {
    const next = pickNextTarget(workingIds, focusedAgentId);
    if (next !== null) onFocusAgent(next);
  }, [workingIds, focusedAgentId, onFocusAgent]);

  const cycleIdle = useCallback(() => {
    const next = pickNextTarget(idleIds, focusedAgentId);
    if (next !== null) onFocusAgent(next);
  }, [idleIds, focusedAgentId, onFocusAgent]);

  const cycleAttention = useCallback(() => {
    const next = pickNextTarget(attentionIds, focusedAgentId);
    if (next !== null) onFocusAgent(next);
  }, [attentionIds, focusedAgentId, onFocusAgent]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (hotkeySuppressed) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableElement(document.activeElement)) return;
      if (e.key === '.') {
        const targets = [...attentionIds, ...idleIds];
        const next = pickNextTarget(targets, focusedAgentId);
        if (next !== null) {
          e.preventDefault();
          onFocusAgent(next);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeySuppressed, attentionIds, idleIds, focusedAgentId, onFocusAgent]);

  const activeProviders = (['codex', 'antigravity', 'claude'] as const).filter(
    (p) => (providerCounts[p] ?? 0) > 0,
  );

  return (
    <div
      data-testid="agent-status-hud"
      className="absolute top-8 left-1/2 -translate-x-1/2 z-20 flex items-center gap-6 px-8 py-4 border-border pixel-panel select-none pointer-events-auto whitespace-nowrap"
    >
      {/* Working counter */}
      <button
        type="button"
        onClick={cycleWorking}
        disabled={workingIds.length === 0}
        title={workingIds.length > 0 ? '點擊切換至下一位工作中 Agent' : '目前沒有正在工作的 Agent'}
        className={`flex items-center gap-4 px-6 py-2 border-2 text-xs leading-none ${
          workingIds.length > 0
            ? 'bg-btn-bg hover:bg-btn-hover border-border cursor-pointer text-text'
            : 'bg-bg-dark border-transparent text-text-muted cursor-default opacity-60'
        }`}
      >
        <span className="flex text-accent-bright">
          <PixelIcon name="dot" scale={1} />
        </span>
        <span>工作中 {workingIds.length}</span>
      </button>

      {/* AoE Idle Villager button + [.] hotkey */}
      <button
        type="button"
        onClick={cycleIdle}
        disabled={idleIds.length === 0}
        title="點擊或按「.」跳至下一位閒置 Agent (世紀帝國閒置村民快捷鍵)"
        className={`flex items-center gap-4 px-6 py-2 border-2 text-xs leading-none ${
          idleIds.length > 0
            ? 'bg-btn-bg hover:bg-btn-hover border-status-success cursor-pointer text-text'
            : 'bg-bg-dark border-transparent text-text-muted cursor-default opacity-60'
        }`}
      >
        <span className="flex text-status-success">
          <PixelIcon name="dot" scale={1} />
        </span>
        <span>閒置 {idleIds.length}</span>
        <span className="text-2xs text-text-muted">[.]</span>
      </button>

      {/* Needs approval alert */}
      {attentionIds.length > 0 && (
        <button
          type="button"
          onClick={cycleAttention}
          title="點擊或按「.」跳至下一位等待授權的 Agent"
          className="flex items-center gap-4 px-6 py-2 border-2 border-status-permission bg-btn-bg hover:bg-btn-hover cursor-pointer text-xs leading-none text-text"
        >
          <span className="flex text-status-permission">
            <PixelIcon name="dot" scale={1} />
          </span>
          <span>需授權 {attentionIds.length}</span>
        </button>
      )}

      {/* Provider breakdown pills */}
      <div className="flex items-center gap-4 pl-4 border-l-2 border-border text-2xs leading-none">
        {activeProviders.length > 0 ? (
          activeProviders.map((p) => {
            const badge = getProviderBadge(p);
            return (
              <span
                key={p}
                className="px-4 py-2 leading-none"
                style={{ background: badge.bg, color: badge.text }}
                title={`${badge.label}: ${providerCounts[p]} 位`}
              >
                {badge.short} {providerCounts[p]}
              </span>
            );
          })
        ) : (
          <span className="text-text-muted">監看中：Codex / Antigravity / Claude</span>
        )}
      </div>

      {/* Meeting Rooms, Chat, Bookshelf archive & Floating mini-window buttons */}
      {(onOpenMeetingRooms ||
        (canChatFocused && onOpenChatFocused) ||
        onOpenBookshelf ||
        onToggleFloating) && (
        <div className="flex items-center gap-4 pl-4 border-l-2 border-border text-2xs leading-none">
          {canChatFocused && onOpenChatFocused && (
            <button
              type="button"
              onClick={onOpenChatFocused}
              title="與目前聚焦的主導者或獨立 Agent 對話"
              className="px-6 py-2 bg-accent hover:bg-accent-bright border border-accent-bright text-text-on-accent cursor-pointer leading-none"
            >
              對話
            </button>
          )}
          {onOpenMeetingRooms && (
            <button
              type="button"
              onClick={onOpenMeetingRooms}
              title="檢視多 Agent / Subagent 會議室（主要任務與角色名稱）"
              className={`px-6 py-2 border cursor-pointer leading-none ${
                meetingRoomCount > 0
                  ? 'bg-active-bg hover:bg-btn-hover border-accent-bright text-text'
                  : 'bg-btn-bg hover:bg-btn-hover border-border text-text'
              }`}
            >
              會議室 {meetingRoomCount}
            </button>
          )}
          {onOpenBookshelf && (
            <button
              type="button"
              onClick={onOpenBookshelf}
              title="開啟檔案書櫃（也可直接點擊辦公室裡的書櫃）"
              className="px-6 py-2 bg-btn-bg hover:bg-btn-hover border border-border text-text cursor-pointer leading-none"
            >
              書櫃
            </button>
          )}
          {onToggleFloating && (
            <button
              type="button"
              onClick={onToggleFloating}
              title="開啟／關閉置頂懸浮小視窗"
              className={`px-6 py-2 border cursor-pointer leading-none ${
                isFloatingOpen
                  ? 'bg-active-bg border-accent-bright text-text'
                  : 'bg-btn-bg hover:bg-btn-hover border-border text-text'
              }`}
            >
              懸浮
            </button>
          )}
        </div>
      )}
    </div>
  );
}
