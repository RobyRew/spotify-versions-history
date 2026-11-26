import { describe, expect, it } from 'vitest';
import { appStoreHistory, compareVersions, itunesCurrent, mergeMobileHistory, playReading, type MobileHistory } from '../../sensors/mobile.ts';

// Shapes cut from the real pages (2026-11-26), shortened.
const APP_STORE = `
{"items":[{"$kind":"TitledParagraph","text":"We’re always making changes","primarySubtitle":"Version 9.2.2","secondarySubtitle":"Fri Nov 20 2026 07:17:17 GMT+0000 (Coordinated Universal Time)"}]}
{"text":"Fixes","style":"compact","primarySubtitle":"9.2.2","secondarySubtitle":"Fri Nov 20 2026 07:17:17 GMT+0000 (Coordinated Universal Time)"},
{"text":"Fixes","style":"compact","primarySubtitle":"9.1.98","secondarySubtitle":"Mon Nov 09 2026 18:28:38 GMT+0000 (Coordinated Universal Time)"},
{"text":"Fixes","style":"compact","primarySubtitle":"9.2.0","secondarySubtitle":"Fri Nov 13 2026 13:54:31 GMT+0000 (Coordinated Universal Time)"},
{"text":"Bad","style":"compact","primarySubtitle":"9.0.1","secondarySubtitle":"not a date at all"}`;

const play = (seconds: number | null, reviews: string[]) => `
<script>AF_initDataCallback({key: 'ds:5', hash: '1', data:[null,[null,null,${JSON.stringify(Array.from({ length: 146 }, (_, index) => (index === 145 && seconds !== null ? [['Nov 24, 2026', [seconds, 848000000]]] : index === 140 ? [[null, []]] : null)))}]], sideChannel: {}});</script>
<script>AF_initDataCallback({key: 'ds:10', hash: '2', data:[${JSON.stringify(reviews.map(version => [null, null, null, null, null, null, null, null, null, null, version]))}], sideChannel: {}});</script>`;

describe('mobile store readings', () => {
  it('reads the App Store version history, newest first, and skips entries without a date', () => {
    expect(appStoreHistory(APP_STORE)).toEqual([
      { version: '9.2.2', releasedAt: '2026-11-20T07:17:17Z' },
      { version: '9.2.0', releasedAt: '2026-11-13T13:54:31Z' },
      { version: '9.1.98', releasedAt: '2026-11-09T18:28:38Z' },
    ]);
  });

  it('reads the current iOS version only for Spotify’s app id and bundle', () => {
    const row = { trackId: 324684580, bundleId: 'com.spotify.client', version: '9.2.2', currentVersionReleaseDate: '2026-11-20T07:17:17Z', minimumOsVersion: '16.1', fileSizeBytes: '331561984' };
    expect(itunesCurrent({ results: [row] })).toEqual({ version: '9.2.2', releasedAt: '2026-11-20T07:17:17Z', minimumOsVersion: '16.1', sizeBytes: 331561984 });
    expect(itunesCurrent({ results: [{ ...row, bundleId: 'com.example.fake' }] })).toBeNull();
    expect(itunesCurrent(null)).toBeNull();
  });

  it('reads Play’s update time and the newest reviewer-reported version', () => {
    expect(playReading(play(1795528408, ['9.0.10.415', '9.1.80.2221', '9.1.78.2218']))).toEqual({ updatedAt: '2026-11-24T13:53:28Z', reportedVersion: '9.1.80.2221' });
    expect(playReading(play(1795528408, []))).toEqual({ updatedAt: '2026-11-24T13:53:28Z', reportedVersion: null });
    expect(playReading(play(null, ['9.1.80.2221']))).toBeNull();
    expect(playReading('<html></html>')).toBeNull();
  });

  it('orders versions numerically', () => {
    expect(['9.1.98', '9.2.0', '9.1.100'].sort(compareVersions)).toEqual(['9.1.98', '9.1.100', '9.2.0']);
  });
});

describe('mobile history', () => {
  const now = new Date('2026-11-26T15:00:00Z');
  const readings = {
    appStore: [{ version: '9.2.2', releasedAt: '2026-11-20T07:17:17Z' }, { version: '9.2.0', releasedAt: '2026-11-13T13:54:31Z' }],
    itunes: { version: '9.2.2', releasedAt: '2026-11-20T07:17:17Z', minimumOsVersion: '16.1', sizeBytes: 331561984 },
    play: { updatedAt: '2026-11-24T13:53:28Z', reportedVersion: '9.1.80.2221' },
  };

  it('starts a history and returns the same object when a later run reads nothing new', () => {
    const first = mergeMobileHistory(null, readings, now);
    expect(first.ios.versions.map(entry => entry.version)).toEqual(['9.2.2', '9.2.0']);
    expect(first.ios.versions[0]).toMatchObject({ minimumOsVersion: '16.1', sizeBytes: 331561984, firstSeen: '2026-11-26T15:00:00Z' });
    expect(first.android.updates).toEqual([{ updatedAt: '2026-11-24T13:53:28Z', firstSeen: '2026-11-26T15:00:00Z', reportedVersion: '9.1.80.2221' }]);
    expect(mergeMobileHistory(first, readings, new Date('2026-11-27T00:00:00Z'))).toBe(first);
  });

  it('keeps versions that fell off the store’s list and adds new ones and updates', () => {
    const first = mergeMobileHistory(null, readings, now);
    const later = mergeMobileHistory(first, {
      appStore: [{ version: '9.2.4', releasedAt: '2026-11-27T08:00:00Z' }],
      itunes: null,
      play: { updatedAt: '2026-11-28T10:00:00Z', reportedVersion: '9.1.84.2300' },
    }, new Date('2026-11-28T12:00:00Z')) as MobileHistory;
    expect(later.ios.versions.map(entry => entry.version)).toEqual(['9.2.4', '9.2.2', '9.2.0']);
    expect(later.android.updates.map(update => update.updatedAt)).toEqual(['2026-11-28T10:00:00Z', '2026-11-24T13:53:28Z']);
    expect(later.changedAt).toBe('2026-11-28T12:00:00Z');
    expect(first.ios.versions).toHaveLength(2);
  });
});
