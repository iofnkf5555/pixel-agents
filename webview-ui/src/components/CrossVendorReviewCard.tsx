import { useState } from 'react';

import type {
  CrossVendorReviewRecord,
  CrossVendorVerdict,
  ReviewSeverity,
} from '../hooks/useCrossVendorReviews.js';
import { Button } from './ui/Button.js';

interface CrossVendorReviewCardProps {
  review: CrossVendorReviewRecord;
  busy?: boolean;
  compact?: boolean;
  onForward?: (reviewId: string) => Promise<boolean>;
  onAfterForward?: () => void;
  onReReview?: (review: CrossVendorReviewRecord) => Promise<boolean>;
  onDismiss?: (reviewId: string) => Promise<boolean>;
}

const VERDICT_META: Record<CrossVendorVerdict, { label: string; className: string }> = {
  approve: {
    label: '贊同推進',
    className: 'bg-active-bg border-status-success text-status-success',
  },
  caution: {
    label: '建議調整',
    className: 'bg-active-bg border-accent-bright text-accent-bright',
  },
  block: {
    label: '建議阻塞',
    className: 'bg-panel border-danger text-danger',
  },
  needs_info: {
    label: '需補充脈絡',
    className: 'bg-panel border-border text-text',
  },
};

const SEVERITY_CLASS: Record<ReviewSeverity, string> = {
  high: 'border-danger text-danger',
  medium: 'border-accent-bright text-accent-bright',
  low: 'border-border text-text-muted',
};

export function CrossVendorReviewCard({
  review,
  busy = false,
  compact = false,
  onForward,
  onAfterForward,
  onReReview,
  onDismiss,
}: CrossVendorReviewCardProps) {
  const [expandedCompact, setExpandedCompact] = useState(false);

  const verdictMeta = review.result ? VERDICT_META[review.result.verdict] : null;
  const isRunning = review.status === 'running';
  const canForward =
    review.status === 'completed' &&
    Boolean(review.result) &&
    review.forwardedRounds < review.round &&
    Boolean(onForward);
  const alreadyForwarded = review.status === 'completed' && review.forwardedRounds >= review.round;
  const canReReview =
    !isRunning &&
    (review.status === 'failed' || review.round < review.maxRounds) &&
    Boolean(onReReview);

  const showDetails = !compact || expandedCompact;

  return (
    <section
      className={`border border-border bg-bg-dark ${compact ? 'p-8' : 'p-10'} flex flex-col gap-6`}
    >
      <div className="flex items-center justify-between gap-6 flex-wrap">
        <div className="flex items-center gap-5 flex-wrap min-w-0">
          <span className="px-4 py-1 bg-panel border border-accent-bright text-accent-bright text-2xs leading-none shrink-0">
            審查
          </span>
          <h3 className="m-0 text-sm text-text truncate">
            {review.reviewerRole} · 第 {review.round}/{review.maxRounds} 輪
          </h3>
          {isRunning && (
            <span className="flex items-center gap-3 text-2xs text-accent-bright">
              <span className="w-6 h-6 rounded-full bg-accent-bright pixel-pulse shrink-0" />
              <span>唯讀檢視工作區中…</span>
            </span>
          )}
          {review.status === 'completed' && verdictMeta && (
            <span className={`px-4 py-1 border text-2xs leading-none ${verdictMeta.className}`}>
              {verdictMeta.label}
            </span>
          )}
          {review.status === 'failed' && (
            <span className="px-4 py-1 border border-danger text-danger text-2xs leading-none">
              審查失敗
            </span>
          )}
          {alreadyForwarded && (
            <span className="px-4 py-1 bg-panel border border-border text-2xs text-text-muted leading-none">
              已轉交給主導者
            </span>
          )}
        </div>

        <div className="flex items-center gap-4 flex-wrap shrink-0">
          {compact && review.status === 'completed' && review.result && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={expandedCompact}
              onClick={() => setExpandedCompact((v) => !v)}
            >
              {expandedCompact ? '收合細節' : `展開細節 (${review.result.findings.length})`}
            </Button>
          )}
          {canForward && onForward && (
            <Button
              type="button"
              variant="accent"
              size="sm"
              disabled={busy}
              aria-label={`轉交給主導者 — ${review.hostLabel}`}
              onClick={() => {
                void onForward(review.reviewId).then((ok) => {
                  if (ok) onAfterForward?.();
                });
              }}
            >
              轉交給主導者
            </Button>
          )}
          {canReReview && onReReview && (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={busy}
              aria-label={`再審一輪 — ${review.reviewerRole}`}
              onClick={() => {
                void onReReview(review);
              }}
            >
              {review.status === 'failed' ? '重試本輪' : '再審一輪'}
            </Button>
          )}
          {onDismiss && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`請離席／關閉 — ${review.reviewerRole}`}
              onClick={() => {
                void onDismiss(review.reviewId);
              }}
            >
              請離席／關閉
            </Button>
          )}
        </div>
      </div>

      {review.focus && (
        <div className="text-2xs text-text-muted break-words">審查重點：{review.focus}</div>
      )}

      {review.status === 'failed' && (
        <div role="alert" className="px-6 py-4 bg-panel border border-danger text-xs text-danger">
          {review.error || '跨模型審查執行失敗'}
        </div>
      )}

      {review.status === 'completed' && review.result && (
        <div aria-live="polite" className="flex flex-col gap-6">
          <p className="m-0 text-xs text-text leading-relaxed break-words">
            {review.result.summary}
          </p>

          {showDetails && review.result.findings.length > 0 && (
            <ul className="m-0 p-0 list-none flex flex-col gap-4">
              {review.result.findings.map((f, idx) => (
                <li
                  key={`${review.reviewId}-f-${idx}`}
                  className="p-6 bg-panel border border-border flex flex-col gap-2 text-2xs"
                >
                  <div className="flex items-center gap-4 flex-wrap">
                    <span
                      className={`px-3 py-1 border uppercase leading-none ${SEVERITY_CLASS[f.severity]}`}
                    >
                      {f.severity}
                    </span>
                    {f.file && <span className="text-text-muted font-mono">{f.file}</span>}
                  </div>
                  <div className="text-text leading-relaxed">{f.issue}</div>
                  {f.suggestion && (
                    <div className="text-text-muted leading-relaxed">建議：{f.suggestion}</div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {showDetails && review.result.openQuestions && review.result.openQuestions.length > 0 && (
            <div className="text-2xs text-text-muted flex flex-col gap-1">
              <span className="text-text">待釐清問題：</span>
              <ul className="m-0 pl-14 flex flex-col gap-1">
                {review.result.openQuestions.map((q, idx) => (
                  <li key={`${review.reviewId}-q-${idx}`}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          {showDetails && review.result.recommendedNextStep && (
            <div className="text-2xs text-accent-bright break-words">
              建議下一步：{review.result.recommendedNextStep}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
