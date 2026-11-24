import { useCallback, useEffect, useState } from 'react';

import { serverToken } from '../transport/serverToken.js';

export type ReviewVendor = 'codex' | 'antigravity';
export type CrossVendorVerdict = 'approve' | 'caution' | 'block' | 'needs_info';
export type ReviewStatus = 'running' | 'completed' | 'failed';
export type ReviewSeverity = 'high' | 'medium' | 'low';

export interface CrossVendorFinding {
  severity: ReviewSeverity;
  file?: string;
  issue: string;
  suggestion?: string;
}

export interface CrossVendorReviewResult {
  verdict: CrossVendorVerdict;
  summary: string;
  strengths?: string[];
  findings: CrossVendorFinding[];
  openQuestions?: string[];
  recommendedNextStep?: string;
}

export interface CrossVendorReviewRecord {
  reviewId: string;
  hostAgentId: number;
  hostVendor: string;
  hostLabel: string;
  reviewerAgentId?: number;
  reviewerVendor: ReviewVendor;
  reviewerRole: string;
  reviewerConversationId?: string;
  focus?: string;
  round: number;
  maxRounds: number;
  status: ReviewStatus;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  forwardedAtMs?: number;
  forwardedRounds: number;
  result?: CrossVendorReviewResult;
  error?: string;
}

export interface InviteReviewInput {
  hostAgentId: number;
  reviewerVendor?: ReviewVendor;
  focus?: string;
  previousReviewId?: string;
}

function reviewApiUrl(pathname: string): string {
  return serverToken ? `${pathname}?token=${encodeURIComponent(serverToken)}` : pathname;
}

export function oppositeReviewVendor(providerId?: string): ReviewVendor | null {
  if (providerId === 'codex') return 'antigravity';
  if (providerId === 'antigravity') return 'codex';
  return null;
}

export function inviteReviewLabel(providerId?: string): string | null {
  const target = oppositeReviewVendor(providerId);
  if (target === 'antigravity') return '邀請 AGY 審查';
  if (target === 'codex') return '邀請 CDX 審查';
  return null;
}

export function formatReviewError(code?: string): string {
  switch (code) {
    case 'review_in_progress':
      return '已有進行中的跨模型審查，請稍候完成。';
    case 'max_review_rounds_reached':
      return '已達本輪配對上限（最多 2 輪審查）。';
    case 'cli_missing':
      return '找不到目標模型的 CLI 執行檔（agy / codex）。';
    case 'subagent_not_communicable':
      return 'Subagent 或審查者無法作為審查主導者。';
    case 'unsupported_host_vendor':
      return '僅支援 Codex 與 Antigravity 之間的跨模型互審。';
    case 'review_already_forwarded':
      return '本輪審查結果已轉交給主導者。';
    case 'dispatch_in_progress':
      return '主導者正在處理前一則訊息，請稍後再試轉交。';
    default:
      return code || '跨模型審查操作失敗';
  }
}

interface UseCrossVendorReviewsInput {
  agents: readonly number[];
  agentStatuses: Record<number, string>;
  officeReadOnly: boolean;
}

export interface CrossVendorReviewsController {
  reviews: CrossVendorReviewRecord[];
  busyHostIds: ReadonlySet<number>;
  busyReviewIds: ReadonlySet<string>;
  reviewError: string | null;
  clearReviewError: () => void;
  refreshReviews: () => Promise<void>;
  inviteReview: (input: InviteReviewInput) => Promise<boolean>;
  forwardReview: (reviewId: string) => Promise<boolean>;
  dismissReview: (reviewId: string) => Promise<boolean>;
}

export function useCrossVendorReviews({
  agents,
  agentStatuses,
  officeReadOnly,
}: UseCrossVendorReviewsInput): CrossVendorReviewsController {
  const [reviews, setReviews] = useState<CrossVendorReviewRecord[]>([]);
  const [busyHostIds, setBusyHostIds] = useState<Set<number>>(() => new Set());
  const [busyReviewIds, setBusyReviewIds] = useState<Set<string>>(() => new Set());
  const [reviewError, setReviewError] = useState<string | null>(null);

  const refreshReviews = useCallback(async () => {
    if (officeReadOnly) {
      setReviews([]);
      return;
    }
    try {
      const res = await fetch(reviewApiUrl('/api/reviews'));
      if (!res.ok) return;
      const data = (await res.json()) as { reviews?: CrossVendorReviewRecord[] };
      if (Array.isArray(data.reviews)) {
        setReviews(data.reviews);
      }
    } catch {
      /* ignore transient fetch failure */
    }
  }, [officeReadOnly]);

  const agentsKey = agents.join(',');
  const statusKey = agents.map((id) => `${id}:${agentStatuses[id] ?? ''}`).join(',');

  useEffect(() => {
    void refreshReviews();
  }, [refreshReviews, agentsKey, statusKey]);

  const hasRunningReview = reviews.some((r) => r.status === 'running');
  useEffect(() => {
    if (officeReadOnly || !hasRunningReview) return;
    const timer = setInterval(() => {
      void refreshReviews();
    }, 2000);
    return () => clearInterval(timer);
  }, [officeReadOnly, hasRunningReview, refreshReviews]);

  const inviteReview = useCallback(
    async (input: InviteReviewInput): Promise<boolean> => {
      if (officeReadOnly) return false;
      setReviewError(null);
      setBusyHostIds((prev) => new Set(prev).add(input.hostAgentId));
      try {
        const res = await fetch(reviewApiUrl('/api/reviews/invite'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          setReviewError(formatReviewError(data.error ?? `HTTP ${res.status}`));
          return false;
        }
        await refreshReviews();
        return true;
      } catch (err) {
        setReviewError(err instanceof Error ? err.message : '邀請審查失敗');
        return false;
      } finally {
        setBusyHostIds((prev) => {
          const next = new Set(prev);
          next.delete(input.hostAgentId);
          return next;
        });
      }
    },
    [officeReadOnly, refreshReviews],
  );

  const forwardReview = useCallback(
    async (reviewId: string): Promise<boolean> => {
      if (officeReadOnly) return false;
      setReviewError(null);
      setBusyReviewIds((prev) => new Set(prev).add(reviewId));
      try {
        const res = await fetch(
          reviewApiUrl(`/api/reviews/${encodeURIComponent(reviewId)}/forward`),
          {
            method: 'POST',
          },
        );
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          setReviewError(formatReviewError(data.error ?? `HTTP ${res.status}`));
          return false;
        }
        await refreshReviews();
        return true;
      } catch (err) {
        setReviewError(err instanceof Error ? err.message : '轉交審查意見失敗');
        return false;
      } finally {
        setBusyReviewIds((prev) => {
          const next = new Set(prev);
          next.delete(reviewId);
          return next;
        });
      }
    },
    [officeReadOnly, refreshReviews],
  );

  const dismissReview = useCallback(
    async (reviewId: string): Promise<boolean> => {
      if (officeReadOnly) return false;
      setReviewError(null);
      setBusyReviewIds((prev) => new Set(prev).add(reviewId));
      try {
        const res = await fetch(
          reviewApiUrl(`/api/reviews/${encodeURIComponent(reviewId)}/dismiss`),
          {
            method: 'POST',
          },
        );
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          setReviewError(formatReviewError(data.error ?? `HTTP ${res.status}`));
          return false;
        }
        await refreshReviews();
        return true;
      } catch (err) {
        setReviewError(err instanceof Error ? err.message : '關閉審查席次失敗');
        return false;
      } finally {
        setBusyReviewIds((prev) => {
          const next = new Set(prev);
          next.delete(reviewId);
          return next;
        });
      }
    },
    [officeReadOnly, refreshReviews],
  );

  return {
    reviews,
    busyHostIds,
    busyReviewIds,
    reviewError,
    clearReviewError: () => setReviewError(null),
    refreshReviews,
    inviteReview,
    forwardReview,
    dismissReview,
  };
}
