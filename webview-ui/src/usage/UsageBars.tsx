import { useEffect, useMemo, useRef, useState } from 'react';

import type { LocalWindowActivity, UsageLimits } from '../../../core/src/messages.js';
import { getProviderBadge, type ProviderBadgeInfo } from '../components/providerBadge.js';
import { PixelText } from '../components/ui/PixelText.js';
import {
  CONTEXT_GAUGE_COLOR_YELLOW,
  USAGE_BAR_HEIGHT_PX,
  USAGE_BAR_TICK_MS,
  USAGE_BAR_WIDTH_PX,
  USAGE_BARS_LEFT_PX,
} from '../constants.js';
import { PixelHeart } from './PixelHeart.js';
import {
  formatCompactTokens,
  freshnessLabel,
  heartBeatPeriodSec,
  selectVisibleUsageVendors,
  type UsageBarView,
  usageBarView,
} from './usageBarView.js';
import type { UsageEntry } from './usageStore.js';

type BarId = 'weekly' | 'fiveHour';

/** Fill colour per bar and level. The two bars differ all the way down,
 *  like a game's health and stamina: weekly green -> yellow -> red, 5-hour
 *  blue -> purple -> red (yellow at half would make them look alike). */
const FILL: Record<BarId, Record<UsageBarView['level'], string>> = {
  weekly: {
    ok: 'var(--color-status-success)',
    warn: CONTEXT_GAUGE_COLOR_YELLOW,
    low: 'var(--color-danger)',
    unknown: 'transparent',
  },
  fiveHour: {
    ok: 'var(--color-status-active)',
    warn: 'var(--color-usage-five-hour-warn)',
    low: 'var(--color-danger)',
    unknown: 'transparent',
  },
};
const BAR_PREFIX: Record<BarId, string> = { weekly: 'W', fiveHour: '5h' };
const BAR_NAME: Record<BarId, string> = { weekly: 'Weekly', fiveHour: '5-hour' };
const METERED_WINDOW_TAG: Record<BarId, string> = { weekly: '7d 實測', fiveHour: '5h 實測' };

const VENDOR_DISPLAY_NAMES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  antigravity: 'Antigravity',
};

interface UsageBarsProps {
  /** The last usageLimits for the provider; undefined until the server sends it. */
  limits: UsageLimits | undefined;
  /** Whose plan it is, for people (usageBridgeStatus.providerName). */
  providerName: string;
  /** Phone: below the safe area, beside the menu button. */
  mobile: boolean;
}

interface VendorUsageStackProps {
  entries: ReadonlyMap<string, UsageEntry>;
  agentProviders: Record<number, string>;
  mobile: boolean;
}

/** The current time, re-read every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function barHoverText(
  id: BarId,
  providerLabel: string,
  view: UsageBarView,
  activity: LocalWindowActivity | undefined,
  hasOfficialWindow: boolean,
): string {
  if (!hasOfficialWindow && activity && activity.turns > 0) {
    return `${providerLabel} · ${BAR_NAME[id]} (${METERED_WINDOW_TAG[id]}) · ${formatCompactTokens(activity.tokens)} tok · ${activity.turns} turns`;
  }
  return `${providerLabel} · ${BAR_NAME[id]} · ${view.reset}`;
}

/** Single horizontal bar: renders either an official remaining % quota meter or a
 *  metered local 7d/5h token bar (never inventing a quota % where none exists). */
function BarRow({
  id,
  view,
  hasOfficialWindow,
  activity,
  badge,
  providerLabel,
  showReset,
}: {
  id: BarId;
  view: UsageBarView;
  hasOfficialWindow: boolean;
  activity: LocalWindowActivity | undefined;
  badge: ProviderBadgeInfo;
  providerLabel: string;
  showReset: boolean;
}) {
  const isMetered = !hasOfficialWindow && activity !== undefined && activity.turns > 0;
  const barText = hasOfficialWindow
    ? `${BAR_PREFIX[id]} ${view.percent}`
    : isMetered
      ? `${BAR_PREFIX[id]} ${formatCompactTokens(activity.tokens)}`
      : `${BAR_PREFIX[id]} --`;

  const meterProps =
    hasOfficialWindow && view.remaining !== null
      ? {
          role: 'meter' as const,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(view.remaining * 100),
          'aria-label': `${providerLabel} ${BAR_NAME[id]} remaining ${view.percent}, ${view.reset}`,
        }
      : {
          role: 'meter' as const,
          'aria-label': isMetered
            ? `${providerLabel} ${BAR_NAME[id]} local tokens ${formatCompactTokens(activity.tokens)} over ${activity.turns} turns`
            : `${providerLabel} ${BAR_NAME[id]} no data yet`,
        };

  return (
    <div className="flex items-center gap-4">
      <div
        {...meterProps}
        className="relative bg-bg-dark border-2 border-border box-content flex items-center pl-4 overflow-hidden"
        style={{ width: USAGE_BAR_WIDTH_PX, height: USAGE_BAR_HEIGHT_PX }}
      >
        {hasOfficialWindow ? (
          <div
            className="absolute left-0 top-0 bottom-0"
            style={{
              width: `${(view.remaining ?? 0) * 100}%`,
              background: FILL[id][view.level],
            }}
          />
        ) : isMetered ? (
          <div
            className="absolute left-0 top-0 bottom-0"
            style={{ width: 3, background: badge.bg }}
          />
        ) : null}
        <PixelText text={barText} shadow className="relative text-2xs text-text" />
      </div>
      {showReset && (
        <PixelText
          text={barHoverText(id, providerLabel, view, activity, hasOfficialWindow)}
          shadow
          className="text-2xs text-text whitespace-nowrap"
        />
      )}
    </div>
  );
}

function buildVendorTooltip(
  providerDisplayName: string,
  limits: UsageLimits | undefined,
  now: number,
  hasOfficialQuota: boolean,
): string {
  const planSuffix = limits?.planType ? ` (${limits.planType})` : '';
  if (hasOfficialQuota) {
    return `${providerDisplayName}${planSuffix} · ${freshnessLabel(limits?.updatedAt, now, providerDisplayName)}`;
  }
  const a7 = limits?.sevenDayActivity;
  const a5 = limits?.fiveHourActivity;
  if ((a7 && a7.turns > 0) || (a5 && a5.turns > 0)) {
    const cache7 = formatCompactTokens(a7?.cacheReadTokens ?? 0);
    const cache5 = formatCompactTokens(a5?.cacheReadTokens ?? 0);
    return `${providerDisplayName}：未公開官方 % 配額，改顯示本機 7d / 5h 非快取 Token 實測（7d cache read: ${cache7} · 5h cache read: ${cache5}）`;
  }
  return `${providerDisplayName}：${freshnessLabel(limits?.updatedAt, now, providerDisplayName)}`;
}

interface VendorUsageRowProps {
  providerId: string;
  providerName: string;
  limits: UsageLimits | undefined;
  now: number;
  mobile: boolean;
  showBadge?: boolean;
}

function VendorUsageRow({
  providerId,
  providerName,
  limits,
  now,
  mobile,
  showBadge = true,
}: VendorUsageRowProps) {
  const [active, setActive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobile || !active) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setActive(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [mobile, active]);

  const badge = getProviderBadge(providerId);
  const weekly = usageBarView(limits?.sevenDay, now);
  const fiveHour = usageBarView(limits?.fiveHour, now);
  const hasWeeklyQuota = limits?.sevenDay !== undefined;
  const hasFiveHourQuota = limits?.fiveHour !== undefined;
  const hasAnyOfficialQuota = hasWeeklyQuota || hasFiveHourQuota;
  const planLabel = limits?.planType ? `${providerName} (${limits.planType})` : providerName;
  const showResetBeside = active && !mobile;

  return (
    <div
      ref={rootRef}
      className="relative flex items-center gap-6 cursor-default"
      title={buildVendorTooltip(providerName, limits, now, hasAnyOfficialQuota)}
      aria-label={`${planLabel} usage. Weekly: ${
        hasWeeklyQuota
          ? `${weekly.percent} left, ${weekly.reset}`
          : limits?.sevenDayActivity && limits.sevenDayActivity.turns > 0
            ? `${formatCompactTokens(limits.sevenDayActivity.tokens)} tokens`
            : 'no data yet'
      }. 5-hour: ${
        hasFiveHourQuota
          ? `${fiveHour.percent} left, ${fiveHour.reset}`
          : limits?.fiveHourActivity && limits.fiveHourActivity.turns > 0
            ? `${formatCompactTokens(limits.fiveHourActivity.tokens)} tokens`
            : 'no data yet'
      }.`}
      onMouseEnter={mobile ? undefined : () => setActive(true)}
      onMouseLeave={mobile ? undefined : () => setActive(false)}
      onClick={mobile ? () => setActive((a) => !a) : undefined}
    >
      {showBadge && (
        <span
          className="px-4 py-2 text-2xs leading-none w-34 text-center border border-border shrink-0"
          style={{ background: badge.bg, color: badge.text }}
        >
          {badge.short}
        </span>
      )}
      <PixelHeart
        periodSec={active && hasWeeklyQuota ? heartBeatPeriodSec(weekly.remaining) : null}
      />
      <div className="flex flex-col gap-2">
        <BarRow
          id="weekly"
          view={weekly}
          hasOfficialWindow={hasWeeklyQuota}
          activity={limits?.sevenDayActivity}
          badge={badge}
          providerLabel={planLabel}
          showReset={showResetBeside}
        />
        <BarRow
          id="fiveHour"
          view={fiveHour}
          hasOfficialWindow={hasFiveHourQuota}
          activity={limits?.fiveHourActivity}
          badge={badge}
          providerLabel={planLabel}
          showReset={showResetBeside}
        />
      </div>
      {active && mobile && (
        <div className="mt-2 ml-4 flex flex-col gap-2 pointer-events-none">
          <PixelText
            text={barHoverText(
              'weekly',
              planLabel,
              weekly,
              limits?.sevenDayActivity,
              hasWeeklyQuota,
            )}
            shadow
            className="text-2xs text-text whitespace-nowrap"
          />
          <PixelText
            text={barHoverText(
              'fiveHour',
              planLabel,
              fiveHour,
              limits?.fiveHourActivity,
              hasFiveHourQuota,
            )}
            shadow
            className="text-2xs text-text whitespace-nowrap"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Top-left stack of strictly isolated per-vendor usage bars (`Codex`, `Claude Code`, `Antigravity`).
 * Never mixes usage values across vendors.
 */
export function VendorUsageStack({ entries, agentProviders, mobile }: VendorUsageStackProps) {
  const now = useNow(USAGE_BAR_TICK_MS);
  const activeProviders = useMemo(() => Object.values(agentProviders), [agentProviders]);
  const visibleVendors = useMemo(
    () => selectVisibleUsageVendors(entries, activeProviders),
    [entries, activeProviders],
  );

  if (visibleVendors.length === 0) return null;

  return (
    <div
      data-testid="vendor-usage-stack"
      className={`absolute z-10 flex flex-col gap-6 ${mobile ? 'mobile-safe-top' : 'top-8'}`}
      style={{ left: USAGE_BARS_LEFT_PX }}
    >
      {visibleVendors.map((vendorId) => {
        const entry = entries.get(vendorId);
        const providerName =
          entry?.status?.providerName ??
          VENDOR_DISPLAY_NAMES[vendorId] ??
          getProviderBadge(vendorId).label;
        return (
          <VendorUsageRow
            key={vendorId}
            providerId={vendorId}
            providerName={providerName}
            limits={entry?.limits}
            now={now}
            mobile={mobile}
          />
        );
      })}
    </div>
  );
}

/**
 * Single-vendor usage bars wrapper preserved for standalone callers.
 */
export function UsageBars({ limits, providerName, mobile }: UsageBarsProps) {
  const now = useNow(USAGE_BAR_TICK_MS);
  const providerId = limits?.providerId ?? 'claude';
  return (
    <div
      className={`absolute z-10 ${mobile ? 'mobile-safe-top' : 'top-8'}`}
      style={{ left: USAGE_BARS_LEFT_PX }}
    >
      <VendorUsageRow
        providerId={providerId}
        providerName={providerName}
        limits={limits}
        now={now}
        mobile={mobile}
        showBadge={false}
      />
    </div>
  );
}
