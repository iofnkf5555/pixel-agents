import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { serverToken } from '../transport/serverToken.js';
import type { ArchiveBookEntry } from './bookshelfUtils.js';
import { bookSpineWidthPx, formatRelativeTimeZh, groupArchiveBooks } from './bookshelfUtils.js';
import { getProviderBadge } from './providerBadge.js';
import { Button } from './ui/Button.js';
import { PixelIcon } from './ui/PixelIcon.js';

interface BookshelfDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onFocusAgent: (agentId: number) => void;
}

type ShelfFilter = 'all' | 'live' | 'codex' | 'antigravity' | 'claude';

function archiveUrl(pathname: string): string {
  return serverToken ? `${pathname}?token=${encodeURIComponent(serverToken)}` : pathname;
}

function statusDotClass(book: ArchiveBookEntry): string {
  if (book.activity === 'working') return 'bg-accent-bright';
  if (book.isLive || book.isOpenLock) return 'bg-status-success';
  return 'bg-text-muted';
}

function statusLabel(book: ArchiveBookEntry): string {
  if (book.activity === 'working') return '工作中';
  if (book.isLive && book.isOpenLock) return '開啟中（辦公室）';
  if (book.isLive) return '閒置（辦公室）';
  if (book.isOpenLock) return '開啟中（未關）';
  return '已封存歷史';
}

export function BookshelfDialog({ isOpen, onClose, onFocusAgent }: BookshelfDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [books, setBooks] = useState<ArchiveBookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ShelfFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pinningKey, setPinningKey] = useState<string | null>(null);

  const loadArchive = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(archiveUrl('/api/archive'));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { books?: ArchiveBookEntry[] };
      const next = Array.isArray(data.books) ? data.books : [];
      setBooks(next);
      setSelectedKey((prev) => {
        if (prev && next.some((b) => `${b.providerId}:${b.id}` === prev)) return prev;
        return next[0] ? `${next[0].providerId}:${next[0].id}` : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法讀取檔案書櫃');
    } finally {
      setLoading(false);
    }
  }, []);

  // Sync React isOpen prop with native <dialog> top-layer modal state
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      void loadArchive();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen, loadArchive]);

  // Native close event + mandatory Safari light-dismiss fallback when closedBy is unsupported
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

  const filteredBooks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return books.filter((b) => {
      if (filter === 'live' && !b.isLive && !b.isOpenLock) return false;
      if (
        (filter === 'codex' || filter === 'antigravity' || filter === 'claude') &&
        b.providerId !== filter
      ) {
        return false;
      }
      if (!needle) return true;
      return (
        b.title.toLowerCase().includes(needle) ||
        b.project.toLowerCase().includes(needle) ||
        b.id.toLowerCase().includes(needle)
      );
    });
  }, [books, filter, query]);

  const grouped = useMemo(() => groupArchiveBooks(filteredBooks), [filteredBooks]);

  const selectedBook = useMemo(() => {
    return (
      filteredBooks.find((b) => `${b.providerId}:${b.id}` === selectedKey) ??
      filteredBooks[0] ??
      null
    );
  }, [filteredBooks, selectedKey]);

  const handleCopyResume = useCallback(async (book: ArchiveBookEntry) => {
    if (!book.resumeCommand) return;
    const key = `${book.providerId}:${book.id}`;
    try {
      await navigator.clipboard.writeText(book.resumeCommand);
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 2000);
    } catch {
      /* clipboard permission denied */
    }
  }, []);

  const handlePinToOffice = useCallback(
    async (book: ArchiveBookEntry) => {
      if (book.providerId !== 'codex' && book.providerId !== 'antigravity') return;
      const key = `${book.providerId}:${book.id}`;
      setPinningKey(key);
      try {
        const res = await fetch(archiveUrl('/api/archive/pin'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: book.providerId, id: book.id }),
        });
        const data = (await res.json()) as { ok?: boolean; agentId?: number };
        if (res.ok && data.ok) {
          await loadArchive();
          if (typeof data.agentId === 'number') {
            onFocusAgent(data.agentId);
            onClose();
          }
        }
      } finally {
        setPinningKey(null);
      }
    },
    [loadArchive, onFocusAgent, onClose],
  );

  const renderShelf = (tierTitle: string, items: ArchiveBookEntry[]) => {
    if (items.length === 0) return null;
    return (
      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs text-text-muted">{tierTitle}</span>
          <span className="text-2xs text-text-muted">{items.length} 本</span>
        </div>
        <div className="bg-shelf-bg border-2 border-shelf-shadow px-8 pt-10 pb-0">
          <div className="flex items-end gap-4 overflow-x-auto pb-4 min-h-104">
            {items.map((book) => {
              const key = `${book.providerId}:${book.id}`;
              const isSelected =
                selectedBook && `${selectedBook.providerId}:${selectedBook.id}` === key;
              const badge = getProviderBadge(book.providerId);
              const spineWidth = bookSpineWidthPx(book.contextTokens, book.maxContextTokens);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedKey(key)}
                  title={`${badge.label} · ${book.title} (${statusLabel(book)})`}
                  className={`relative shrink-0 h-96 px-2 py-4 flex flex-col items-center justify-between border-2 cursor-pointer transition-transform ${
                    isSelected
                      ? 'border-accent-bright -translate-y-4 shadow-pixel'
                      : 'border-shelf-shadow hover:-translate-y-2'
                  }`}
                  style={{
                    width: `${spineWidth}px`,
                    background: badge.bg,
                    color: badge.text,
                  }}
                >
                  <span
                    className={`w-6 h-6 shrink-0 border border-bg-dark ${statusDotClass(book)}`}
                  />
                  <span
                    className="text-2xs leading-none overflow-hidden text-ellipsis whitespace-nowrap max-h-56"
                    style={{ writingMode: 'vertical-rl' }}
                  >
                    {book.project || badge.short}
                  </span>
                  <span className="text-2xs leading-none opacity-90">{badge.short}</span>
                </button>
              );
            })}
          </div>
          <div className="h-8 -mx-8 bg-shelf-wood border-t-2 border-shelf-wood-highlight border-b-2 border-shelf-shadow" />
        </div>
      </section>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="bookshelf-dialog-title"
      className="pixel-native-dialog m-auto bg-bg text-text border-2 border-border rounded-none shadow-pixel p-0 w-[min(780px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-12 py-8 border-b-2 border-border bg-panel shrink-0">
        <div className="flex items-center gap-8">
          <h1 id="bookshelf-dialog-title" className="m-0 text-xl text-accent-bright">
            檔案書櫃 · Agent 歷史與 Resume
          </h1>
          <span className="text-xs text-text-muted">共 {books.length} 筆紀錄</span>
        </div>
        <div className="flex items-center gap-6">
          <Button variant="default" size="sm" onClick={() => void loadArchive()} disabled={loading}>
            {loading ? '讀取中…' : '重新整理'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => dialogRef.current?.close()}
            title="關閉"
          >
            <PixelIcon name="close" />
          </Button>
        </div>
      </div>

      {/* Filters + Search */}
      <div className="flex flex-wrap items-center justify-between gap-6 px-12 py-8 border-b border-border bg-bg-dark shrink-0">
        <div className="flex flex-wrap items-center gap-4">
          {(
            [
              ['all', '全部'],
              ['live', '開啟中 / 辦公室'],
              ['codex', 'Codex'],
              ['antigravity', 'Antigravity'],
              ['claude', 'Claude'],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              size="sm"
              variant={filter === id ? 'active' : 'default'}
              onClick={() => setFilter(id)}
            >
              {label}
            </Button>
          ))}
        </div>
        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋專案、標題或 Session ID..."
          aria-label="搜尋歷史紀錄"
          className="bg-bg border-2 border-border px-8 py-4 text-sm text-text outline-none focus:border-accent-bright w-[min(240px,100%)]"
        />
      </div>

      {/* Wooden Shelves */}
      <div className="flex-1 overflow-y-auto px-12 py-10">
        {error && (
          <div className="p-8 mb-8 border-2 border-danger bg-bg-dark text-sm text-reset-text">
            讀取書櫃失敗：{error}
          </div>
        )}
        {!error && filteredBooks.length === 0 && (
          <div className="py-24 text-center text-sm text-text-muted">
            {loading ? '正在整理書櫃…' : '找不到符合條件的歷史對話紀錄'}
          </div>
        )}
        {renderShelf('辦公室活體 / 開啟中（未關閉與 Resume）', grouped.live)}
        {renderShelf('今日紀錄', grouped.today)}
        {renderShelf('更早封存歷史', grouped.earlier)}
      </div>

      {/* Selected Book Inspector */}
      {selectedBook && (
        <div className="px-12 py-8 border-t-2 border-border bg-panel flex flex-wrap items-center justify-between gap-8 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-6 mb-2">
              <span
                className="px-4 py-1 text-2xs leading-none shrink-0"
                style={{
                  background: getProviderBadge(selectedBook.providerId).bg,
                  color: getProviderBadge(selectedBook.providerId).text,
                }}
              >
                {getProviderBadge(selectedBook.providerId).label}
              </span>
              <span className="text-base text-text truncate">{selectedBook.title}</span>
            </div>
            <div className="text-xs text-text-muted flex flex-wrap gap-8">
              <span>狀態：{statusLabel(selectedBook)}</span>
              <span>專案：{selectedBook.project}</span>
              <span>更新：{formatRelativeTimeZh(selectedBook.updatedAtMs)}</span>
              <span>ID：{selectedBook.id.slice(0, 12)}</span>
            </div>
          </div>

          <div className="flex items-center gap-6 shrink-0">
            {selectedBook.isLive && typeof selectedBook.agentId === 'number' && (
              <Button
                size="sm"
                variant="active"
                onClick={() => {
                  onFocusAgent(selectedBook.agentId!);
                  dialogRef.current?.close();
                }}
              >
                跳轉至角色
              </Button>
            )}
            {!selectedBook.isLive &&
              (selectedBook.providerId === 'codex' ||
                selectedBook.providerId === 'antigravity') && (
                <Button
                  size="sm"
                  variant="active"
                  disabled={pinningKey === `${selectedBook.providerId}:${selectedBook.id}`}
                  onClick={() => void handlePinToOffice(selectedBook)}
                >
                  {pinningKey === `${selectedBook.providerId}:${selectedBook.id}`
                    ? '召回中…'
                    : '召回辦公室'}
                </Button>
              )}
            {selectedBook.resumeCommand && (
              <Button
                size="sm"
                variant="default"
                onClick={() => void handleCopyResume(selectedBook)}
              >
                {copiedKey === `${selectedBook.providerId}:${selectedBook.id}`
                  ? '已複製指令'
                  : '複製 Resume 指令'}
              </Button>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
