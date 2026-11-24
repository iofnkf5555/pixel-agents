import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { ChatDeliveryMode, ChatTargetInfo } from '../hooks/useChatTargets.js';
import {
  type CrossVendorReviewRecord,
  type InviteReviewInput,
  inviteReviewLabel,
} from '../hooks/useCrossVendorReviews.js';
import type { MeetingRoomMemberInfo } from '../office/meetingRooms.js';
import type { ToolActivity } from '../office/types.js';
import { serverToken } from '../transport/serverToken.js';
import type { AgentAppearance } from './AgentCard.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { CrossVendorReviewCard } from './CrossVendorReviewCard.js';
import { getProviderBadge } from './providerBadge.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestampMs?: number;
  pending?: boolean;
}

interface AgentChatDialogProps {
  agentId: number | null;
  onClose: () => void;
  onSelectAgent: (id: number) => void;
  communicableAgentIds: number[];
  canChatAgent: (id: number) => boolean;
  agentProviders: Record<number, string>;
  agentDirectoryMap: Record<number, string>;
  meetingRoomMembers?: ReadonlyMap<number, MeetingRoomMemberInfo>;
  agentTools: Record<number, ToolActivity[]>;
  agentStatuses: Record<number, string>;
  getAppearance: (id: number) => AgentAppearance;
  activeReview?: CrossVendorReviewRecord | null;
  reviewBusy?: boolean;
  reviewError?: string | null;
  onInviteReview?: (input: InviteReviewInput) => Promise<boolean>;
  onForwardReview?: (reviewId: string) => Promise<boolean>;
  onDismissReview?: (reviewId: string) => Promise<boolean>;
}

function apiUrl(pathname: string): string {
  return serverToken ? `${pathname}?token=${encodeURIComponent(serverToken)}` : pathname;
}

function deliveryLabel(mode: ChatDeliveryMode | undefined): string {
  switch (mode) {
    case 'codex-queue':
      return 'Codex Queue';
    case 'codex-exec':
      return 'Codex Resume';
    case 'agy-print':
      return 'Antigravity CLI';
    case 'claude-pty':
      return 'Claude PTY';
    case 'claude-resume':
      return 'Claude Resume';
    default:
      return 'Direct CLI';
  }
}

function formatMessageTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function AgentChatDialog({
  agentId,
  onClose,
  onSelectAgent,
  communicableAgentIds,
  canChatAgent,
  agentProviders,
  agentDirectoryMap,
  meetingRoomMembers,
  agentTools,
  agentStatuses,
  getAppearance,
  activeReview = null,
  reviewBusy = false,
  reviewError = null,
  onInviteReview,
  onForwardReview,
  onDismissReview,
}: AgentChatDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const focusInputId = useId();
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [target, setTarget] = useState<ChatTargetInfo | null>(null);
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [reviewFocus, setReviewFocus] = useState('');

  const isOpen = agentId !== null && canChatAgent(agentId);

  const loadMessages = useCallback(async (id: number) => {
    try {
      const res = await fetch(apiUrl(`/api/agents/${id}/messages`));
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        target?: ChatTargetInfo;
        messages?: ChatMessageItem[];
        pending?: boolean;
        lastError?: string | null;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setTarget(data.target ?? null);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setPending(Boolean(data.pending));
      setError(data.lastError ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法讀取對話紀錄');
    }
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      onClose();
    };
    dialog.addEventListener('close', handleClose);

    if ('closedBy' in HTMLDialogElement.prototype) {
      return () => {
        dialog.removeEventListener('close', handleClose);
      };
    }

    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e) && dialog.open) {
        dialog.close();
      }
      pressedOutside = false;
    };
    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);

    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [onClose]);

  useEffect(() => {
    if (!isOpen || agentId === null) return;
    setMessages([]);
    setError(null);
    setPending(false);
    setShowInviteForm(false);
    setReviewFocus('');
    void loadMessages(agentId);
    const timer = setInterval(() => {
      void loadMessages(agentId);
    }, 2000);
    return () => clearInterval(timer);
  }, [isOpen, agentId, loadMessages]);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, agentId]);

  const handleSend = useCallback(async () => {
    if (agentId === null || !canChatAgent(agentId) || sending) return;
    const text = draft.trim();
    if (!text) return;

    setSending(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/agents/${agentId}/message`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        message?: ChatMessageItem;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setDraft('');
      if (data.message) {
        setMessages((prev) => [...prev, data.message!]);
      }
      await loadMessages(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '傳送失敗');
    } finally {
      setSending(false);
    }
  }, [agentId, canChatAgent, draft, loadMessages, sending]);

  const activeId = isOpen && agentId !== null ? agentId : null;
  const member = activeId !== null ? meetingRoomMembers?.get(activeId) : undefined;
  const badge = getProviderBadge(activeId !== null ? agentProviders[activeId] : undefined);
  const appearance = activeId !== null ? getAppearance(activeId) : { palette: 0, repeat: 0 };
  const liveTools = activeId !== null ? agentTools[activeId] : undefined;
  const isLiveWorking =
    activeId !== null &&
    ((liveTools?.some((t) => !t.done) ?? false) ||
      (agentStatuses[activeId] !== undefined && agentStatuses[activeId] !== 'waiting'));

  const inviteText = activeId !== null ? inviteReviewLabel(agentProviders[activeId]) : null;
  const canInviteHeader =
    activeId !== null &&
    Boolean(onInviteReview) &&
    Boolean(inviteText) &&
    (!activeReview ||
      (activeReview.status !== 'running' &&
        (activeReview.status === 'failed' || activeReview.round < activeReview.maxRounds)));

  const titleText =
    activeId === null
      ? '對話'
      : member
        ? member.isLead
          ? `主要任務 · ${member.roomPrimaryTask}`
          : `${member.roleName} · ${member.roomPrimaryTask}`
        : (agentDirectoryMap[activeId] ?? `Agent ${activeId}`);

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="agent-chat-dialog-title"
      className="pixel-native-dialog m-auto bg-bg text-text border-2 border-border rounded-none shadow-pixel p-0 w-[min(720px,calc(100vw-24px))] h-[min(620px,calc(100vh-24px))] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-8 px-12 py-8 border-b-2 border-border bg-panel shrink-0">
        <div className="flex items-center gap-8 min-w-0">
          {activeId !== null && (
            <div className="shrink-0">
              <CharacterMugShot palette={appearance.palette} repeat={appearance.repeat} />
            </div>
          )}
          <div className="flex flex-col gap-3 min-w-0">
            <div className="flex items-center gap-6 min-w-0">
              {member?.isLead && (
                <span className="px-4 py-1 bg-accent text-text-on-accent text-2xs leading-none shrink-0">
                  主導 · {member.roleName}
                </span>
              )}
              <h1
                id="agent-chat-dialog-title"
                className="m-0 text-base text-accent-bright truncate"
                title={titleText}
              >
                {titleText}
              </h1>
            </div>
            <div className="flex items-center gap-6 text-2xs text-text-muted">
              <span
                className="px-4 py-1 leading-none shrink-0"
                style={{ background: badge.bg, color: badge.text }}
              >
                {badge.label}
              </span>
              <span className="px-4 py-1 border border-border bg-bg-dark leading-none shrink-0">
                {deliveryLabel(target?.mode)}
              </span>
              {(pending || isLiveWorking) && (
                <span className="flex items-center gap-3 text-accent-bright">
                  <span className="w-6 h-6 rounded-full bg-accent-bright pixel-pulse shrink-0" />
                  <span>Agent 處理中…</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6 shrink-0">
          {canInviteHeader && inviteText && activeId !== null && (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={reviewBusy}
              aria-expanded={showInviteForm}
              onClick={() => setShowInviteForm((v) => !v)}
            >
              {inviteText}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => dialogRef.current?.close()}
            title="關閉"
          >
            <PixelIcon name="close" />
          </Button>
        </div>
      </div>

      {showInviteForm && activeId !== null && onInviteReview && (
        <div className="px-12 py-8 border-b border-border bg-bg-dark flex flex-col gap-4 shrink-0">
          <label htmlFor={focusInputId} className="text-2xs text-text">
            指定唯讀審查重點（選填，留白將檢查當前工作區近期變更與風險）
          </label>
          <div className="flex items-center gap-6 flex-wrap">
            <input
              id={focusInputId}
              type="text"
              value={reviewFocus}
              onChange={(e) => setReviewFocus(e.target.value)}
              placeholder="例如：檢查安全性、錯誤處理或相容性"
              className="flex-1 min-w-160 bg-bg text-text border border-border px-8 py-4 text-xs font-pixel focus:outline-none focus:border-accent-bright"
            />
            <Button
              type="button"
              variant="accent"
              size="sm"
              disabled={reviewBusy}
              onClick={() => {
                void onInviteReview({
                  hostAgentId: activeId,
                  focus: reviewFocus.trim() || undefined,
                  previousReviewId: activeReview?.reviewId,
                }).then((ok) => {
                  if (ok) {
                    setShowInviteForm(false);
                    setReviewFocus('');
                  }
                });
              }}
            >
              立即邀請審查
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowInviteForm(false);
                setReviewFocus('');
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}

      {reviewError && (
        <div
          role="alert"
          className="px-12 py-4 bg-bg-dark border-b border-danger text-2xs text-danger shrink-0"
        >
          {reviewError}
        </div>
      )}

      {activeReview && activeId !== null && (
        <div className="px-12 py-8 border-b border-border bg-panel shrink-0 max-h-220 overflow-y-auto">
          <CrossVendorReviewCard
            review={activeReview}
            compact
            busy={reviewBusy}
            onForward={onForwardReview}
            onAfterForward={() => {
              void loadMessages(activeId);
            }}
            onReReview={
              onInviteReview
                ? (rev) =>
                    onInviteReview({
                      hostAgentId: rev.hostAgentId,
                      focus: rev.focus,
                      previousReviewId: rev.reviewId,
                    })
                : undefined
            }
            onDismiss={onDismissReview}
          />
        </div>
      )}

      {/* Quick switch strip: strictly Leads & standalone main sessions only */}
      {communicableAgentIds.length > 1 && (
        <div className="flex items-center gap-4 px-12 py-6 border-b border-border bg-bg-dark overflow-x-auto shrink-0">
          <span className="text-2xs text-text-muted shrink-0">切換對象：</span>
          {communicableAgentIds.map((cid) => {
            const cm = meetingRoomMembers?.get(cid);
            const label = cm
              ? cm.isLead
                ? `主導 · ${cm.roomPrimaryTask}`
                : cm.roleName
              : (agentDirectoryMap[cid] ?? `Agent ${cid}`);
            const cBadge = getProviderBadge(agentProviders[cid]);
            const isActive = cid === activeId;
            return (
              <button
                key={cid}
                type="button"
                onClick={() => onSelectAgent(cid)}
                className={`flex items-center gap-4 px-6 py-2 border text-2xs leading-none cursor-pointer shrink-0 max-w-180 ${
                  isActive
                    ? 'bg-active-bg border-accent-bright text-text'
                    : 'bg-panel hover:bg-btn-hover border-border text-text-muted'
                }`}
                title={label}
              >
                <span
                  className="px-2 py-1 leading-none shrink-0"
                  style={{ background: cBadge.bg, color: cBadge.text }}
                >
                  {cBadge.short}
                </span>
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Message Feed */}
      <div ref={feedRef} className="flex-1 overflow-y-auto p-12 flex flex-col gap-8 bg-bg">
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-xs text-text-muted px-16 gap-4">
            <span>尚無可顯示的近期對話片段，你可以直接在下方送出訊息給這位 Agent。</span>
            <span className="text-2xs">
              （僅主導者與獨立 Session 開放對話，Subagent 已自動排除）
            </span>
          </div>
        ) : (
          messages.map((m) => {
            const isUser = m.role === 'user';
            const timeStr = formatMessageTime(m.timestampMs);
            return (
              <div
                key={m.id}
                className={`flex flex-col gap-2 max-w-[85%] ${isUser ? 'self-end items-end' : 'self-start items-start'}`}
              >
                <div className="flex items-center gap-4 text-2xs text-text-muted">
                  <span>{isUser ? '你' : member?.roleName || badge.label}</span>
                  {timeStr && <span>{timeStr}</span>}
                </div>
                <div
                  className={`px-10 py-8 border-2 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                    isUser
                      ? 'bg-active-bg border-accent-bright text-text'
                      : 'bg-panel border-border text-text'
                  }`}
                >
                  {m.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-12 py-4 bg-bg-dark border-t border-danger text-xs text-danger shrink-0">
          發送 / 讀取失敗：{error}
        </div>
      )}

      {/* Composer */}
      <div className="p-10 border-t-2 border-border bg-panel flex items-end gap-8 shrink-0">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={2}
          placeholder="輸入指令或問題給主導者／Agent（Enter 送出，Shift+Enter 換行）…"
          className="flex-1 min-h-48 max-h-120 resize-y bg-bg-dark text-text border-2 border-border px-8 py-6 text-xs font-pixel focus:outline-none focus:border-accent-bright"
        />
        <Button
          variant="accent"
          size="md"
          disabled={sending || !draft.trim()}
          onClick={() => void handleSend()}
        >
          {sending ? '送出中…' : '送出'}
        </Button>
      </div>
    </dialog>
  );
}
