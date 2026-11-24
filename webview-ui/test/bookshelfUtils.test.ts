import { describe, expect, it } from 'vitest';

import {
  type ArchiveBookEntry,
  bookSpineWidthPx,
  formatRelativeTimeZh,
  groupArchiveBooks,
  isBookshelfFurniture,
} from '../src/components/bookshelfUtils.js';

describe('bookshelfUtils', () => {
  it('detects BOOKSHELF and DOUBLE_BOOKSHELF furniture variants', () => {
    expect(isBookshelfFurniture('BOOKSHELF')).toBe(true);
    expect(isBookshelfFurniture('DOUBLE_BOOKSHELF')).toBe(true);
    expect(isBookshelfFurniture('BOOKSHELF:left')).toBe(true);
    expect(isBookshelfFurniture('DESK_FRONT')).toBe(false);
    expect(isBookshelfFurniture(undefined)).toBe(false);
  });

  it('scales book spine width between 26 and 42 px from context usage', () => {
    expect(bookSpineWidthPx(undefined, undefined)).toBe(28);
    expect(bookSpineWidthPx(0, 200_000)).toBe(26);
    expect(bookSpineWidthPx(100_000, 200_000)).toBe(34);
    expect(bookSpineWidthPx(500_000, 200_000)).toBe(42);
  });

  it('formats relative times in Traditional Chinese', () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeTimeZh(now - 10_000, now)).toBe('剛剛');
    expect(formatRelativeTimeZh(now - 5 * 60_000, now)).toBe('5 分鐘前');
    expect(formatRelativeTimeZh(now - 3 * 3_600_000, now)).toBe('3 小時前');
    expect(formatRelativeTimeZh(now - 2 * 86_400_000, now)).toBe('2 天前');
  });

  it('groups archive books into live/open, today, and earlier tiers', () => {
    const now = new Date(2026, 10, 24, 14, 0, 0).getTime();
    const todayMorning = new Date(2026, 10, 24, 9, 0, 0).getTime();
    const yesterday = new Date(2026, 10, 23, 18, 0, 0).getTime();

    const make = (id: string, overrides: Partial<ArchiveBookEntry>): ArchiveBookEntry => ({
      id,
      providerId: 'codex',
      title: id,
      project: 'app',
      filePath: `/tmp/${id}.jsonl`,
      updatedAtMs: yesterday,
      isLive: false,
      isOpenLock: false,
      activity: 'archived',
      ...overrides,
    });

    const grouped = groupArchiveBooks(
      [
        make('live-1', { isLive: true, activity: 'working', updatedAtMs: yesterday }),
        make('open-2', { isOpenLock: true, updatedAtMs: yesterday }),
        make('today-3', { updatedAtMs: todayMorning }),
        make('old-4', { updatedAtMs: yesterday }),
      ],
      now,
    );

    expect(grouped.live.map((b) => b.id)).toEqual(['live-1', 'open-2']);
    expect(grouped.today.map((b) => b.id)).toEqual(['today-3']);
    expect(grouped.earlier.map((b) => b.id)).toEqual(['old-4']);
  });
});
