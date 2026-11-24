const DEFAULT_COLS = 21;
const DEFAULT_ROWS = 22;
const VOID_TILE = 255;
const WALL_TILE = 0;
const FLOOR_TILE_ROOM_BLUE = 1;
const FLOOR_TILE_LEFT_WOOD = 7;

const WALL_COLOR = { h: 214, s: 30, b: -100, c: -55 };
const ROOM1_FLOOR_COLOR = { h: 215, s: 24, b: -32, c: -65 };
const ROOM2_FLOOR_COLOR = { h: 175, s: 22, b: -34, c: -65 };
const LEFT_OFFICE_FLOOR_COLOR = { h: 25, s: 48, b: -43, c: -88 };
const RIGHT_OFFICE_FLOOR_COLOR = { h: 209, s: 39, b: -25, c: -80 };

export const CONFERENCE_DIVIDER_COL = 12;

interface PlacedFurnitureLike {
  uid: string;
  type: string;
  col: number;
  row: number;
  color?: Record<string, unknown>;
}

const CONFERENCE_FURNITURE: readonly PlacedFurnitureLike[] = [
  // Meeting Room A — Large Room (cols 1..11, rows 2..7, doorway col 4, capacity 12)
  // WHITEBOARD hangs on row 1 wall; PLANT pot rests in corner floor (1,2) with foliage at (1,1).
  { uid: 'mr1-whiteboard', type: 'WHITEBOARD', col: 5, row: 0 },
  { uid: 'mr1-plant', type: 'PLANT', col: 1, row: 1 },
  // 3x SMALL_TABLE_FRONT across cols 3..8, tabletop solid surface sits on row 5
  { uid: 'mr1-table-1', type: 'SMALL_TABLE_FRONT', col: 3, row: 4 },
  { uid: 'mr1-table-2', type: 'SMALL_TABLE_FRONT', col: 5, row: 4 },
  { uid: 'mr1-table-3', type: 'SMALL_TABLE_FRONT', col: 7, row: 4 },
  // Coffee cups placed at row 5 (table.row + 1) so they render squarely ON the tabletop surface
  { uid: 'mr1-coffee', type: 'COFFEE', col: 4, row: 5 },
  { uid: 'mr1-coffee-2', type: 'COFFEE', col: 7, row: 5 },
  // Chairs: Lead (1) + members ordered outward from center with full perimeter walkway clearance
  { uid: 'mr1-chair-1', type: 'CUSHIONED_CHAIR_SIDE', col: 2, row: 5 },
  { uid: 'mr1-chair-2', type: 'CUSHIONED_CHAIR_FRONT', col: 5, row: 4 },
  { uid: 'mr1-chair-3', type: 'CUSHIONED_CHAIR_BACK', col: 5, row: 6 },
  { uid: 'mr1-chair-4', type: 'CUSHIONED_CHAIR_FRONT', col: 6, row: 4 },
  { uid: 'mr1-chair-5', type: 'CUSHIONED_CHAIR_BACK', col: 6, row: 6 },
  { uid: 'mr1-chair-6', type: 'CUSHIONED_CHAIR_SIDE:left', col: 9, row: 5 },
  { uid: 'mr1-chair-7', type: 'CUSHIONED_CHAIR_FRONT', col: 4, row: 4 },
  { uid: 'mr1-chair-8', type: 'CUSHIONED_CHAIR_BACK', col: 4, row: 6 },
  { uid: 'mr1-chair-9', type: 'CUSHIONED_CHAIR_FRONT', col: 7, row: 4 },
  { uid: 'mr1-chair-10', type: 'CUSHIONED_CHAIR_BACK', col: 7, row: 6 },
  { uid: 'mr1-chair-11', type: 'CUSHIONED_CHAIR_FRONT', col: 3, row: 4 },
  { uid: 'mr1-chair-12', type: 'CUSHIONED_CHAIR_BACK', col: 8, row: 6 },

  // Meeting Room B — Small Huddle Room (cols 13..18, rows 2..7, doorway col 13, capacity 4)
  { uid: 'mr2-whiteboard', type: 'WHITEBOARD', col: 15, row: 0 },
  { uid: 'mr2-plant', type: 'PLANT_2', col: 18, row: 1 },
  { uid: 'mr2-table-1', type: 'SMALL_TABLE_FRONT', col: 15, row: 4 },
  { uid: 'mr2-coffee', type: 'COFFEE', col: 15, row: 5 },
  { uid: 'mr2-chair-1', type: 'CUSHIONED_CHAIR_SIDE', col: 14, row: 5 },
  { uid: 'mr2-chair-2', type: 'CUSHIONED_CHAIR_FRONT', col: 15, row: 4 },
  { uid: 'mr2-chair-3', type: 'CUSHIONED_CHAIR_BACK', col: 16, row: 6 },
  { uid: 'mr2-chair-4', type: 'CUSHIONED_CHAIR_SIDE:left', col: 17, row: 5 },
];

function furnitureApproxWidth(type: string): number {
  if (type.startsWith('DESK_FRONT') || type.startsWith('TABLE_FRONT')) {
    return 3;
  }
  if (
    type.startsWith('DOUBLE_BOOKSHELF') ||
    type.startsWith('BOOKSHELF') ||
    type.startsWith('LARGE_PAINTING') ||
    type.startsWith('WHITEBOARD') ||
    type.startsWith('COFFEE_TABLE') ||
    type.startsWith('SMALL_TABLE_FRONT') ||
    type.startsWith('SOFA_FRONT') ||
    type.startsWith('SOFA_BACK') ||
    type.startsWith('LARGE_PLANT')
  ) {
    return 2;
  }
  return 1;
}

function furnitureApproxHeight(type: string): number {
  if (
    type.startsWith('DOUBLE_BOOKSHELF') ||
    type.startsWith('LARGE_PAINTING') ||
    type.startsWith('SMALL_PAINTING') ||
    type.startsWith('CLOCK') ||
    type.startsWith('HANGING_PLANT') ||
    type.startsWith('WHITEBOARD')
  ) {
    return 2;
  }
  if (type.startsWith('DESK_SIDE')) return 4;
  if (type.startsWith('TABLE_FRONT')) return 4;
  if (type.startsWith('SMALL_TABLE_SIDE') || type.startsWith('LARGE_PLANT')) return 3;
  if (
    type.startsWith('DESK_FRONT') ||
    type.startsWith('SMALL_TABLE_FRONT') ||
    type.startsWith('COFFEE_TABLE') ||
    type.startsWith('SOFA_SIDE') ||
    type.startsWith('WOODEN_CHAIR') ||
    type.startsWith('CACTUS') ||
    type.startsWith('PLANT')
  ) {
    return 2;
  }
  return 1;
}

function overlapsTile(furniture: readonly unknown[], col: number, row: number): boolean {
  for (const raw of furniture) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<PlacedFurnitureLike>;
    if (
      typeof item.col !== 'number' ||
      typeof item.row !== 'number' ||
      typeof item.type !== 'string'
    ) {
      continue;
    }
    const w = furnitureApproxWidth(item.type);
    const h = furnitureApproxHeight(item.type);
    if (col >= item.col && col < item.col + w && row >= item.row && row < item.row + h) {
      return true;
    }
  }
  return false;
}

function isConferenceUid(uid: unknown): boolean {
  return typeof uid === 'string' && (uid.startsWith('mr1-') || uid.startsWith('mr2-'));
}

function hasGeneratedConferenceMarkers(furniture: readonly unknown[]): boolean {
  return furniture.some(
    (item) =>
      item && typeof item === 'object' && isConferenceUid((item as PlacedFurnitureLike).uid),
  );
}

/**
 * Detect the earlier v1 conference layout that placed coffee cups on the floor (row 4),
 * front chairs detached at row 3, or both rooms equal-width with divider wall at col 10.
 */
function needsConferenceWingRepair(
  tiles: readonly number[],
  furniture: readonly unknown[],
): boolean {
  if (!hasGeneratedConferenceMarkers(furniture)) return false;

  const byUid = new Map<string, PlacedFurnitureLike>();
  let mr1ChairCount = 0;
  let mr2ChairCount = 0;
  for (const raw of furniture) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as PlacedFurnitureLike;
    if (typeof item.uid !== 'string') continue;
    byUid.set(item.uid, item);
    if (item.uid.startsWith('mr1-chair-')) mr1ChairCount += 1;
    if (item.uid.startsWith('mr2-chair-')) mr2ChairCount += 1;
  }

  const oldCoffee1 = byUid.get('mr1-coffee');
  const oldCoffee2 = byUid.get('mr2-coffee');
  const oldChair2 = byUid.get('mr1-chair-2');
  const hasOldDividerWall = tiles[4 * DEFAULT_COLS + 10] === WALL_TILE;
  const hasNewDividerWall = tiles[4 * DEFAULT_COLS + CONFERENCE_DIVIDER_COL] === WALL_TILE;

  return (
    oldCoffee1?.row === 4 ||
    oldCoffee2?.row === 4 ||
    oldChair2?.row === 3 ||
    hasOldDividerWall ||
    !hasNewDividerWall ||
    mr1ChairCount !== 12 ||
    mr2ChairCount !== 4
  );
}

/**
 * Upgrade the default 21x22 office layout non-destructively with the upper Conference Wing
 * (Large Room A: 12 seats, Small Room B: 4 seats, coffee cups seated properly on tabletops),
 * or repair an older v1 conference layout, while keeping lower-half rooms, user customizations,
 * and `layoutRevision` intact so existing users never trigger MigrationNotice.
 */
export function upgradeDefaultLayoutWithMeetingRooms(layout: Record<string, unknown>): {
  layout: Record<string, unknown>;
  upgraded: boolean;
} {
  if (
    layout.cols !== DEFAULT_COLS ||
    layout.rows !== DEFAULT_ROWS ||
    !Array.isArray(layout.tiles) ||
    layout.tiles.length !== DEFAULT_COLS * DEFAULT_ROWS ||
    !Array.isArray(layout.furniture)
  ) {
    return { layout, upgraded: false };
  }

  const rawTiles = layout.tiles as number[];
  const topVoid = rawTiles.slice(0, 9 * DEFAULT_COLS).every((t) => t === VOID_TILE);
  const repairLegacy = !topVoid && needsConferenceWingRepair(rawTiles, layout.furniture);

  if (topVoid) {
    if (hasGeneratedConferenceMarkers(layout.furniture)) {
      return { layout, upgraded: false };
    }
  } else if (!repairLegacy) {
    return { layout, upgraded: false };
  }

  const next = structuredClone(layout) as {
    cols: number;
    rows: number;
    tiles: number[];
    tileColors?: Array<Record<string, unknown> | null>;
    furniture: unknown[];
    [key: string]: unknown;
  };

  const tileColors: Array<Record<string, unknown> | null> = Array.isArray(next.tileColors)
    ? next.tileColors.slice()
    : new Array<null>(DEFAULT_COLS * DEFAULT_ROWS).fill(null);
  while (tileColors.length < DEFAULT_COLS * DEFAULT_ROWS) {
    tileColors.push(null);
  }

  const setTile = (col: number, row: number, tile: number, color: Record<string, unknown>) => {
    const idx = row * DEFAULT_COLS + col;
    next.tiles[idx] = tile;
    tileColors[idx] = { ...color };
  };

  // Perimeter walls for the upper wing (rows 1..8, cols 0..19) and divider wall at col 12
  for (let col = 0; col <= 19; col++) {
    setTile(col, 1, WALL_TILE, WALL_COLOR);
    setTile(col, 8, WALL_TILE, WALL_COLOR);
  }
  for (let row = 1; row <= 8; row++) {
    setTile(0, row, WALL_TILE, WALL_COLOR);
    setTile(CONFERENCE_DIVIDER_COL, row, WALL_TILE, WALL_COLOR);
    setTile(19, row, WALL_TILE, WALL_COLOR);
  }

  // Meeting Room A floor (Large: cols 1..11, rows 2..7)
  for (let row = 2; row <= 7; row++) {
    for (let col = 1; col < CONFERENCE_DIVIDER_COL; col++) {
      setTile(col, row, FLOOR_TILE_ROOM_BLUE, ROOM1_FLOOR_COLOR);
    }
  }

  // Meeting Room B floor (Small: cols 13..18, rows 2..7)
  for (let row = 2; row <= 7; row++) {
    for (let col = CONFERENCE_DIVIDER_COL + 1; col <= 18; col++) {
      setTile(col, row, FLOOR_TILE_ROOM_BLUE, ROOM2_FLOOR_COLOR);
    }
  }

  // Doorways at col 4 (Room A <-> left office) and col 13 (Room B <-> right office)
  setTile(4, 8, FLOOR_TILE_ROOM_BLUE, ROOM1_FLOOR_COLOR);
  setTile(13, 8, FLOOR_TILE_ROOM_BLUE, ROOM2_FLOOR_COLOR);

  const nonConfFurniture = next.furniture.filter(
    (item) =>
      !(item && typeof item === 'object' && isConferenceUid((item as PlacedFurnitureLike).uid)),
  );

  if (!overlapsTile(nonConfFurniture, 4, 9) && !overlapsTile(nonConfFurniture, 4, 10)) {
    setTile(4, 9, FLOOR_TILE_LEFT_WOOD, LEFT_OFFICE_FLOOR_COLOR);
    setTile(4, 10, FLOOR_TILE_LEFT_WOOD, LEFT_OFFICE_FLOOR_COLOR);
  }
  if (!overlapsTile(nonConfFurniture, 13, 9) && !overlapsTile(nonConfFurniture, 13, 10)) {
    setTile(13, 9, FLOOR_TILE_ROOM_BLUE, RIGHT_OFFICE_FLOOR_COLOR);
    setTile(13, 10, FLOOR_TILE_ROOM_BLUE, RIGHT_OFFICE_FLOOR_COLOR);
  }

  next.tileColors = tileColors;
  next.furniture = [...nonConfFurniture, ...CONFERENCE_FURNITURE.map((f) => ({ ...f }))];

  return { layout: next, upgraded: true };
}
