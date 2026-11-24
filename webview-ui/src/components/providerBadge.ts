import { PROVIDER_BADGE_COLORS } from '../constants.js';

export interface ProviderBadgeInfo {
  id: string;
  short: string;
  label: string;
  bg: string;
  text: string;
}

export function getProviderBadge(providerId?: string): ProviderBadgeInfo {
  if (providerId === 'codex') {
    return {
      id: 'codex',
      short: 'CDX',
      label: 'Codex',
      ...PROVIDER_BADGE_COLORS.codex,
    };
  }
  if (providerId === 'antigravity') {
    return {
      id: 'antigravity',
      short: 'AGY',
      label: 'Antigravity',
      ...PROVIDER_BADGE_COLORS.antigravity,
    };
  }
  return {
    id: 'claude',
    short: 'CLD',
    label: 'Claude',
    ...PROVIDER_BADGE_COLORS.claude,
  };
}

/** Cycle to the next candidate agent ID after `currentId` (round-robin). */
export function pickNextTarget(
  candidates: readonly number[],
  currentId: number | null,
): number | null {
  if (candidates.length === 0) return null;
  const idx = currentId !== null ? candidates.indexOf(currentId) : -1;
  return candidates[(idx + 1) % candidates.length];
}
