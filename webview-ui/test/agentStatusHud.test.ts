import { describe, expect, it } from 'vitest';

import { getProviderBadge, pickNextTarget } from '../src/components/providerBadge.js';

describe('providerBadge and AoE idle cycling', () => {
  it('returns distinct badges for codex, antigravity, and claude (default)', () => {
    expect(getProviderBadge('codex')).toMatchObject({
      id: 'codex',
      short: 'CDX',
      label: 'Codex',
    });
    expect(getProviderBadge('antigravity')).toMatchObject({
      id: 'antigravity',
      short: 'AGY',
      label: 'Antigravity',
    });
    expect(getProviderBadge('claude')).toMatchObject({
      id: 'claude',
      short: 'CLD',
      label: 'Claude',
    });
    expect(getProviderBadge(undefined)).toMatchObject({
      id: 'claude',
      short: 'CLD',
      label: 'Claude',
    });
  });

  it('cycles round-robin through idle/attention candidates via pickNextTarget', () => {
    expect(pickNextTarget([], null)).toBeNull();
    expect(pickNextTarget([2, 5, 9], null)).toBe(2);
    expect(pickNextTarget([2, 5, 9], 2)).toBe(5);
    expect(pickNextTarget([2, 5, 9], 5)).toBe(9);
    expect(pickNextTarget([2, 5, 9], 9)).toBe(2);
    expect(pickNextTarget([2, 5, 9], 99)).toBe(2);
  });
});
