import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  CONFERENCE_DIVIDER_COL,
  upgradeDefaultLayoutWithMeetingRooms,
} from '../src/meetingRoomLayout.js';

function makeEmptyTopLayout(): Record<string, unknown> {
  const cols = 21;
  const rows = 22;
  const tiles = new Array<number>(cols * rows).fill(255);
  const tileColors = new Array<Record<string, unknown> | null>(cols * rows).fill(null);

  // Lower office walls at row 10 and floor across rows 11..20
  for (let c = 0; c <= 19; c++) {
    tiles[10 * cols + c] = 0;
  }
  for (let r = 11; r <= 20; r++) {
    tiles[r * cols + 0] = 0;
    tiles[r * cols + 10] = r >= 14 && r <= 17 ? 1 : 0;
    tiles[r * cols + 19] = 0;
    for (let c = 1; c <= 9; c++) tiles[r * cols + c] = 7;
    for (let c = 11; c <= 18; c++) tiles[r * cols + c] = 1;
  }

  return {
    version: 1,
    cols,
    rows,
    layoutRevision: 1,
    tiles,
    tileColors,
    furniture: [
      { uid: 'f-bookshelf', type: 'DOUBLE_BOOKSHELF', col: 2, row: 9 },
      { uid: 'f-desk', type: 'DESK_FRONT', col: 2, row: 12 },
    ],
  };
}

describe('upgradeDefaultLayoutWithMeetingRooms', () => {
  it('upgrades a 21x22 layout with Large (12) + Small (4) rooms, places coffee cups on tables, and is idempotent', () => {
    const initial = makeEmptyTopLayout();
    const { layout: upgradedLayout, upgraded } = upgradeDefaultLayoutWithMeetingRooms(initial);
    expect(upgraded).toBe(true);
    expect(upgradedLayout.layoutRevision).toBe(1);

    const tiles = upgradedLayout.tiles as number[];
    const furniture = upgradedLayout.furniture as Array<{
      uid: string;
      type: string;
      col: number;
      row: number;
    }>;

    // Original bottom furniture preserved
    expect(furniture.some((f) => f.uid === 'f-bookshelf')).toBe(true);
    expect(furniture.some((f) => f.uid === 'f-desk')).toBe(true);

    // Large Room A (12 seats) & Small Room B (4 seats) with divider wall at col 12
    const mr1Chairs = furniture.filter((f) => f.uid.startsWith('mr1-chair-'));
    const mr2Chairs = furniture.filter((f) => f.uid.startsWith('mr2-chair-'));
    expect(mr1Chairs.length).toBe(12);
    expect(mr2Chairs.length).toBe(4);
    expect(furniture.some((f) => f.uid === 'mr1-whiteboard')).toBe(true);
    expect(furniture.some((f) => f.uid === 'mr2-whiteboard')).toBe(true);
    expect(tiles[4 * 21 + CONFERENCE_DIVIDER_COL]).toBe(0);

    // Every coffee cup in Meeting Rooms sits squarely ON its table surface row (table.row + 1 = 5)
    const mrTables = furniture.filter(
      (f) => f.uid.startsWith('mr1-table-') || f.uid.startsWith('mr2-table-'),
    );
    const mrCoffees = furniture.filter(
      (f) => f.uid.startsWith('mr1-coffee') || f.uid.startsWith('mr2-coffee'),
    );
    expect(mrCoffees.length).toBeGreaterThanOrEqual(2);
    for (const coffee of mrCoffees) {
      expect(coffee.row).toBe(5);
      const onTable = mrTables.some(
        (t) => coffee.row === t.row + 1 && coffee.col >= t.col && coffee.col < t.col + 2,
      );
      expect(onTable).toBe(true);
    }

    // Front row chairs sit flush against the back edge of the table (row 4)
    expect(furniture.find((f) => f.uid === 'mr1-chair-2')?.row).toBe(4);
    expect(furniture.find((f) => f.uid === 'mr2-chair-2')?.row).toBe(4);

    // Conference room floors & doorways (4,8..10) and (13,8..10) are walkable floor tiles
    expect(tiles[5 * 21 + 5]).toBe(1);
    expect(tiles[5 * 21 + 15]).toBe(1);
    expect(tiles[8 * 21 + 4]).toBe(1);
    expect(tiles[9 * 21 + 4]).toBe(7);
    expect(tiles[10 * 21 + 4]).toBe(7);
    expect(tiles[8 * 21 + 13]).toBe(1);
    expect(tiles[9 * 21 + 13]).toBe(1);
    expect(tiles[10 * 21 + 13]).toBe(1);

    // Idempotent second call
    const second = upgradeDefaultLayoutWithMeetingRooms(upgradedLayout);
    expect(second.upgraded).toBe(false);
  });

  it('repairs legacy v1 conference layouts (coffee on floor / col 10 divider) non-destructively and idempotently', () => {
    const legacy = makeEmptyTopLayout();
    const tiles = legacy.tiles as number[];
    for (let c = 0; c <= 19; c++) {
      tiles[1 * 21 + c] = 0;
      tiles[8 * 21 + c] = c === 4 || c === 13 ? 1 : 0;
    }
    for (let r = 2; r <= 7; r++) {
      tiles[r * 21 + 0] = 0;
      tiles[r * 21 + 10] = 0; // old col-10 divider
      tiles[r * 21 + 19] = 0;
      for (let c = 1; c <= 9; c++) tiles[r * 21 + c] = 1;
      for (let c = 11; c <= 18; c++) tiles[r * 21 + c] = 1;
    }
    legacy.furniture = [
      ...(legacy.furniture as Array<Record<string, unknown>>),
      { uid: 'mr1-table-1', type: 'SMALL_TABLE_FRONT', col: 3, row: 4 },
      { uid: 'mr1-coffee', type: 'COFFEE', col: 4, row: 4 },
      { uid: 'mr1-chair-2', type: 'CUSHIONED_CHAIR_FRONT', col: 4, row: 3 },
      { uid: 'mr2-table-1', type: 'SMALL_TABLE_FRONT', col: 14, row: 4 },
      { uid: 'mr2-coffee', type: 'COFFEE', col: 14, row: 4 },
    ];

    const repaired = upgradeDefaultLayoutWithMeetingRooms(legacy);
    expect(repaired.upgraded).toBe(true);
    const rfurn = repaired.layout.furniture as Array<{ uid: string; row: number }>;
    expect(rfurn.some((f) => f.uid === 'f-desk')).toBe(true);
    expect(rfurn.filter((f) => f.uid.startsWith('mr1-chair-')).length).toBe(12);
    expect(rfurn.filter((f) => f.uid.startsWith('mr2-chair-')).length).toBe(4);
    expect(rfurn.find((f) => f.uid === 'mr1-coffee')?.row).toBe(5);
    expect(rfurn.find((f) => f.uid === 'mr2-coffee')?.row).toBe(5);

    const third = upgradeDefaultLayoutWithMeetingRooms(repaired.layout);
    expect(third.upgraded).toBe(false);
  });

  it('skips custom layouts that already use upper rows or do not match 21x22', () => {
    const customTop = makeEmptyTopLayout();
    (customTop.tiles as number[])[2 * 21 + 2] = 1;
    expect(upgradeDefaultLayoutWithMeetingRooms(customTop).upgraded).toBe(false);

    const wrongSize = { version: 1, cols: 15, rows: 15, tiles: [], furniture: [] };
    expect(upgradeDefaultLayoutWithMeetingRooms(wrongSize).upgraded).toBe(false);
  });

  it('keeps default-layout-1.json upgraded with Large (12) and Small (4) meeting rooms and coffee on tables', () => {
    const raw = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../webview-ui/public/assets/default-layout-1.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(upgradeDefaultLayoutWithMeetingRooms(raw).upgraded).toBe(false);
    const furniture = raw.furniture as Array<{ uid: string; col: number; row: number }>;
    expect(furniture.filter((f) => f.uid.startsWith('mr1-chair-')).length).toBe(12);
    expect(furniture.filter((f) => f.uid.startsWith('mr2-chair-')).length).toBe(4);
    expect(furniture.find((f) => f.uid === 'mr1-coffee')?.row).toBe(5);
    expect(furniture.find((f) => f.uid === 'mr2-coffee')?.row).toBe(5);
  });
});
