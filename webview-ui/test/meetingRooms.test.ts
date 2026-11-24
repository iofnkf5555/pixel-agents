import { beforeAll, describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import {
  buildMeetingRooms,
  detectMeetingRoomSlots,
  indexMeetingRoomMembers,
  type MeetingRoomSlot,
  parseDirectoryLabel,
} from '../src/office/meetingRooms.js';
import type { OfficeLayout, Seat, SpriteData } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

type CatalogAsset = LoadedAssetData['catalog'][number];

function makeAsset(
  id: string,
  category: string,
  footprintW: number,
  footprintH: number,
  extra: Partial<CatalogAsset> = {},
): CatalogAsset {
  return {
    id,
    label: id,
    category,
    width: footprintW * 16,
    height: footprintH * 16,
    footprintW,
    footprintH,
    isDesk: category === 'desks',
    canPlaceOnWalls: false,
    ...extra,
  };
}

describe('meetingRooms', () => {
  beforeAll(() => {
    const emptySprite: SpriteData = Array.from({ length: 16 }, () => Array<string>(16).fill(''));
    const catalog = [
      makeAsset('CUSHIONED_CHAIR_SIDE', 'chairs', 1, 1, { orientation: 'side' }),
      makeAsset('CUSHIONED_CHAIR_FRONT', 'chairs', 1, 1, { orientation: 'front' }),
      makeAsset('DESK_FRONT', 'desks', 3, 2, { backgroundTiles: 1 }),
    ];
    const sprites: Record<string, SpriteData> = {};
    for (const c of catalog) sprites[c.id] = emptySprite;
    buildDynamicCatalog({ catalog, sprites });
  });

  it('parses directoryName labels for project and primary task extraction', () => {
    expect(parseDirectoryLabel('visionai · Build Meeting Room')).toEqual({
      project: 'visionai',
      taskTitle: 'Build Meeting Room',
    });
    expect(parseDirectoryLabel('visionai')).toEqual({
      project: 'visionai',
      taskTitle: null,
    });
    expect(parseDirectoryLabel('Chat a1b2c3d4')).toEqual({
      project: null,
      taskTitle: 'Chat a1b2c3d4',
    });
    expect(parseDirectoryLabel('Sub e73985e6')).toEqual({
      project: null,
      taskTitle: 'Sub e73985e6',
    });
  });

  it('detects mr1, mr2, and coffee-table lounge slots with sizeTier and capacity', () => {
    const tiles = new Array<TileType>(21 * 22).fill(TileType.FLOOR_1);
    tiles[4 * 21 + 12] = TileType.WALL;
    const layout: OfficeLayout = {
      version: 1,
      cols: 21,
      rows: 22,
      tiles,
      furniture: [
        { uid: 'mr1-chair-1', type: 'CUSHIONED_CHAIR_SIDE', col: 2, row: 5 },
        { uid: 'mr1-chair-2', type: 'CUSHIONED_CHAIR_FRONT', col: 5, row: 4 },
        { uid: 'mr2-chair-1', type: 'CUSHIONED_CHAIR_SIDE', col: 14, row: 5 },
        { uid: 'coffee-tbl', type: 'COFFEE_TABLE', col: 14, row: 14 },
        { uid: 'sofa-top', type: 'SOFA_FRONT', col: 14, row: 13 },
        { uid: 'sofa-side', type: 'SOFA_SIDE', col: 13, row: 14 },
      ],
    };
    const seats = new Map<string, Seat>([
      [
        'mr1-chair-2',
        { uid: 'mr1-chair-2', seatCol: 5, seatRow: 4, facingDir: Direction.DOWN, assigned: false },
      ],
      [
        'mr1-chair-1',
        { uid: 'mr1-chair-1', seatCol: 2, seatRow: 5, facingDir: Direction.RIGHT, assigned: false },
      ],
      [
        'mr2-chair-1',
        {
          uid: 'mr2-chair-1',
          seatCol: 14,
          seatRow: 5,
          facingDir: Direction.RIGHT,
          assigned: false,
        },
      ],
      [
        'sofa-top',
        { uid: 'sofa-top', seatCol: 14, seatRow: 13, facingDir: Direction.DOWN, assigned: false },
      ],
      [
        'sofa-top:1',
        { uid: 'sofa-top:1', seatCol: 15, seatRow: 13, facingDir: Direction.DOWN, assigned: false },
      ],
      [
        'sofa-side',
        { uid: 'sofa-side', seatCol: 13, seatRow: 14, facingDir: Direction.RIGHT, assigned: false },
      ],
    ]);

    const slots = detectMeetingRoomSlots(layout, seats);
    expect(slots.map((s) => s.id)).toEqual(['mr1', 'mr2', 'lounge']);
    expect(slots[0].seatIds).toEqual(['mr1-chair-1', 'mr1-chair-2']);
    expect(slots[0].bounds).toEqual({ minCol: 1, maxCol: 11, minRow: 2, maxRow: 7 });
    expect(slots[1].bounds).toEqual({ minCol: 13, maxCol: 18, minRow: 2, maxRow: 7 });
    expect(slots[0].capacity).toBe(2);
    expect(slots[0].sizeTier).toBe('small');
  });

  it('assigns rooms by capacity (small 2-4p -> small room mr2; large 5+p -> large room mr1)', () => {
    const slots: MeetingRoomSlot[] = [
      {
        id: 'mr1',
        label: '大型會議室 A',
        sizeTier: 'large',
        capacity: 12,
        bounds: { minCol: 1, maxCol: 11, minRow: 2, maxRow: 7 },
        bannerCol: 6.5,
        bannerRow: 1.1,
        seatIds: Array.from({ length: 12 }, (_, i) => `mr1-chair-${i + 1}`),
      },
      {
        id: 'mr2',
        label: '小型會議室 B',
        sizeTier: 'small',
        capacity: 4,
        bounds: { minCol: 13, maxCol: 18, minRow: 2, maxRow: 7 },
        bannerCol: 16,
        bannerRow: 1.1,
        seatIds: Array.from({ length: 4 }, (_, i) => `mr2-chair-${i + 1}`),
      },
    ];

    // 1. Small 3-person meeting alone -> picks Small room mr2 (capacity 4)
    const smallOnly = buildMeetingRooms({
      agents: [
        { id: 1, palette: 0, directoryName: 'projA · Quick Sync', isTeamLead: true },
        { id: 2, palette: 1, leadAgentId: 1, agentName: 'Coder' },
        { id: 3, palette: 2, leadAgentId: 1, agentName: 'Tester' },
      ],
      subagents: [],
      slots,
    });
    expect(smallOnly[0].slot?.id).toBe('mr2');

    // 2. Large 6-person meeting alone -> picks Large room mr1 (capacity 12)
    const largeOnly = buildMeetingRooms({
      agents: [
        { id: 1, palette: 0, directoryName: 'projB · Big Architecture', isTeamLead: true },
        { id: 2, palette: 1, leadAgentId: 1 },
        { id: 3, palette: 2, leadAgentId: 1 },
        { id: 4, palette: 3, leadAgentId: 1 },
        { id: 5, palette: 4, leadAgentId: 1 },
        { id: 6, palette: 5, leadAgentId: 1 },
      ],
      subagents: [],
      slots,
    });
    expect(largeOnly[0].slot?.id).toBe('mr1');

    // 3. Simultaneous 2-person room + 6-person room -> 6-person gets mr1, 2-person gets mr2
    const combined = buildMeetingRooms({
      agents: [
        { id: 1, palette: 0, directoryName: 'smallProj · Small Task', isTeamLead: true },
        { id: 2, palette: 1, leadAgentId: 1 },
        { id: 10, palette: 2, directoryName: 'bigProj · Large Task', isTeamLead: true },
        { id: 11, palette: 3, leadAgentId: 10 },
        { id: 12, palette: 4, leadAgentId: 10 },
        { id: 13, palette: 5, leadAgentId: 10 },
        { id: 14, palette: 0, leadAgentId: 10 },
        { id: 15, palette: 1, leadAgentId: 10 },
      ],
      subagents: [],
      slots,
    });
    const smallRoom = combined.find((r) => r.leadAgentId === 1)!;
    const bigRoom = combined.find((r) => r.leadAgentId === 10)!;
    expect(bigRoom.slot?.id).toBe('mr1');
    expect(smallRoom.slot?.id).toBe('mr2');
  });

  it('groups subagent trees and same-project multi-sessions with Primary Task and unique role names', () => {
    const slots: MeetingRoomSlot[] = [
      {
        id: 'mr1',
        label: '會議室 A',
        sizeTier: 'small',
        capacity: 3,
        bounds: { minCol: 1, maxCol: 9, minRow: 2, maxRow: 7 },
        bannerCol: 5,
        bannerRow: 1.1,
        seatIds: ['mr1-chair-1', 'mr1-chair-2', 'mr1-chair-3'],
      },
      {
        id: 'mr2',
        label: '會議室 B',
        sizeTier: 'small',
        capacity: 2,
        bounds: { minCol: 11, maxCol: 18, minRow: 2, maxRow: 7 },
        bannerCol: 14.5,
        bannerRow: 1.1,
        seatIds: ['mr2-chair-1', 'mr2-chair-2'],
      },
    ];

    const rooms = buildMeetingRooms({
      agents: [
        { id: 1, palette: 0, directoryName: 'visionai · Build Meeting Room', isTeamLead: true },
        { id: 2, palette: 0, leadAgentId: 1, directoryName: 'visionai' }, // no agentName, same palette as lead -> Suit #2
        { id: 3, palette: 1, leadAgentId: 1, agentName: 'Auditor', directoryName: 'visionai' },
        { id: 4, palette: 2, directoryName: 'backend · Auth Refactor' },
        { id: 5, palette: 3, directoryName: 'backend · SQL Pool' },
        { id: 6, palette: 4, directoryName: 'solo-repo · Bugfix' },
        { id: 7, palette: 5, directoryName: 'Chat 11223344' },
        { id: 8, palette: 5, directoryName: 'Chat aabbccdd' },
      ],
      subagents: [{ id: -1, parentAgentId: 1, label: 'Scanner', palette: 4 }],
      castNames: ['Suit', 'Dress', 'Spike', 'Aura', 'Tidy', 'Bob'],
      slots,
    });

    expect(rooms.length).toBe(2);

    const subRoom = rooms[0];
    expect(subRoom.kind).toBe('subagent');
    expect(subRoom.primaryTask).toBe('Build Meeting Room');
    expect(subRoom.slot?.id).toBe('mr1');
    expect(
      subRoom.members.map((m) => ({ id: m.id, isLead: m.isLead, roleName: m.roleName })),
    ).toEqual([
      { id: 1, isLead: true, roleName: 'Suit' },
      { id: 2, isLead: false, roleName: 'Suit #2' },
      { id: 3, isLead: false, roleName: 'Auditor' },
      { id: -1, isLead: false, roleName: 'Scanner' },
    ]);

    const multiRoom = rooms[1];
    expect(multiRoom.kind).toBe('multi-session');
    expect(multiRoom.primaryTask).toBe('backend · Auth Refactor');
    expect(multiRoom.slot?.id).toBe('mr2');
    expect(multiRoom.members.map((m) => m.roleName)).toEqual(['Spike', 'Aura']);

    const byMember = indexMeetingRoomMembers(rooms);
    expect(byMember.has(6)).toBe(false);
    expect(byMember.has(7)).toBe(false);
    expect(byMember.has(8)).toBe(false);
    expect(byMember.get(3)?.roleName).toBe('Auditor');
  });

  it('keeps meeting room characters seated without wandering while idle and restores solo desk on dissolve', () => {
    const tiles = new Array<TileType>(21 * 18).fill(TileType.FLOOR_1);
    tiles[4 * 21 + 12] = TileType.WALL;
    const layout: OfficeLayout = {
      version: 1,
      cols: 21,
      rows: 18,
      tiles,
      furniture: [
        { uid: 'mr1-chair-1', type: 'CUSHIONED_CHAIR_SIDE', col: 2, row: 5 },
        { uid: 'mr1-chair-2', type: 'CUSHIONED_CHAIR_FRONT', col: 5, row: 4 },
        { uid: 'mr1-chair-3', type: 'CUSHIONED_CHAIR_SIDE', col: 6, row: 5 },
        { uid: 'mr1-chair-4', type: 'CUSHIONED_CHAIR_FRONT', col: 4, row: 4 },
        { uid: 'mr1-chair-5', type: 'CUSHIONED_CHAIR_FRONT', col: 3, row: 4 },
        { uid: 'mr2-chair-1', type: 'CUSHIONED_CHAIR_SIDE', col: 14, row: 5 },
        { uid: 'mr2-chair-2', type: 'CUSHIONED_CHAIR_FRONT', col: 15, row: 4 },
        { uid: 'desk-chair-1', type: 'CUSHIONED_CHAIR_FRONT', col: 4, row: 12 },
        { uid: 'desk-chair-2', type: 'CUSHIONED_CHAIR_FRONT', col: 6, row: 12 },
      ],
    };

    const os = new OfficeState(layout);
    os.addAgent(1, 0, 0, undefined, true, 'proj · Task');
    os.addAgent(2, 1, 0, undefined, true, 'proj · Sub');
    // Both solo agents initially prefer regular office desks (not mr1-chair-*/mr2-chair-*)
    expect(os.characters.get(1)?.seatId?.startsWith('desk-chair-')).toBe(true);
    expect(os.characters.get(2)?.seatId?.startsWith('desk-chair-')).toBe(true);

    const slots = detectMeetingRoomSlots(layout, os.seats);
    const rooms = buildMeetingRooms({
      agents: [
        { id: 1, palette: 0, directoryName: 'proj · Task', isTeamLead: true },
        { id: 2, palette: 1, leadAgentId: 1, agentName: 'Researcher', directoryName: 'proj · Sub' },
      ],
      subagents: [],
      slots,
    });

    // 2 participants -> assigned to Small Room mr2 (2 seats) instead of 5-seat mr1
    expect(rooms[0].slot?.id).toBe('mr2');

    os.syncMeetingRoomSeating(rooms, slots);
    expect(os.characters.get(1)?.seatId).toBe('mr2-chair-1');
    expect(os.characters.get(2)?.seatId).toBe('mr2-chair-2');
    expect(os.characters.get(1)?.inMeetingRoom).toBe(true);
    expect(os.characters.get(2)?.inMeetingRoom).toBe(true);

    // Simulate walking into seats and then turning inactive for > 60s
    for (let i = 0; i < 150; i++) os.update(0.1);
    os.setAgentActive(1, false);
    os.setAgentActive(2, false);

    for (let i = 0; i < 650; i++) {
      os.update(0.1);
    }

    const ch1 = os.characters.get(1)!;
    const ch2 = os.characters.get(2)!;
    const seat1 = os.seats.get('mr2-chair-1')!;
    const seat2 = os.seats.get('mr2-chair-2')!;
    expect(ch1.state).toBe(CharacterState.TYPE);
    expect(ch1.isActive).toBe(false);
    expect(ch1.tileCol).toBe(seat1.seatCol);
    expect(ch1.tileRow).toBe(seat1.seatRow);
    expect(ch2.state).toBe(CharacterState.TYPE);
    expect(ch2.isActive).toBe(false);
    expect(ch2.tileCol).toBe(seat2.seatCol);
    expect(ch2.tileRow).toBe(seat2.seatRow);

    // Group dissolves (agent 2 leaves) -> agent 1 returns to a regular office desk & wandering resumes
    os.removeAgent(2);
    os.syncMeetingRoomSeating([], slots);
    expect(os.characters.get(1)?.inMeetingRoom).toBe(false);
    expect(os.characters.get(1)?.seatId?.startsWith('desk-chair-')).toBe(true);
  });

  it('seats solo host + cross-vendor synthetic reviewer in Small room with isCrossVendor and reviewer role', () => {
    const slots: MeetingRoomSlot[] = [
      {
        id: 'mr1',
        label: '大會議室',
        sizeTier: 'large',
        capacity: 12,
        bounds: { minCol: 1, maxCol: 11, minRow: 1, maxRow: 7 },
        bannerCol: 6,
        bannerRow: 0.9,
        seatIds: Array.from({ length: 12 }, (_, i) => `mr1-chair-${i + 1}`),
      },
      {
        id: 'mr2',
        label: '小會議室',
        sizeTier: 'small',
        capacity: 4,
        bounds: { minCol: 13, maxCol: 19, minRow: 1, maxRow: 7 },
        bannerCol: 16,
        bannerRow: 0.9,
        seatIds: Array.from({ length: 4 }, (_, i) => `mr2-chair-${i + 1}`),
      },
    ];

    const rooms = buildMeetingRooms({
      agents: [
        {
          id: 1,
          palette: 0,
          directoryName: 'visionai · Auth Cleanup',
          providerId: 'codex',
          isTeamLead: true,
        },
        {
          id: 2,
          palette: 1,
          directoryName: 'AGY Reviewer',
          providerId: 'antigravity',
          agentName: 'AGY Reviewer',
          leadAgentId: 1,
          isReviewer: true,
        },
      ],
      subagents: [],
      slots,
    });

    expect(rooms).toHaveLength(1);
    expect(rooms[0].slot?.id).toBe('mr2');
    expect(rooms[0].isCrossVendor).toBe(true);
    expect(rooms[0].primaryTask).toBe('Auth Cleanup');
    expect(rooms[0].members).toMatchObject([
      { id: 1, isLead: true, isReviewer: false, providerId: 'codex' },
      {
        id: 2,
        isLead: false,
        isReviewer: true,
        roleName: 'AGY Reviewer',
        providerId: 'antigravity',
      },
    ]);
  });

  it('groups Antigravity sessions sharing inferred project labels and prioritizes active rooms over idle Codex rooms', () => {
    const slots: MeetingRoomSlot[] = [
      {
        id: 'mr1',
        label: '大型會議室 mr1',
        sizeTier: 'large',
        capacity: 12,
        bounds: { minCol: 1, maxCol: 11, minRow: 1, maxRow: 7 },
        bannerCol: 6,
        bannerRow: 0.9,
        seatIds: Array.from({ length: 12 }, (_, i) => `mr1-chair-${i + 1}`),
      },
      {
        id: 'mr2',
        label: '小型會議室 mr2',
        sizeTier: 'small',
        capacity: 4,
        bounds: { minCol: 13, maxCol: 19, minRow: 1, maxRow: 7 },
        bannerCol: 16,
        bannerRow: 0.9,
        seatIds: Array.from({ length: 4 }, (_, i) => `mr2-chair-${i + 1}`),
      },
      {
        id: 'lounge',
        label: '休息討論區',
        sizeTier: 'small',
        capacity: 4,
        bounds: { minCol: 13, maxCol: 19, minRow: 12, maxRow: 16 },
        bannerCol: 16,
        bannerRow: 11.4,
        seatIds: Array.from({ length: 4 }, (_, i) => `lounge-${i + 1}`),
      },
    ];

    // Two idle Codex rooms (lower agent IDs 1 & 3) + one active Antigravity room (higher IDs 7 & 8)
    const rooms = buildMeetingRooms({
      agents: [
        {
          id: 1,
          palette: 0,
          directoryName: 'manifest · Fix signal',
          providerId: 'codex',
          isTeamLead: true,
          isActive: false,
        },
        {
          id: 2,
          palette: 1,
          directoryName: 'manifest · Guardian review',
          providerId: 'codex',
          leadAgentId: 1,
          agentName: 'Guardian',
          isActive: false,
        },
        {
          id: 3,
          palette: 2,
          directoryName: 'amsr · Docker guide',
          providerId: 'codex',
          isTeamLead: true,
          isActive: false,
        },
        {
          id: 4,
          palette: 3,
          directoryName: 'amsr · Guardian review',
          providerId: 'codex',
          leadAgentId: 3,
          agentName: 'Guardian',
          isActive: false,
        },
        {
          id: 7,
          palette: 4,
          directoryName: 'visionai · Chat e73985e6',
          providerId: 'antigravity',
          isActive: true,
        },
        {
          id: 8,
          palette: 5,
          directoryName: 'visionai · Chat 02e44b60',
          providerId: 'antigravity',
          isActive: false,
        },
      ],
      subagents: [],
      slots,
    });

    expect(rooms).toHaveLength(3);
    const agyRoom = rooms.find((r) => r.leadAgentId === 7)!;
    const codex1 = rooms.find((r) => r.leadAgentId === 1)!;
    const codex2 = rooms.find((r) => r.leadAgentId === 3)!;

    expect(agyRoom.kind).toBe('multi-session');
    expect(agyRoom.isActive).toBe(true);
    expect(agyRoom.primaryTask).toBe('visionai · Chat e73985e6');
    // Active Antigravity room claims Small dedicated conference room mr2 over idle Codex rooms
    expect(agyRoom.slot?.id).toBe('mr2');
    // One idle Codex room gets remaining dedicated mr1, and the second spills cleanly to lounge
    expect(codex1.slot?.id).toBe('mr1');
    expect(codex2.slot?.id).toBe('lounge');
  });
});
