import type { PlacedFurniture, Seat } from './types.js';
import { TileType } from './types.js';

export interface RoomBounds {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

export type MeetingRoomSizeTier = 'small' | 'medium' | 'large';

export interface MeetingRoomSlot {
  id: string;
  label: string;
  sizeTier: MeetingRoomSizeTier;
  capacity: number;
  bounds: RoomBounds;
  bannerCol: number;
  bannerRow: number;
  seatIds: string[];
}

export interface MeetingRoomAgentInput {
  id: number;
  palette: number;
  directoryName?: string;
  providerId?: string;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  isReviewer?: boolean;
  isActive?: boolean;
}

export interface MeetingRoomSubagentInput {
  id: number;
  parentAgentId: number;
  label: string;
  palette: number;
  isActive?: boolean;
}

export interface MeetingRoomMemberInfo {
  id: number;
  isSubagent: boolean;
  isLead: boolean;
  isReviewer: boolean;
  isActive: boolean;
  roleName: string;
  roomId: string;
  roomPrimaryTask: string;
  palette: number;
  providerId?: string;
  directoryName?: string;
}

export interface MeetingRoomModel {
  id: string;
  kind: 'subagent' | 'multi-session';
  primaryTask: string;
  leadAgentId: number;
  isCrossVendor: boolean;
  isActive: boolean;
  members: MeetingRoomMemberInfo[];
  slot: MeetingRoomSlot | null;
}

const DEFAULT_CAST_NAMES = ['Suit', 'Dress', 'Spike', 'Aura', 'Tidy', 'Bob'] as const;

export function isMeetingRoomSeatUid(uid: string | null | undefined): boolean {
  if (!uid) return false;
  return uid.startsWith('mr1-chair-') || uid.startsWith('mr2-chair-');
}

export function resolveCastCharacterName(
  palette: number,
  castNames: readonly (string | undefined)[] = DEFAULT_CAST_NAMES,
): string {
  const idx = Math.abs(Math.trunc(palette));
  const candidate = idx < castNames.length ? castNames[idx]?.trim() : undefined;
  if (candidate) {
    return candidate;
  }
  return DEFAULT_CAST_NAMES[idx % DEFAULT_CAST_NAMES.length];
}

export function parseDirectoryLabel(label: string | undefined): {
  project: string | null;
  taskTitle: string | null;
} {
  if (!label) return { project: null, taskTitle: null };
  const trimmed = label.trim();
  if (!trimmed) return { project: null, taskTitle: null };

  const sepIdx = trimmed.indexOf(' · ');
  if (sepIdx !== -1) {
    const project = trimmed.slice(0, sepIdx).trim() || null;
    const taskTitle = trimmed.slice(sepIdx + 3).trim() || null;
    return { project, taskTitle };
  }

  if (/^(Chat|Sub|Subagent)\s+[0-9a-f]{6,}$/i.test(trimmed)) {
    return { project: null, taskTitle: trimmed };
  }

  return { project: trimmed, taskTitle: null };
}

function trailingChairOrder(uid: string, prefix: string): number {
  const num = Number.parseInt(uid.slice(prefix.length), 10);
  return Number.isFinite(num) ? num : Number.MAX_SAFE_INTEGER;
}

function collectOrderedSeats(seats: ReadonlyMap<string, Seat>, prefix: string): string[] {
  const matching: string[] = [];
  for (const uid of seats.keys()) {
    if (uid.startsWith(prefix)) matching.push(uid);
  }
  matching.sort(
    (a, b) => trailingChairOrder(a, prefix) - trailingChairOrder(b, prefix) || a.localeCompare(b),
  );
  return matching;
}

function sizeTierForCapacity(capacity: number): MeetingRoomSizeTier {
  if (capacity <= 4) return 'small';
  if (capacity <= 8) return 'medium';
  return 'large';
}

function conferenceRoomLabel(tier: MeetingRoomSizeTier, code: string): string {
  const prefix = tier === 'large' ? '大型會議室' : tier === 'medium' ? '中型會議室' : '小型會議室';
  return `${prefix} ${code}`;
}

function detectConferenceDividerCol(
  layout: { cols: number; rows: number; tiles?: readonly number[] },
  mr1SeatCount: number,
): number {
  if (layout.tiles && layout.tiles.length === layout.cols * layout.rows && layout.rows > 4) {
    const minScan = 8;
    const maxScan = Math.min(15, layout.cols - 3);
    for (let col = minScan; col <= maxScan; col++) {
      if (layout.tiles[4 * layout.cols + col] === TileType.WALL) {
        return col;
      }
    }
  }
  return mr1SeatCount >= 9 ? 12 : 10;
}

export function detectMeetingRoomSlots(
  layout: {
    cols: number;
    rows: number;
    tiles?: readonly number[];
    furniture: readonly PlacedFurniture[];
  },
  seats: ReadonlyMap<string, Seat>,
): MeetingRoomSlot[] {
  const slots: MeetingRoomSlot[] = [];

  const mr1Seats = collectOrderedSeats(seats, 'mr1-chair-');
  const mr2Seats = collectOrderedSeats(seats, 'mr2-chair-');
  const dividerCol = detectConferenceDividerCol(layout, mr1Seats.length);

  if (mr1Seats.length > 0) {
    const minCol = 1;
    const maxCol = Math.max(minCol, dividerCol - 1);
    const sizeTier = sizeTierForCapacity(mr1Seats.length);
    slots.push({
      id: 'mr1',
      label: conferenceRoomLabel(sizeTier, 'A'),
      sizeTier,
      capacity: mr1Seats.length,
      bounds: { minCol, maxCol, minRow: 2, maxRow: 7 },
      bannerCol: (minCol + maxCol + 1) / 2,
      bannerRow: 1.1,
      seatIds: mr1Seats,
    });
  }

  if (mr2Seats.length > 0) {
    const minCol = dividerCol + 1;
    const maxCol = Math.max(minCol, Math.min(layout.cols - 2, 18));
    const sizeTier = sizeTierForCapacity(mr2Seats.length);
    slots.push({
      id: 'mr2',
      label: conferenceRoomLabel(sizeTier, 'B'),
      sizeTier,
      capacity: mr2Seats.length,
      bounds: { minCol, maxCol, minRow: 2, maxRow: 7 },
      bannerCol: (minCol + maxCol + 1) / 2,
      bannerRow: 1.1,
      seatIds: mr2Seats,
    });
  }

  // Fallback 3rd slot: lounge around COFFEE_TABLE + surrounding SOFA seats
  const coffeeTables = layout.furniture.filter((f) => f.type.startsWith('COFFEE_TABLE'));
  const sofas = layout.furniture.filter((f) => f.type.startsWith('SOFA'));
  if (coffeeTables.length > 0 && sofas.length > 0) {
    for (const coffee of coffeeTables) {
      const loungeSeats: Seat[] = [];
      for (const seat of seats.values()) {
        if (isMeetingRoomSeatUid(seat.uid)) continue;
        const belongsToSofa = sofas.some(
          (s) => seat.uid === s.uid || seat.uid.startsWith(`${s.uid}:`),
        );
        if (!belongsToSofa) continue;
        const dist =
          Math.abs(seat.seatCol - (coffee.col + 0.5)) + Math.abs(seat.seatRow - (coffee.row + 0.5));
        if (dist <= 3) {
          loungeSeats.push(seat);
        }
      }
      if (loungeSeats.length >= 3) {
        loungeSeats.sort((a, b) => a.uid.localeCompare(b.uid));
        let minCol = coffee.col;
        let maxCol = coffee.col + 1;
        let minRow = coffee.row;
        let maxRow = coffee.row + 1;
        for (const s of loungeSeats) {
          minCol = Math.min(minCol, s.seatCol);
          maxCol = Math.max(maxCol, s.seatCol);
          minRow = Math.min(minRow, s.seatRow);
          maxRow = Math.max(maxRow, s.seatRow);
        }
        const capacity = loungeSeats.length;
        slots.push({
          id: 'lounge',
          label: '交誼討論區',
          sizeTier: sizeTierForCapacity(capacity),
          capacity,
          bounds: {
            minCol: Math.max(1, minCol - 1),
            maxCol: Math.min(layout.cols - 2, maxCol + 1),
            minRow: Math.max(1, minRow - 1),
            maxRow: Math.min(layout.rows - 2, maxRow + 1),
          },
          bannerCol: (minCol + maxCol + 1) / 2,
          bannerRow: Math.max(0.8, minRow - 0.35),
          seatIds: loungeSeats.map((s) => s.uid),
        });
        break;
      }
    }
  }

  return slots;
}

interface RawMember {
  id: number;
  isSubagent: boolean;
  isReviewer?: boolean;
  isActive?: boolean;
  palette: number;
  directoryName?: string;
  providerId?: string;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  subagentLabel?: string;
}

function memberSortRank(m: RawMember): number {
  if (m.isReviewer) return 1;
  if (m.isSubagent) return 2;
  return 0;
}

function finalizeRoom(
  id: string,
  kind: 'subagent' | 'multi-session',
  primaryTask: string,
  lead: RawMember,
  rawMembers: readonly RawMember[],
  castNames: readonly (string | undefined)[],
): MeetingRoomModel {
  const ordered = [
    lead,
    ...rawMembers
      .filter((m) => m.id !== lead.id)
      .sort((a, b) => memberSortRank(a) - memberSortRank(b) || a.id - b.id),
  ];

  const counts = new Map<string, number>();
  const members: MeetingRoomMemberInfo[] = ordered.map((m) => {
    const explicitRole = m.agentName?.trim();
    const compactSubLabel =
      m.isSubagent && m.subagentLabel?.trim() && m.subagentLabel.trim().length <= 24
        ? m.subagentLabel.trim()
        : '';
    const baseName =
      explicitRole || compactSubLabel || resolveCastCharacterName(m.palette, castNames);
    const seen = (counts.get(baseName) ?? 0) + 1;
    counts.set(baseName, seen);
    const roleName = seen === 1 ? baseName : `${baseName} #${seen}`;

    return {
      id: m.id,
      isSubagent: m.isSubagent,
      isLead: m.id === lead.id,
      isReviewer: Boolean(m.isReviewer),
      isActive: Boolean(m.isActive),
      roleName,
      roomId: id,
      roomPrimaryTask: primaryTask,
      palette: m.palette,
      providerId: m.providerId,
      directoryName: m.directoryName,
    };
  });

  const distinctProviders = new Set(members.map((m) => m.providerId).filter(Boolean));
  const isCrossVendor = members.some((m) => m.isReviewer) || distinctProviders.size >= 2;
  const isActive = members.some((m) => m.isActive);

  return {
    id,
    kind,
    primaryTask,
    leadAgentId: lead.id,
    isCrossVendor,
    isActive,
    members,
    slot: null,
  };
}

function slotCapacity(slot: MeetingRoomSlot): number {
  return typeof slot.capacity === 'number' ? slot.capacity : slot.seatIds.length;
}

/**
 * Assign meeting rooms to physical slots (active & cross-vendor priority + best-fit capacity):
 * - Active rooms and cross-vendor reviews reserve dedicated rooms before idle rooms.
 * - Larger meetings reserve larger rooms first within the same priority tier.
 * - Dedicated conference rooms (`mr1`, `mr2`) take priority over the fallback `lounge`.
 * - Among free rooms in the pool that fit `members.length`, pick the smallest room;
 *   if none fits cleanly, pick the largest room to minimize overflow.
 */
function assignSlotsByCapacity(rooms: MeetingRoomModel[], slots: readonly MeetingRoomSlot[]): void {
  if (rooms.length === 0 || slots.length === 0) return;

  const assignOrder = rooms
    .map((room, index) => ({ room, index }))
    .sort((a, b) => {
      if (a.room.isActive !== b.room.isActive) {
        return a.room.isActive ? -1 : 1;
      }
      if (a.room.isCrossVendor !== b.room.isCrossVendor) {
        return a.room.isCrossVendor ? -1 : 1;
      }
      if (b.room.members.length !== a.room.members.length) {
        return b.room.members.length - a.room.members.length;
      }
      if (a.room.kind !== b.room.kind) {
        return a.room.kind === 'subagent' ? -1 : 1;
      }
      return a.index - b.index;
    });

  const usedSlotIds = new Set<string>();

  for (const { room } of assignOrder) {
    const available = slots.filter((s) => !usedSlotIds.has(s.id));
    if (available.length === 0) break;

    const dedicated = available.filter((s) => s.id !== 'lounge');
    const pool = dedicated.length > 0 ? dedicated : available;

    const fitting = pool.filter((s) => slotCapacity(s) >= room.members.length);
    let chosen: MeetingRoomSlot;
    if (fitting.length > 0) {
      chosen = fitting.reduce((best, curr) =>
        slotCapacity(curr) < slotCapacity(best) ? curr : best,
      );
    } else {
      chosen = pool.reduce((best, curr) => (slotCapacity(curr) > slotCapacity(best) ? curr : best));
    }

    room.slot = chosen;
    usedSlotIds.add(chosen.id);
  }
}

export function buildMeetingRooms(params: {
  agents: readonly MeetingRoomAgentInput[];
  subagents: readonly MeetingRoomSubagentInput[];
  castNames?: readonly (string | undefined)[];
  slots: readonly MeetingRoomSlot[];
}): MeetingRoomModel[] {
  const castNames = params.castNames ?? DEFAULT_CAST_NAMES;
  const allNodes = new Map<number, RawMember>();

  for (const a of params.agents) {
    allNodes.set(a.id, {
      id: a.id,
      isSubagent: false,
      isReviewer: a.isReviewer,
      isActive: a.isActive,
      palette: a.palette,
      directoryName: a.directoryName,
      providerId: a.providerId,
      teamName: a.teamName,
      agentName: a.agentName,
      isTeamLead: a.isTeamLead,
      leadAgentId: a.leadAgentId,
    });
  }
  for (const s of params.subagents) {
    if (allNodes.has(s.id)) continue;
    allNodes.set(s.id, {
      id: s.id,
      isSubagent: true,
      isActive: s.isActive ?? true,
      palette: s.palette,
      leadAgentId: s.parentAgentId,
      subagentLabel: s.label,
    });
  }

  // Union-find across connected agent/subagent/team nodes
  const parent = new Map<number, number>();
  for (const id of allNodes.keys()) parent.set(id, id);

  const find = (x: number): number => {
    let curr = x;
    while (parent.get(curr) !== curr) {
      const next = parent.get(curr)!;
      parent.set(curr, parent.get(next)!);
      curr = next;
    }
    return curr;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const node of allNodes.values()) {
    if (node.leadAgentId !== undefined && allNodes.has(node.leadAgentId)) {
      union(node.id, node.leadAgentId);
    }
  }

  const byTeamName = new Map<string, number[]>();
  for (const node of allNodes.values()) {
    if (node.isSubagent) continue;
    const t = node.teamName?.trim();
    if (!t) continue;
    const arr = byTeamName.get(t) ?? [];
    arr.push(node.id);
    byTeamName.set(t, arr);
  }
  for (const ids of byTeamName.values()) {
    for (let i = 1; i < ids.length; i++) {
      union(ids[0], ids[i]);
    }
  }

  const components = new Map<number, RawMember[]>();
  for (const node of allNodes.values()) {
    const root = find(node.id);
    const list = components.get(root) ?? [];
    list.push(node);
    components.set(root, list);
  }

  const rooms: MeetingRoomModel[] = [];
  const groupedAgentIds = new Set<number>();

  // Priority 1: Subagent / Team collaboration rooms
  for (const members of components.values()) {
    if (members.length < 2) continue;
    const mainMembers = members.filter((m) => !m.isSubagent).sort((a, b) => a.id - b.id);
    const lead =
      mainMembers.find((m) => m.isTeamLead) ??
      mainMembers.find((m) => m.leadAgentId === undefined) ??
      mainMembers[0] ??
      [...members].sort((a, b) => a.id - b.id)[0];

    const parsedLead = parseDirectoryLabel(lead.directoryName);
    const teamTitle = members.find((m) => m.teamName?.trim())?.teamName?.trim();
    const primaryTask = parsedLead.taskTitle || teamTitle || parsedLead.project || '協作任務';

    for (const m of members) groupedAgentIds.add(m.id);
    rooms.push(
      finalizeRoom(`subagent-${lead.id}`, 'subagent', primaryTask, lead, members, castNames),
    );
  }

  // Priority 2: Multi-session rooms grouped by shared workspace project
  const byProject = new Map<string, { projectDisplay: string; members: RawMember[] }>();
  for (const node of allNodes.values()) {
    if (node.isSubagent || groupedAgentIds.has(node.id)) continue;
    const parsed = parseDirectoryLabel(node.directoryName);
    if (!parsed.project) continue;
    const key = parsed.project.toLowerCase();
    const bucket = byProject.get(key);
    if (bucket) {
      bucket.members.push(node);
    } else {
      byProject.set(key, { projectDisplay: parsed.project, members: [node] });
    }
  }

  for (const [projKey, bucket] of byProject.entries()) {
    if (bucket.members.length < 2) continue;
    const ordered = [...bucket.members].sort((a, b) => a.id - b.id);
    const lead = ordered[0];
    const parsedLead = parseDirectoryLabel(lead.directoryName);
    const primaryTask =
      parsedLead.taskTitle &&
      parsedLead.taskTitle.toLowerCase() !== bucket.projectDisplay.toLowerCase()
        ? `${bucket.projectDisplay} · ${parsedLead.taskTitle}`
        : bucket.projectDisplay;

    rooms.push(
      finalizeRoom(`multi-${projKey}`, 'multi-session', primaryTask, lead, ordered, castNames),
    );
  }

  rooms.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'subagent' ? -1 : 1;
    return a.leadAgentId - b.leadAgentId || a.id.localeCompare(b.id);
  });

  assignSlotsByCapacity(rooms, params.slots);

  return rooms;
}

export function indexMeetingRoomMembers(
  rooms: readonly MeetingRoomModel[],
): Map<number, MeetingRoomMemberInfo> {
  const map = new Map<number, MeetingRoomMemberInfo>();
  for (const room of rooms) {
    for (const member of room.members) {
      map.set(member.id, member);
    }
  }
  return map;
}
