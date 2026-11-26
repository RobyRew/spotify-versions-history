/**
 * Sign-in and the community data, wired from the environment. Without the four Logto variables the
 * site runs read-only: pages show counts and comments, and nothing offers to sign in.
 *
 *   DATA_DIR                    where archive.db lives (default ./data)
 *   LOGTO_ENDPOINT              https://auth.robyrew.com
 *   LOGTO_APP_ID / _APP_SECRET  the site's first-party Traditional Web app
 *   LOGTO_COOKIE_SECRET         at least 32 characters; seals the session rows
 *   LOGTO_WEBHOOK_SIGNING_KEY   the site's Logto webhook (profile changes, suspensions, deletions)
 *   AVATAR_ORIGINS              origins avatars may load from (default https://id.robyrew.com)
 */
import { join, resolve } from 'node:path';
import { createLogtoAuth, type LogtoAuth, type LogtoClaims } from '@robyrew/astro-logto';
import { displayHandle, handleFromClaims } from '@robyrew/astro-logto/handle';
import { sqliteSessionStore, type SqliteLike } from '@robyrew/astro-logto/sqlite';
import { createLogtoWebhookHandler } from '@robyrew/astro-logto/webhook';
import { createSocialStore, openSocialDb, type SocialStore, type StoredUser } from '../../../lib/site/social-store.ts';
import { safeAvatar, tokenBuckets } from '../../../lib/site/social.ts';

export interface SiteUser {
  id: string;
  /** The @handle to show: the Logto username, or `user-xxxxxx` until there is a valid one. */
  handle: string;
  /** False while the person has no valid username (they pick one at id.robyrew.com). */
  hasHandle: boolean;
  name: string | null;
  avatar: string | null;
  moderator: boolean;
  suspended: boolean;
  createdAt: number;
}

const env = process.env;
export const SITE_ORIGIN = new URL(env.PUBLIC_SITE_URL || 'https://spotify-versions-history.robyrew.com').origin;
export const ID_SITE = env.ID_SITE_URL || 'https://id.robyrew.com';
const AVATAR_ORIGINS = (env.AVATAR_ORIGINS || 'https://id.robyrew.com').split(',').map(origin => origin.trim()).filter(Boolean);

export function siteUser(user: StoredUser): SiteUser {
  return {
    id: user.id,
    handle: user.handle ?? displayHandle({ sub: user.id, username: null }),
    hasHandle: user.handle !== null,
    name: user.name,
    avatar: user.avatar,
    moderator: user.roles.includes('moderator'),
    suspended: user.suspended,
    createdAt: user.createdAt,
  };
}

function accountCreatedAt(claims: LogtoClaims): number | null {
  const raw = (claims as Record<string, unknown>).created_at;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

function build() {
  const db = openSocialDb(join(resolve(env.DATA_DIR || './data'), 'archive.db'));
  const store = createSocialStore(db);
  const logtoReady = Boolean(env.LOGTO_ENDPOINT && env.LOGTO_APP_ID && env.LOGTO_APP_SECRET && env.LOGTO_COOKIE_SECRET);
  const auth: LogtoAuth<SiteUser> | null = logtoReady
    ? createLogtoAuth<SiteUser>({
        endpoint: env.LOGTO_ENDPOINT!,
        appId: env.LOGTO_APP_ID!,
        appSecret: env.LOGTO_APP_SECRET!,
        sessionSecret: env.LOGTO_COOKIE_SECRET!,
        publicOrigin: SITE_ORIGIN,
        cookieName: 'svh_sid',
        // No e-mail: the site shows a handle, a name and a picture, nothing else.
        scopes: ['profile', 'offline_access', 'roles'],
        store: sqliteSessionStore(db as unknown as SqliteLike, { createTable: true }),
        resolveUser: claims => {
          const roles = Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === 'string') : [];
          return siteUser(store.upsertUser({
            id: claims.sub,
            handle: handleFromClaims(claims),
            name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 80) : null,
            avatar: safeAvatar(claims.picture, AVATAR_ORIGINS),
            roles,
            createdAt: accountCreatedAt(claims),
          }));
        },
      })
    : null;
  const webhook = env.LOGTO_WEBHOOK_SIGNING_KEY
    ? createLogtoWebhookHandler({
        signingKey: env.LOGTO_WEBHOOK_SIGNING_KEY,
        revokeUser: id => auth?.revokeUser(id),
        onUserDataUpdated: user => {
          const handle = handleFromClaims({ username: user.username ?? null });
          store.updateProfile(user.id, { handle, name: user.name?.trim().slice(0, 80) || null, avatar: safeAvatar(user.avatar, AVATAR_ORIGINS) });
          if (typeof user.isSuspended === 'boolean') store.setSuspended(user.id, user.isSuspended);
        },
        onUserSuspensionUpdated: (id, suspended) => store.setSuspended(id, suspended),
        onUserDeleted: id => store.anonymizeUser(id),
      })
    : null;
  return {
    store,
    auth,
    webhook,
    /** Likes and reactions: per person and per address. */
    reactLimit: tokenBuckets(60, 60),
    /** Comment writes per address, on top of the per-person rules in social.ts. */
    writeLimit: tokenBuckets(20, 10),
    counts: { at: 0, value: new Map() as ReturnType<SocialStore['metrics']> },
  };
}

type Community = ReturnType<typeof build>;
// One instance per process, kept across dev-server reloads.
const holder = globalThis as typeof globalThis & { __svhCommunity?: Community };

export function community(): Community {
  holder.__svhCommunity ??= build();
  return holder.__svhCommunity;
}

/** The signed-in person, or null (also when sign-in is not configured). */
export async function viewerOf(request: Request): Promise<SiteUser | null> {
  const { auth } = community();
  return auth ? auth.getUser(request) : null;
}

/** Per-release downloads, likes and comments for the sort orders, at most a minute old. */
export function releaseCounts(): ReturnType<SocialStore['metrics']> {
  const shared = community();
  if (Date.now() - shared.counts.at > 60_000) shared.counts = { at: Date.now(), value: shared.store.metrics() };
  return shared.counts.value;
}

export const signInHref = (returnTo: string): string => `/api/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
