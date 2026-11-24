import { useEffect, useState } from 'react';

import { OVERLAY_LABEL_Z_INDEX } from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import type { MeetingRoomModel, MeetingRoomSlot } from '../meetingRooms.js';
import { overlayProjection } from '../projection.js';
import type { ToolActivity } from '../types.js';
import { TILE_SIZE } from '../types.js';

interface MeetingRoomOverlayProps {
  officeState: OfficeState;
  slots: readonly MeetingRoomSlot[];
  rooms: readonly MeetingRoomModel[];
  agentTools: Record<number, ToolActivity[]>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onSelectRoom: (roomId: string) => void;
}

/**
 * Floating pixel-art Meeting Room signboards anchored above dedicated conference rooms
 * (and active lounge discussions). Displays "主要任務" as the room title.
 */
export function MeetingRoomOverlay({
  officeState,
  slots,
  rooms,
  agentTools,
  containerRef,
  zoom,
  panRef,
  onSelectRoom,
}: MeetingRoomOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el || slots.length === 0) return null;

  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  return (
    <>
      {slots.map((slot) => {
        const room = rooms.find((r) => r.slot?.id === slot.id);
        if (!room && slot.id !== 'mr1' && slot.id !== 'mr2') {
          return null;
        }

        const left = project.toScreenX(slot.bannerCol * TILE_SIZE);
        const top = project.toScreenY(slot.bannerRow * TILE_SIZE);

        if (!room) {
          return (
            <div
              key={slot.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none select-none px-6 py-2 bg-panel border border-border opacity-70 text-2xs text-text-muted whitespace-nowrap"
              style={{ left, top, zIndex: OVERLAY_LABEL_Z_INDEX - 2 }}
              data-testid={`meeting-room-sign-${slot.id}`}
            >
              {slot.label} · {slot.capacity}席
            </div>
          );
        }

        const isWorking = room.members.some((m) => {
          const ch = officeState.characters.get(m.id);
          if (ch?.isActive) return true;
          return agentTools[m.id]?.some((t) => !t.done) ?? false;
        });

        const sizeBadge =
          slot.sizeTier === 'large' ? '大' : slot.sizeTier === 'medium' ? '中' : '小';

        return (
          <div
            key={slot.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto"
            style={{ left, top, zIndex: OVERLAY_LABEL_Z_INDEX - 1 }}
            data-testid={`meeting-room-sign-${slot.id}`}
          >
            <button
              type="button"
              onClick={() => onSelectRoom(room.id)}
              title={`${slot.label}（${room.members.length}/${slot.capacity}人）· 主要任務：${room.primaryTask}（點擊檢視或定位）`}
              className="flex items-center gap-5 px-8 py-3 border-2 border-accent-bright bg-panel hover:bg-panel-hover text-text cursor-pointer shadow-pixel whitespace-nowrap max-w-280"
            >
              <span
                className={`w-6 h-6 rounded-full shrink-0 ${
                  isWorking ? 'bg-accent-bright pixel-pulse' : 'bg-status-success'
                }`}
              />
              <span className="px-4 py-1 bg-accent text-text-on-accent text-2xs leading-none shrink-0">
                主要任務
              </span>
              {room.isCrossVendor && (
                <span className="px-4 py-1 bg-active-bg border border-accent-bright text-accent-bright text-2xs leading-none shrink-0">
                  跨模型
                </span>
              )}
              <span className="text-xs text-text leading-none truncate">{room.primaryTask}</span>
              <span className="text-2xs text-text-muted leading-none shrink-0">
                {sizeBadge} · {room.members.length}/{slot.capacity}人
              </span>
            </button>
          </div>
        );
      })}
    </>
  );
}
