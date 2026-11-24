import { useCallback, useEffect, useMemo } from 'react';

import type { OfficeState } from '../office/engine/officeState.js';
import {
  buildMeetingRooms,
  detectMeetingRoomSlots,
  indexMeetingRoomMembers,
  type MeetingRoomMemberInfo,
  type MeetingRoomModel,
  type MeetingRoomSlot,
} from '../office/meetingRooms.js';
import { TILE_SIZE, type ToolActivity } from '../office/types.js';
import type { AgentTeamState, SubagentCharacter } from './useExtensionMessages.js';

interface UseMeetingRoomsInput {
  getOfficeState: () => OfficeState;
  agents: number[];
  agentDirectoryMap: Record<number, string>;
  agentProviders: Record<number, string>;
  agentTeams: Record<number, AgentTeamState>;
  agentStatuses: Record<number, string>;
  agentTools: Record<number, ToolActivity[]>;
  subagentCharacters: SubagentCharacter[];
  castNames: readonly (string | undefined)[];
  layoutReady: boolean;
  editorTick: number;
  isCompactMode: boolean;
}

export interface MeetingRoomsController {
  slots: MeetingRoomSlot[];
  rooms: MeetingRoomModel[];
  membersById: Map<number, MeetingRoomMemberInfo>;
  focusRoom: (roomId: string) => void;
}

export function useMeetingRooms({
  getOfficeState,
  agents,
  agentDirectoryMap,
  agentProviders,
  agentTeams,
  agentStatuses,
  agentTools,
  subagentCharacters,
  castNames,
  layoutReady,
  editorTick,
  isCompactMode,
}: UseMeetingRoomsInput): MeetingRoomsController {
  const slots = useMemo(() => {
    if (!layoutReady && editorTick < 0) return [];
    const os = getOfficeState();
    return detectMeetingRoomSlots(os.getLayout(), os.seats);
  }, [getOfficeState, layoutReady, editorTick]);

  const rooms = useMemo(() => {
    if (!layoutReady && agents.length === 0) return [];
    const os = getOfficeState();
    return buildMeetingRooms({
      agents: agents.map((id) => {
        const ch = os.characters.get(id);
        const team = agentTeams[id];
        const hasOpenTool = agentTools[id]?.some((t) => !t.done) ?? false;
        const statusActive = agentStatuses[id] !== undefined && agentStatuses[id] !== 'waiting';
        return {
          id,
          palette: ch?.palette ?? 0,
          directoryName: agentDirectoryMap[id] ?? ch?.directoryName,
          providerId: agentProviders[id] ?? ch?.providerId,
          teamName: team?.teamName ?? ch?.teamName,
          agentName: team?.agentName ?? ch?.agentName,
          isTeamLead: team?.isTeamLead ?? ch?.isTeamLead,
          leadAgentId: team?.leadAgentId ?? ch?.leadAgentId,
          isReviewer: team?.isReviewer ?? ch?.isReviewer,
          isActive: hasOpenTool || statusActive || Boolean(ch?.isActive),
        };
      }),
      subagents: subagentCharacters.map((s) => ({
        id: s.id,
        parentAgentId: s.parentAgentId,
        label: s.label,
        palette:
          os.characters.get(s.id)?.palette ?? os.characters.get(s.parentAgentId)?.palette ?? 0,
      })),
      castNames,
      slots,
    });
  }, [
    getOfficeState,
    layoutReady,
    agents,
    agentDirectoryMap,
    agentProviders,
    agentTeams,
    agentStatuses,
    agentTools,
    subagentCharacters,
    castNames,
    slots,
  ]);

  const membersById = useMemo(() => indexMeetingRoomMembers(rooms), [rooms]);

  useEffect(() => {
    if (!layoutReady || isCompactMode) return;
    getOfficeState().syncMeetingRoomSeating(rooms, slots);
  }, [getOfficeState, layoutReady, isCompactMode, rooms, slots]);

  const focusRoom = useCallback(
    (roomId: string) => {
      const room = rooms.find((r) => r.id === roomId);
      if (!room?.slot) return;
      const { minCol, maxCol, minRow, maxRow } = room.slot.bounds;
      const cx = ((minCol + maxCol + 1) / 2) * TILE_SIZE;
      const cy = ((minRow + maxRow + 1) / 2) * TILE_SIZE;
      getOfficeState().focusWorldPoint(cx, cy);
    },
    [getOfficeState, rooms],
  );

  return { slots, rooms, membersById, focusRoom };
}
