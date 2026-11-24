import { useCallback, useMemo } from 'react';

import type { MeetingRoomMemberInfo, MeetingRoomModel } from '../office/meetingRooms.js';
import type { ToolActivity } from '../office/types.js';
import type { TabStatus } from './AgentCard.js';
import { getProviderBadge, pickNextTarget } from './providerBadge.js';
import { STATUS_DOT } from './statusDot.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface FloatingMiniBoardProps {
  agentIds: number[];
  statusFor: (agentId: number) => TabStatus | null;
  agentProviders: Record<number, string>;
  agentDirectoryMap: Record<number, string>;
  agentTools: Record<number, ToolActivity[]>;
  meetingRooms?: readonly MeetingRoomModel[];
  meetingRoomMembers?: ReadonlyMap<number, MeetingRoomMemberInfo>;
  canChatAgent?: (agentId: number) => boolean;
  onOpenChat?: (agentId: number) => void;
  focusedAgentId: number | null;
  onFocusAgent: (agentId: number) => void;
  onFocusMainWindow?: () => void;
  onClose?: () => void;
}

function summarizeActivity(status: TabStatus | null, tools: ToolActivity[] | undefined): string {
  if (status === 'attention') return '等待授權';
  if (status === 'disconnected') return '連線中斷';
  if (tools && tools.length > 0) {
    const active = [...tools].reverse().find((t) => !t.done);
    if (active) return active.status;
  }
  if (status === 'working') return '工作中';
  return '閒置待命';
}

export function FloatingMiniBoard({
  agentIds,
  statusFor,
  agentProviders,
  agentDirectoryMap,
  agentTools,
  meetingRooms = [],
  meetingRoomMembers,
  canChatAgent,
  onOpenChat,
  focusedAgentId,
  onFocusAgent,
  onFocusMainWindow,
  onClose,
}: FloatingMiniBoardProps) {
  const { workingIds, idleIds, attentionIds } = useMemo(() => {
    const working: number[] = [];
    const idle: number[] = [];
    const attention: number[] = [];
    for (const id of agentIds) {
      const s = statusFor(id);
      if (s === 'attention') attention.push(id);
      else if (s === 'working') working.push(id);
      else idle.push(id);
    }
    return { workingIds: working, idleIds: idle, attentionIds: attention };
  }, [agentIds, statusFor]);

  const soloAgentIds = useMemo(() => {
    if (!meetingRoomMembers || meetingRoomMembers.size === 0) return agentIds;
    return agentIds.filter((id) => !meetingRoomMembers.has(id));
  }, [agentIds, meetingRoomMembers]);

  const cycleNext = useCallback(
    (pool: number[]) => {
      const next = pickNextTarget(pool, focusedAgentId);
      if (next !== null) {
        onFocusAgent(next);
        onFocusMainWindow?.();
      }
    },
    [focusedAgentId, onFocusAgent, onFocusMainWindow],
  );

  const renderAgentRow = (
    id: number,
    opts?: { roleName?: string; isLead?: boolean; isSubagent?: boolean; providerId?: string },
  ) => {
    const status = opts?.isSubagent ? 'working' : statusFor(id);
    const badge = getProviderBadge(opts?.providerId ?? agentProviders[id]);
    const label = opts?.roleName ?? agentDirectoryMap[id] ?? `Agent ${id}`;
    const activity = opts?.isSubagent ? '執行子任務中' : summarizeActivity(status, agentTools[id]);
    const dotClass = status ? STATUS_DOT[status] : STATUS_DOT.idle;
    const isFocused = focusedAgentId === id;
    const canChat = !opts?.isSubagent && (canChatAgent?.(id) ?? false);
    return (
      <div
        key={id}
        className={`w-full flex items-center justify-between gap-6 px-8 py-5 border ${
          isFocused
            ? 'bg-active-bg border-accent-bright'
            : 'bg-panel hover:bg-btn-hover border-border'
        }`}
      >
        <button
          type="button"
          onClick={() => {
            onFocusAgent(id);
            onFocusMainWindow?.();
          }}
          className="flex-1 flex items-center justify-between gap-6 min-w-0 text-left cursor-pointer bg-transparent border-0 p-0"
        >
          <div className="flex items-center gap-6 min-w-0">
            <span
              className="px-4 py-1 text-2xs leading-none shrink-0"
              style={{ background: badge.bg, color: badge.text }}
            >
              {badge.short}
            </span>
            {opts?.isLead && (
              <span className="px-3 py-1 bg-accent text-text-on-accent text-2xs leading-none shrink-0">
                主導
              </span>
            )}
            <span className="text-sm text-text truncate">{label}</span>
          </div>
          <div className="flex items-center gap-6 shrink-0">
            <span className="text-xs text-text-muted max-w-120 truncate">{activity}</span>
            <span className={`flex ${dotClass}`}>
              <PixelIcon name="dot" scale={1} />
            </span>
          </div>
        </button>
        {canChat && onOpenChat && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChat(id);
              onFocusMainWindow?.();
            }}
            className="px-5 py-2 bg-accent hover:bg-accent-bright text-text-on-accent border border-accent-bright text-2xs leading-none cursor-pointer shrink-0"
          >
            對話
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="w-full h-full flex flex-col bg-bg text-text font-pixel select-none overflow-hidden">
      {/* Compact Top Bar */}
      <div className="flex items-center justify-between gap-4 px-8 py-6 bg-panel border-b-2 border-border shrink-0">
        <div className="flex items-center gap-4">
          <button
            type="button"
            disabled={workingIds.length === 0}
            onClick={() => cycleNext(workingIds)}
            className="flex items-center gap-3 px-6 py-2 bg-btn-bg hover:bg-btn-hover disabled:opacity-50 border border-border text-xs leading-none cursor-pointer"
          >
            <span className="flex text-accent-bright">
              <PixelIcon name="dot" scale={1} />
            </span>
            <span>工作 {workingIds.length}</span>
          </button>

          <button
            type="button"
            disabled={idleIds.length === 0}
            onClick={() => cycleNext(idleIds)}
            className="flex items-center gap-3 px-6 py-2 bg-btn-bg hover:bg-btn-hover disabled:opacity-50 border border-status-success text-xs leading-none cursor-pointer"
          >
            <span className="flex text-status-success">
              <PixelIcon name="dot" scale={1} />
            </span>
            <span>閒置 {idleIds.length}</span>
          </button>

          {attentionIds.length > 0 && (
            <button
              type="button"
              onClick={() => cycleNext(attentionIds)}
              className="flex items-center gap-3 px-6 py-2 bg-btn-bg hover:bg-btn-hover border border-status-permission text-xs leading-none cursor-pointer"
            >
              <span className="flex text-status-permission">
                <PixelIcon name="dot" scale={1} />
              </span>
              <span>授權 {attentionIds.length}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-4">
          {onFocusMainWindow && (
            <button
              type="button"
              onClick={onFocusMainWindow}
              title="回到主辦公室視窗"
              className="px-6 py-2 bg-btn-bg hover:bg-btn-hover border border-border text-2xs leading-none cursor-pointer text-text"
            >
              主視窗
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="關閉懸浮視窗"
              className="px-4 py-2 bg-btn-bg hover:bg-btn-hover border border-border text-2xs leading-none cursor-pointer text-text"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Compact Agent List */}
      <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
        {agentIds.length === 0 && meetingRooms.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-text-muted">
            目前無活躍 Agent（監看中：Codex / Antigravity / Claude）
          </div>
        ) : (
          <>
            {meetingRooms.map((room) => (
              <div
                key={room.id}
                className="flex flex-col gap-3 p-4 border border-accent-bright bg-bg-dark"
              >
                <div className="flex items-center justify-between gap-4 px-2">
                  <div className="flex items-center gap-4 min-w-0">
                    <span className="px-3 py-1 bg-accent text-text-on-accent text-2xs leading-none shrink-0">
                      主要任務
                    </span>
                    <span className="text-xs text-text truncate" title={room.primaryTask}>
                      {room.primaryTask}
                    </span>
                  </div>
                  <span className="text-2xs text-text-muted shrink-0">
                    {room.slot ? room.slot.label : '會議室'}
                  </span>
                </div>
                {room.members.map((m) =>
                  renderAgentRow(m.id, {
                    roleName: m.roleName,
                    isLead: m.isLead,
                    isSubagent: m.isSubagent,
                    providerId: m.providerId,
                  }),
                )}
              </div>
            ))}
            {soloAgentIds.map((id) => renderAgentRow(id))}
          </>
        )}
      </div>
    </div>
  );
}
