import { useEffect, useId, useRef, useState } from 'react';

import {
  type CrossVendorReviewRecord,
  type InviteReviewInput,
  inviteReviewLabel,
} from '../hooks/useCrossVendorReviews.js';
import type { MeetingRoomModel } from '../office/meetingRooms.js';
import type { ToolActivity } from '../office/types.js';
import type { AgentAppearance, TabStatus } from './AgentCard.js';
import { CharacterMugShot } from './CharacterMugShot.js';
import { CrossVendorReviewCard } from './CrossVendorReviewCard.js';
import { getProviderBadge } from './providerBadge.js';
import { STATUS_DOT } from './statusDot.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface MeetingRoomDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rooms: readonly MeetingRoomModel[];
  agentStatuses: Record<number, string>;
  agentTools: Record<number, ToolActivity[]>;
  getAppearance: (agentId: number) => AgentAppearance;
  onFocusAgent: (agentId: number) => void;
  onFocusRoom: (roomId: string) => void;
  canChatAgent?: (agentId: number) => boolean;
  onOpenChat?: (agentId: number) => void;
  reviews?: readonly CrossVendorReviewRecord[];
  communicableAgentIds?: readonly number[];
  agentProviders?: Record<number, string>;
  agentDirectoryMap?: Record<number, string>;
  reviewBusyHostIds?: ReadonlySet<number>;
  reviewBusyIds?: ReadonlySet<string>;
  reviewError?: string | null;
  onInviteReview?: (input: InviteReviewInput) => Promise<boolean>;
  onForwardReview?: (reviewId: string) => Promise<boolean>;
  onDismissReview?: (reviewId: string) => Promise<boolean>;
}

function memberStatus(
  id: number,
  isSubagent: boolean,
  isReviewer: boolean,
  agentStatuses: Record<number, string>,
  agentTools: Record<number, ToolActivity[]>,
): { dotStatus: TabStatus; label: string } {
  const tools = agentTools[id];
  if (tools && tools.length > 0) {
    const active = [...tools].reverse().find((t) => !t.done);
    if (active?.permissionWait) {
      return { dotStatus: 'attention', label: '等待授權' };
    }
    if (active) {
      return { dotStatus: 'working', label: active.status };
    }
  }
  if (isReviewer) {
    return agentStatuses[id] === 'waiting'
      ? { dotStatus: 'idle', label: '審查完成／待命' }
      : { dotStatus: 'working', label: '跨模型審查中…' };
  }
  if (!isSubagent && agentStatuses[id] === 'waiting') {
    return { dotStatus: 'idle', label: '閒置待命' };
  }
  if (isSubagent) {
    return { dotStatus: 'working', label: '執行子任務中' };
  }
  return { dotStatus: 'idle', label: '線上待命' };
}

export function MeetingRoomDialog({
  isOpen,
  onClose,
  rooms,
  agentStatuses,
  agentTools,
  getAppearance,
  onFocusAgent,
  onFocusRoom,
  canChatAgent,
  onOpenChat,
  reviews = [],
  communicableAgentIds = [],
  agentProviders = {},
  agentDirectoryMap = {},
  reviewBusyHostIds,
  reviewBusyIds,
  reviewError,
  onInviteReview,
  onForwardReview,
  onDismissReview,
}: MeetingRoomDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusInputBaseId = useId();
  const [composerHostId, setComposerHostId] = useState<number | null>(null);
  const [focusDraft, setFocusDraft] = useState('');

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

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="meeting-room-dialog-title"
      className="pixel-native-dialog m-auto bg-bg text-text border-2 border-border rounded-none shadow-pixel p-0 w-[min(760px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-12 py-8 border-b-2 border-border bg-panel shrink-0">
        <div className="flex items-center gap-8">
          <h1 id="meeting-room-dialog-title" className="m-0 text-xl text-accent-bright">
            會議室 · 多 Agent / 子任務協作空間
          </h1>
          <span className="text-xs text-text-muted">{rooms.length} 間進行中</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => dialogRef.current?.close()} title="關閉">
          <PixelIcon name="close" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-12 flex flex-col gap-10">
        {reviewError && (
          <div
            role="alert"
            className="px-10 py-6 bg-bg-dark border-2 border-danger text-xs text-danger"
          >
            {reviewError}
          </div>
        )}

        {onInviteReview &&
          (() => {
            const roomLeadIds = new Set(rooms.map((r) => r.leadAgentId));
            const eligibleSolos = communicableAgentIds.filter(
              (cid) => !roomLeadIds.has(cid) && inviteReviewLabel(agentProviders[cid]) !== null,
            );
            if (eligibleSolos.length === 0) return null;
            return (
              <div className="border-2 border-border bg-panel p-8 flex flex-col gap-6">
                <div className="flex items-center justify-between gap-6 flex-wrap">
                  <span className="text-xs text-text-muted">
                    邀請跨模型唯讀審查者加入獨立工作階段（將自動安排進小型會議室）：
                  </span>
                </div>
                <div className="flex items-center gap-6 flex-wrap">
                  {eligibleSolos.map((cid) => {
                    const label = inviteReviewLabel(agentProviders[cid])!;
                    const badge = getProviderBadge(agentProviders[cid]);
                    const hostName = agentDirectoryMap[cid] || `Agent ${cid}`;
                    const busy = reviewBusyHostIds?.has(cid) ?? false;
                    return (
                      <Button
                        key={`solo-invite-${cid}`}
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={busy}
                        aria-label={`${label} — ${hostName}`}
                        onClick={() => {
                          void onInviteReview({ hostAgentId: cid });
                        }}
                      >
                        <span className="inline-flex items-center gap-4">
                          <span
                            className="px-3 py-1 leading-none text-2xs"
                            style={{ background: badge.bg, color: badge.text }}
                          >
                            {badge.short}
                          </span>
                          <span className="max-w-140 truncate">{hostName}</span>
                          <span className="text-accent-bright">· {label}</span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        {rooms.length === 0 ? (
          <div className="p-16 bg-panel border-2 border-border text-center">
            <div className="text-base text-text mb-4">目前沒有進行中的會議室</div>
            <p className="text-xs text-text-muted m-0">
              當有 Agent 開啟 Subagent（子任務）、同專案存在多個活躍
              Session，或從上方邀請跨模型審查者（AGY／CDX
              Reviewer）時，系統會自動安排進會議室，標題顯示「主要任務」，成員個別標示角色名稱。
            </p>
          </div>
        ) : (
          rooms.map((room) => {
            const leadProvider =
              room.members.find((m) => m.id === room.leadAgentId)?.providerId ??
              agentProviders[room.leadAgentId];
            const inviteText = inviteReviewLabel(leadProvider);
            const roomReview =
              reviews.find((r) => r.hostAgentId === room.leadAgentId) ??
              reviews.find((r) => room.members.some((m) => m.id === r.hostAgentId));
            const leadBusy = reviewBusyHostIds?.has(room.leadAgentId) ?? false;
            const canInviteRoom =
              Boolean(onInviteReview) &&
              Boolean(inviteText) &&
              (canChatAgent?.(room.leadAgentId) ?? false) &&
              (!roomReview ||
                (roomReview.status !== 'running' &&
                  (roomReview.status === 'failed' || roomReview.round < roomReview.maxRounds)));
            const showFocusInput = composerHostId === room.leadAgentId;
            const inputId = `${focusInputBaseId}-${room.leadAgentId}`;

            return (
              <section
                key={room.id}
                className="border-2 border-border bg-panel p-10 flex flex-col gap-8"
              >
                <div className="flex items-center justify-between gap-8 flex-wrap pb-6 border-b border-border">
                  <div className="flex items-center gap-6 min-w-0">
                    <span className="px-6 py-2 bg-accent text-text-on-accent text-2xs leading-none shrink-0">
                      主要任務
                    </span>
                    {room.isCrossVendor && (
                      <span className="px-4 py-1 bg-active-bg border border-accent-bright text-accent-bright text-2xs leading-none shrink-0">
                        跨模型審查
                      </span>
                    )}
                    <h2 className="m-0 text-base text-text truncate" title={room.primaryTask}>
                      {room.primaryTask}
                    </h2>
                  </div>
                  <div className="flex items-center gap-6 flex-wrap shrink-0">
                    <span className="px-4 py-1 border border-border bg-bg-dark text-2xs text-text-muted leading-none">
                      {room.kind === 'subagent' ? 'Subagent 協作' : '多 Session 同專案'}
                    </span>
                    <span className="px-4 py-1 border border-border bg-bg-dark text-2xs text-accent-bright leading-none">
                      {room.slot
                        ? `${room.slot.label}（${room.members.length}/${room.slot.capacity}人）`
                        : `動態分組（${room.members.length}人）`}
                    </span>
                    {canInviteRoom && inviteText && onInviteReview && (
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        disabled={leadBusy}
                        aria-expanded={showFocusInput}
                        aria-label={`${inviteText} — ${room.primaryTask}`}
                        onClick={() => {
                          if (showFocusInput) {
                            setComposerHostId(null);
                            setFocusDraft('');
                          } else {
                            setComposerHostId(room.leadAgentId);
                            setFocusDraft('');
                          }
                        }}
                      >
                        {inviteText}
                      </Button>
                    )}
                    {room.slot && (
                      <Button
                        type="button"
                        variant="accent"
                        size="sm"
                        onClick={() => {
                          onFocusRoom(room.id);
                          dialogRef.current?.close();
                        }}
                      >
                        定位到會議室
                      </Button>
                    )}
                  </div>
                </div>

                {showFocusInput && onInviteReview && (
                  <div className="p-8 bg-bg-dark border border-border flex flex-col gap-6">
                    <label htmlFor={inputId} className="text-2xs text-text">
                      指定本次唯讀審查重點（選填，留白則檢查近期變更與風險）
                    </label>
                    <div className="flex items-center gap-6 flex-wrap">
                      <input
                        id={inputId}
                        type="text"
                        value={focusDraft}
                        onChange={(e) => setFocusDraft(e.target.value)}
                        placeholder="例如：確認狀態同步與邊界條件是否正確"
                        className="flex-1 min-w-180 bg-bg text-text border border-border px-8 py-4 text-xs font-pixel focus:outline-none focus:border-accent-bright"
                      />
                      <Button
                        type="button"
                        variant="accent"
                        size="sm"
                        disabled={leadBusy}
                        onClick={() => {
                          const focus = focusDraft.trim() || undefined;
                          void onInviteReview({
                            hostAgentId: room.leadAgentId,
                            focus,
                            previousReviewId: roomReview?.reviewId,
                          }).then((ok) => {
                            if (ok) {
                              setComposerHostId(null);
                              setFocusDraft('');
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
                          setComposerHostId(null);
                          setFocusDraft('');
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {room.members.map((member) => {
                    const appearance = getAppearance(member.id);
                    const badge = getProviderBadge(member.providerId);
                    const st = memberStatus(
                      member.id,
                      member.isSubagent,
                      member.isReviewer,
                      agentStatuses,
                      agentTools,
                    );

                    const canChat =
                      !member.isSubagent &&
                      !member.isReviewer &&
                      (canChatAgent?.(member.id) ?? false);
                    return (
                      <div
                        key={member.id}
                        className="flex items-center justify-between gap-6 p-6 bg-bg-dark hover:bg-panel-hover border border-border"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onFocusAgent(member.id);
                            dialogRef.current?.close();
                          }}
                          className="flex-1 flex items-center gap-8 min-w-0 text-left cursor-pointer bg-transparent border-0 p-0"
                        >
                          <div className="shrink-0">
                            <CharacterMugShot
                              palette={appearance.palette}
                              repeat={appearance.repeat}
                            />
                          </div>
                          <div className="flex flex-col gap-2 min-w-0">
                            <div className="flex items-center gap-4">
                              <span className="text-sm text-text truncate">{member.roleName}</span>
                              {member.isLead && (
                                <span className="px-3 py-1 bg-active-bg border border-accent-bright text-2xs text-accent-bright leading-none shrink-0">
                                  主導
                                </span>
                              )}
                              {member.isReviewer && (
                                <span className="px-3 py-1 bg-panel border border-accent-bright text-2xs text-accent-bright leading-none shrink-0">
                                  審查
                                </span>
                              )}
                              {member.isSubagent && (
                                <span className="px-3 py-1 bg-panel border border-border text-2xs text-text-muted leading-none shrink-0">
                                  子任務
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-2xs text-text-muted">
                              <span
                                className="px-3 py-1 leading-none shrink-0"
                                style={{ background: badge.bg, color: badge.text }}
                              >
                                {badge.short}
                              </span>
                              <span className="truncate">{st.label}</span>
                            </div>
                          </div>
                        </button>
                        <div className="flex items-center gap-6 shrink-0">
                          <span className={`flex shrink-0 ${STATUS_DOT[st.dotStatus]}`}>
                            <PixelIcon name="dot" scale={1} />
                          </span>
                          {canChat && onOpenChat && (
                            <Button
                              type="button"
                              variant={member.isLead ? 'accent' : 'default'}
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                dialogRef.current?.close();
                                onOpenChat(member.id);
                              }}
                            >
                              {member.isLead ? '跟主導者對話' : '對話'}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {roomReview && (
                  <CrossVendorReviewCard
                    review={roomReview}
                    busy={
                      (reviewBusyIds?.has(roomReview.reviewId) ?? false) ||
                      (reviewBusyHostIds?.has(roomReview.hostAgentId) ?? false)
                    }
                    onForward={onForwardReview}
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
                )}
              </section>
            );
          })
        )}

        {(() => {
          const roomMemberIds = new Set(rooms.flatMap((r) => r.members.map((m) => m.id)));
          const orphanReviews = reviews.filter((r) => !roomMemberIds.has(r.hostAgentId));
          if (orphanReviews.length === 0) return null;
          return (
            <div className="flex flex-col gap-8">
              {orphanReviews.map((rev) => (
                <CrossVendorReviewCard
                  key={rev.reviewId}
                  review={rev}
                  busy={
                    (reviewBusyIds?.has(rev.reviewId) ?? false) ||
                    (reviewBusyHostIds?.has(rev.hostAgentId) ?? false)
                  }
                  onForward={onForwardReview}
                  onReReview={
                    onInviteReview
                      ? (r) =>
                          onInviteReview({
                            hostAgentId: r.hostAgentId,
                            focus: r.focus,
                            previousReviewId: r.reviewId,
                          })
                      : undefined
                  }
                  onDismiss={onDismissReview}
                />
              ))}
            </div>
          );
        })()}
      </div>
    </dialog>
  );
}
