export interface ArchiveBookEntry {
  id: string;
  providerId: 'codex' | 'antigravity' | 'claude';
  title: string;
  project: string;
  cwd?: string;
  filePath: string;
  updatedAtMs: number;
  isLive: boolean;
  isOpenLock: boolean;
  activity: 'working' | 'idle' | 'archived';
  agentId?: number;
  contextTokens?: number;
  maxContextTokens?: number;
  resumeCommand?: string;
}

export function isBookshelfFurniture(type: string | undefined): boolean {
  if (!type) return false;
  return type.startsWith('BOOKSHELF') || type.startsWith('DOUBLE_BOOKSHELF');
}

export function bookSpineWidthPx(contextTokens?: number, maxContextTokens?: number): number {
  if (
    contextTokens === undefined ||
    !Number.isFinite(contextTokens) ||
    !maxContextTokens ||
    maxContextTokens <= 0
  ) {
    return 28;
  }
  const ratio = Math.max(0, Math.min(1, contextTokens / maxContextTokens));
  return Math.round(26 + ratio * 16);
}

export function formatRelativeTimeZh(updatedAtMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (diffSec < 60) return '剛剛';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分鐘前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小時前`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} 天前`;
}

export function groupArchiveBooks(
  books: readonly ArchiveBookEntry[],
  nowMs = Date.now(),
): {
  live: ArchiveBookEntry[];
  today: ArchiveBookEntry[];
  earlier: ArchiveBookEntry[];
} {
  const live: ArchiveBookEntry[] = [];
  const today: ArchiveBookEntry[] = [];
  const earlier: ArchiveBookEntry[] = [];
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const todayStartMs = dayStart.getTime();

  for (const book of books) {
    if (book.isLive || book.isOpenLock) {
      live.push(book);
    } else if (book.updatedAtMs >= todayStartMs) {
      today.push(book);
    } else {
      earlier.push(book);
    }
  }

  return { live, today, earlier };
}
