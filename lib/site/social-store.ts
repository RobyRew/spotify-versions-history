/**
 * The website's own data, in SQLite through Node's built-in driver (no native addon to build): the
 * people who signed in (a copy of what their Logto ID token says), likes, reactions, comments,
 * reports, and daily download counts. The rules these queries apply are in social.ts.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EDIT_WINDOW_MS, REACTIONS, REPORTS_TO_HIDE, SUBNET_DAILY_CAP, utcDay, type Reaction, type ReportReason } from './social.ts';

/** One entry per schema version; PRAGMA user_version records how many ran. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,                 -- Logto sub
     handle TEXT,                         -- the Logto username when it passes the handle rule
     name TEXT,
     avatar TEXT,                         -- an allowlisted https URL, or null
     roles TEXT NOT NULL DEFAULT '[]',    -- JSON array of Logto global roles
     suspended INTEGER NOT NULL DEFAULT 0,
     deleted INTEGER NOT NULL DEFAULT 0,  -- the Logto account was deleted: shown as "Deleted account"
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE likes (
     release TEXT NOT NULL,
     user_id TEXT NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL,
     PRIMARY KEY (release, user_id)
   ) WITHOUT ROWID;
   CREATE TABLE reactions (
     release TEXT NOT NULL,
     user_id TEXT NOT NULL REFERENCES users(id),
     emoji TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (release, user_id, emoji)
   ) WITHOUT ROWID;
   CREATE TABLE comments (
     id INTEGER PRIMARY KEY,
     release TEXT NOT NULL,
     user_id TEXT NOT NULL REFERENCES users(id),
     parent_id INTEGER REFERENCES comments(id),
     body TEXT NOT NULL,                  -- emptied on deletion
     created_at INTEGER NOT NULL,
     edited_at INTEGER,
     deleted_at INTEGER,
     deleted_by TEXT,
     hidden INTEGER NOT NULL DEFAULT 0,   -- hidden after enough reports, until a moderator reviews it
     reviewed_at INTEGER                  -- reports before this time no longer count
   );
   CREATE INDEX comments_release ON comments (release, created_at);
   CREATE INDEX comments_user ON comments (user_id, created_at);
   CREATE TABLE comment_reactions (
     comment_id INTEGER NOT NULL REFERENCES comments(id),
     user_id TEXT NOT NULL REFERENCES users(id),
     emoji TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (comment_id, user_id, emoji)
   ) WITHOUT ROWID;
   CREATE TABLE reports (
     comment_id INTEGER NOT NULL REFERENCES comments(id),
     user_id TEXT NOT NULL REFERENCES users(id),
     reason TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (comment_id, user_id)
   ) WITHOUT ROWID;
   CREATE TABLE downloads (               -- daily aggregates only
     day TEXT NOT NULL,
     artifact TEXT NOT NULL,
     release TEXT NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (day, artifact)
   ) WITHOUT ROWID;
   CREATE INDEX downloads_release ON downloads (release, day);
   CREATE TABLE download_seen (           -- dedupe rows, pruned after two days
     day TEXT NOT NULL,
     artifact TEXT NOT NULL,
     visitor TEXT NOT NULL,               -- sha256(daily salt, address, User-Agent)
     subnet TEXT NOT NULL,
     PRIMARY KEY (day, artifact, visitor)
   ) WITHOUT ROWID;
   CREATE INDEX download_seen_subnet ON download_seen (day, artifact, subnet);
   CREATE TABLE salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL);`,
];

export function openSocialDb(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let index = version; index < MIGRATIONS.length; index++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[index]!);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}

export interface UserInput {
  id: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  roles: readonly string[];
  /** When the Logto account was created, if the ID token says. */
  createdAt?: number | null;
}

export interface StoredUser {
  id: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  roles: string[];
  suspended: boolean;
  deleted: boolean;
  createdAt: number;
}

export interface ReactionCount {
  emoji: Reaction;
  count: number;
  mine: boolean;
}

export interface CommentAuthor {
  id: string;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  deleted: boolean;
  moderator: boolean;
}

export interface CommentView {
  id: number;
  release: string;
  parentId: number | null;
  author: CommentAuthor;
  /** Empty for a deleted comment. */
  body: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  hidden: boolean;
  /** Reports since the last review; only moderators are shown this. */
  reports: number;
  reactions: ReactionCount[];
  replies: CommentView[];
}

export interface ReleaseSocial {
  likes: number;
  liked: boolean;
  reactions: ReactionCount[];
  comments: CommentView[];
  /** Visible comments and replies. */
  commentCount: number;
}

export interface Viewer {
  id: string;
  moderator: boolean;
}

export interface ReleaseMetrics {
  downloads: number;
  /** Downloads in the last seven days, today included. */
  recentDownloads: number;
  likes: number;
  comments: number;
}

export type SocialError = 'not_found' | 'forbidden' | 'too_late' | 'bad_parent' | 'own_comment';
export type Result<T> = { ok: true; value: T } | { ok: false; error: SocialError };

interface CommentRow {
  id: number;
  release: string;
  parent_id: number | null;
  user_id: string;
  body: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  hidden: number;
  reports: number;
  handle: string | null;
  name: string | null;
  avatar: string | null;
  roles: string;
  user_deleted: number;
}

const parseRoles = (raw: unknown): string[] => {
  try {
    const value: unknown = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(value) ? value.filter((role): role is string => typeof role === 'string') : [];
  } catch {
    return [];
  }
};

const countsFrom = (rows: readonly { emoji: string; count: number; mine: number }[]): ReactionCount[] =>
  REACTIONS.flatMap(emoji => {
    const row = rows.find(item => item.emoji === emoji);
    return row && row.count > 0 ? [{ emoji, count: row.count, mine: row.mine > 0 }] : [];
  });

export function createSocialStore(db: DatabaseSync, clock: () => number = Date.now) {
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?');
  const insertUser = db.prepare(`INSERT INTO users (id, handle, name, avatar, roles, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const updateUser = db.prepare('UPDATE users SET handle = ?, name = ?, avatar = ?, roles = ?, deleted = 0, updated_at = ? WHERE id = ?');

  const toUser = (row: Record<string, unknown>): StoredUser => ({
    id: String(row.id),
    handle: (row.handle as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    avatar: (row.avatar as string | null) ?? null,
    roles: parseRoles(row.roles),
    suspended: Number(row.suspended) === 1,
    deleted: Number(row.deleted) === 1,
    createdAt: Number(row.created_at),
  });

  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const likeCount = db.prepare('SELECT COUNT(*) AS count FROM likes WHERE release = ?');
  const reactionCounts = db.prepare(`SELECT emoji, COUNT(*) AS count, SUM(user_id = ?) AS mine FROM reactions WHERE release = ? GROUP BY emoji`);
  const commentReactionCounts = db.prepare(`SELECT emoji, COUNT(*) AS count, SUM(user_id = ?) AS mine FROM comment_reactions WHERE comment_id = ? GROUP BY emoji`);
  const commentRows = db.prepare(`
    SELECT c.id, c.release, c.parent_id, c.user_id, c.body, c.created_at, c.edited_at, c.deleted_at, c.hidden,
           (SELECT COUNT(*) FROM reports r WHERE r.comment_id = c.id AND r.created_at > COALESCE(c.reviewed_at, 0)) AS reports,
           u.handle, u.name, u.avatar, u.roles, u.deleted AS user_deleted
      FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.release = ?
     ORDER BY c.created_at, c.id`);
  const commentById = db.prepare('SELECT * FROM comments WHERE id = ?');

  function viewOf(row: CommentRow, viewer: Viewer | null): CommentView {
    const reactions = countsFrom(commentReactionCounts.all(viewer?.id ?? '', row.id) as { emoji: string; count: number; mine: number }[]);
    return {
      id: row.id,
      release: row.release,
      parentId: row.parent_id,
      author: {
        id: row.user_id,
        handle: row.user_deleted ? null : row.handle,
        name: row.user_deleted ? null : row.name,
        avatar: row.user_deleted ? null : row.avatar,
        deleted: row.user_deleted === 1,
        moderator: parseRoles(row.roles).includes('moderator'),
      },
      body: row.deleted_at ? '' : row.body,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deleted: row.deleted_at !== null,
      hidden: row.hidden === 1,
      reports: viewer?.moderator ? row.reports : 0,
      reactions,
      replies: [],
    };
  }

  return {
    /** Copies what the ID token says about a person; called on every signed-in request, writes only on a change. */
    upsertUser(input: UserInput): StoredUser {
      const now = clock();
      const roles = JSON.stringify([...input.roles].sort());
      const existing = userRow.get(input.id) as Record<string, unknown> | undefined;
      if (!existing) {
        insertUser.run(input.id, input.handle, input.name, input.avatar, roles, input.createdAt ?? now, now);
      } else if (existing.handle !== input.handle || existing.name !== input.name || existing.avatar !== input.avatar || existing.roles !== roles || Number(existing.deleted) === 1) {
        updateUser.run(input.handle, input.name, input.avatar, roles, now, input.id);
      }
      return toUser(userRow.get(input.id) as Record<string, unknown>);
    },

    getUser(id: string): StoredUser | null {
      const row = userRow.get(id) as Record<string, unknown> | undefined;
      return row ? toUser(row) : null;
    },

    /** A Logto webhook said the profile changed; a person who never signed in here is not stored. */
    updateProfile(id: string, profile: { handle: string | null; name: string | null; avatar: string | null }): void {
      db.prepare('UPDATE users SET handle = ?, name = ?, avatar = ?, updated_at = ? WHERE id = ?').run(profile.handle, profile.name, profile.avatar, clock(), id);
    },

    setSuspended(id: string, suspended: boolean): void {
      db.prepare('UPDATE users SET suspended = ?, updated_at = ? WHERE id = ?').run(suspended ? 1 : 0, clock(), id);
    },

    /** The Logto account was deleted: its comments stay, without a name, handle or picture. */
    anonymizeUser(id: string): void {
      db.prepare('UPDATE users SET handle = NULL, name = NULL, avatar = NULL, roles = \'[]\', deleted = 1, updated_at = ? WHERE id = ?').run(clock(), id);
    },

    releaseSocial(release: string, viewer: Viewer | null): ReleaseSocial {
      const viewerId = viewer?.id ?? '';
      const likes = Number((likeCount.get(release) as { count: number }).count);
      const liked = viewer ? Boolean(db.prepare('SELECT 1 FROM likes WHERE release = ? AND user_id = ?').get(release, viewerId)) : false;
      const reactions = countsFrom(reactionCounts.all(viewerId, release) as { emoji: string; count: number; mine: number }[]);
      const rows = commentRows.all(release) as unknown as CommentRow[];
      // Hidden comments are shown to moderators and to their author; deleted ones only as a
      // placeholder above replies that are still shown.
      const visible = (row: CommentRow) => !row.hidden || viewer?.moderator === true || row.user_id === viewerId;
      const views = new Map<number, CommentView>();
      const top: CommentView[] = [];
      for (const row of rows) {
        if (!visible(row)) continue;
        const view = viewOf(row, viewer);
        if (row.parent_id === null) {
          views.set(row.id, view);
          top.push(view);
        } else {
          views.get(row.parent_id)?.replies.push(view);
        }
      }
      for (const view of top) view.replies = view.replies.filter(reply => !reply.deleted);
      const comments = top.filter(view => !view.deleted || view.replies.length > 0);
      const commentCount = rows.filter(row => row.deleted_at === null && row.hidden === 0).length;
      return { likes, liked, reactions, comments, commentCount };
    },

    setLike(release: string, userId: string, liked: boolean): { liked: boolean; count: number } {
      if (liked) db.prepare('INSERT INTO likes (release, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(release, userId, clock());
      else db.prepare('DELETE FROM likes WHERE release = ? AND user_id = ?').run(release, userId);
      return { liked, count: Number((likeCount.get(release) as { count: number }).count) };
    },

    setReaction(release: string, userId: string, emoji: Reaction, on: boolean): ReactionCount {
      if (on) db.prepare('INSERT INTO reactions (release, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(release, userId, emoji, clock());
      else db.prepare('DELETE FROM reactions WHERE release = ? AND user_id = ? AND emoji = ?').run(release, userId, emoji);
      const row = db.prepare('SELECT COUNT(*) AS count FROM reactions WHERE release = ? AND emoji = ?').get(release, emoji) as { count: number };
      return { emoji, count: Number(row.count), mine: on };
    },

    /** Whether this person reacted to the release with this emoji (a no-script press toggles it). */
    reactionMine(release: string, userId: string, emoji: Reaction): boolean {
      return Boolean(db.prepare('SELECT 1 FROM reactions WHERE release = ? AND user_id = ? AND emoji = ?').get(release, userId, emoji));
    },

    commentReactionMine(commentId: number, userId: string, emoji: Reaction): boolean {
      return Boolean(db.prepare('SELECT 1 FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?').get(commentId, userId, emoji));
    },

    setCommentReaction(commentId: number, userId: string, emoji: Reaction, on: boolean): Result<ReactionCount> {
      const comment = commentById.get(commentId) as Record<string, unknown> | undefined;
      if (!comment || comment.deleted_at !== null) return { ok: false, error: 'not_found' };
      if (on) db.prepare('INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(commentId, userId, emoji, clock());
      else db.prepare('DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?').run(commentId, userId, emoji);
      const row = db.prepare('SELECT COUNT(*) AS count FROM comment_reactions WHERE comment_id = ? AND emoji = ?').get(commentId, emoji) as { count: number };
      return { ok: true, value: { emoji, count: Number(row.count), mine: on } };
    },

    /** Creation times of a user's comments since `since`, deleted ones included (the hourly limit counts them). */
    recentCommentTimes(userId: string, since: number): number[] {
      return (db.prepare('SELECT created_at FROM comments WHERE user_id = ? AND created_at > ?').all(userId, since) as { created_at: number }[]).map(row => Number(row.created_at));
    },

    addComment(release: string, userId: string, body: string, parentId: number | null): Result<number> {
      const user = userRow.get(userId) as Record<string, unknown> | undefined;
      if (!user || Number(user.suspended) === 1 || Number(user.deleted) === 1) return { ok: false, error: 'forbidden' };
      if (parentId !== null) {
        const parent = commentById.get(parentId) as Record<string, unknown> | undefined;
        // One level of replies: the parent is a shown top-level comment of the same release.
        if (!parent || parent.release !== release || parent.parent_id !== null || parent.deleted_at !== null || Number(parent.hidden) === 1) return { ok: false, error: 'bad_parent' };
      }
      const result = db.prepare('INSERT INTO comments (release, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(release, userId, parentId, body, clock());
      return { ok: true, value: Number(result.lastInsertRowid) };
    },

    /** The author within EDIT_WINDOW_MS, a moderator at any time. */
    editComment(id: number, viewer: Viewer, body: string): Result<number> {
      const comment = commentById.get(id) as Record<string, unknown> | undefined;
      if (!comment || comment.deleted_at !== null) return { ok: false, error: 'not_found' };
      if (!viewer.moderator) {
        if (comment.user_id !== viewer.id) return { ok: false, error: 'forbidden' };
        if (clock() - Number(comment.created_at) > EDIT_WINDOW_MS) return { ok: false, error: 'too_late' };
      }
      db.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(body, clock(), id);
      return { ok: true, value: id };
    },

    /** The author within EDIT_WINDOW_MS, a moderator at any time. The text is erased; the row stays for its replies. */
    deleteComment(id: number, viewer: Viewer): Result<string> {
      const comment = commentById.get(id) as Record<string, unknown> | undefined;
      if (!comment || comment.deleted_at !== null) return { ok: false, error: 'not_found' };
      if (!viewer.moderator) {
        if (comment.user_id !== viewer.id) return { ok: false, error: 'forbidden' };
        if (clock() - Number(comment.created_at) > EDIT_WINDOW_MS) return { ok: false, error: 'too_late' };
      }
      db.prepare('UPDATE comments SET body = \'\', deleted_at = ?, deleted_by = ? WHERE id = ?').run(clock(), viewer.id, id);
      return { ok: true, value: String(comment.release) };
    },

    /** One report per person and comment; REPORTS_TO_HIDE reports since the last review hide it. */
    reportComment(id: number, userId: string, reason: ReportReason): Result<{ hidden: boolean; release: string }> {
      return transaction(() => {
        const comment = commentById.get(id) as Record<string, unknown> | undefined;
        if (!comment || comment.deleted_at !== null) return { ok: false, error: 'not_found' } as const;
        if (comment.user_id === userId) return { ok: false, error: 'own_comment' } as const;
        const now = clock();
        db.prepare('INSERT INTO reports (comment_id, user_id, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (comment_id, user_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at').run(id, userId, reason, now);
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM reports WHERE comment_id = ? AND created_at > ?').get(id, Number(comment.reviewed_at ?? 0)) as { count: number };
        const hidden = Number(count) >= REPORTS_TO_HIDE;
        if (hidden) db.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').run(id);
        return { ok: true, value: { hidden: hidden || Number(comment.hidden) === 1, release: String(comment.release) } } as const;
      });
    },

    /** A moderator keeps a reported comment (shown again, earlier reports set aside) or removes it. */
    reviewComment(id: number, moderator: Viewer, keep: boolean): Result<string> {
      if (!moderator.moderator) return { ok: false, error: 'forbidden' };
      const comment = commentById.get(id) as Record<string, unknown> | undefined;
      if (!comment || comment.deleted_at !== null) return { ok: false, error: 'not_found' };
      const now = clock();
      if (keep) db.prepare('UPDATE comments SET hidden = 0, reviewed_at = ? WHERE id = ?').run(now, id);
      else db.prepare('UPDATE comments SET body = \'\', deleted_at = ?, deleted_by = ?, reviewed_at = ? WHERE id = ?').run(now, moderator.id, now, id);
      return { ok: true, value: String(comment.release) };
    },

    /** Comments with reports since their last review, hidden ones first, then by report count. */
    reportQueue(moderator: Viewer): (CommentView & { reasons: Record<string, number> })[] {
      const rows = db.prepare(`
        SELECT c.id, c.release, c.parent_id, c.user_id, c.body, c.created_at, c.edited_at, c.deleted_at, c.hidden,
               COUNT(r.user_id) AS reports, u.handle, u.name, u.avatar, u.roles, u.deleted AS user_deleted,
               json_group_array(r.reason) AS reasons
          FROM comments c
          JOIN users u ON u.id = c.user_id
          JOIN reports r ON r.comment_id = c.id AND r.created_at > COALESCE(c.reviewed_at, 0)
         WHERE c.deleted_at IS NULL
         GROUP BY c.id
         ORDER BY c.hidden DESC, reports DESC, c.created_at DESC
         LIMIT 200`).all() as unknown as (CommentRow & { reasons: string })[];
      return rows.map(row => {
        const reasons: Record<string, number> = {};
        for (const reason of JSON.parse(row.reasons) as string[]) reasons[reason] = (reasons[reason] ?? 0) + 1;
        return { ...viewOf(row, moderator), reasons };
      });
    },

    /** The salt of today's visitor keys; salts older than yesterday are deleted with the rows they keyed. */
    dailySalt(): string {
      const day = utcDay(clock());
      const row = db.prepare('SELECT salt FROM salts WHERE day = ?').get(day) as { salt: string } | undefined;
      if (row) return row.salt;
      const salt = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO salts (day, salt) VALUES (?, ?) ON CONFLICT DO NOTHING').run(day, salt);
      return (db.prepare('SELECT salt FROM salts WHERE day = ?').get(day) as { salt: string }).salt;
    },

    /**
     * Counts one download unless this visitor already downloaded the file today or its network has
     * reached SUBNET_DAILY_CAP for the file today. Dedupe rows and salts older than yesterday go.
     */
    recordDownload(input: { artifact: string; release: string; visitor: string; subnet: string }): boolean {
      const now = clock();
      const day = utcDay(now);
      return transaction(() => {
        const yesterday = utcDay(now - 86_400_000);
        db.prepare('DELETE FROM download_seen WHERE day < ?').run(yesterday);
        db.prepare('DELETE FROM salts WHERE day < ?').run(yesterday);
        const seen = db.prepare('INSERT INTO download_seen (day, artifact, visitor, subnet) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(day, input.artifact, input.visitor, input.subnet);
        if (Number(seen.changes) === 0) return false;
        const { count } = db.prepare('SELECT COUNT(*) AS count FROM download_seen WHERE day = ? AND artifact = ? AND subnet = ?').get(day, input.artifact, input.subnet) as { count: number };
        if (Number(count) > SUBNET_DAILY_CAP) return false;
        db.prepare('INSERT INTO downloads (day, artifact, release, count) VALUES (?, ?, ?, 1) ON CONFLICT (day, artifact) DO UPDATE SET count = count + 1').run(day, input.artifact, input.release);
        return true;
      });
    },

    /** Per release: downloads (all time and the last seven days), likes, and shown comments. */
    metrics(): Map<string, ReleaseMetrics> {
      const since = utcDay(clock() - 6 * 86_400_000);
      const out = new Map<string, ReleaseMetrics>();
      const entry = (release: string) => {
        let value = out.get(release);
        if (!value) out.set(release, (value = { downloads: 0, recentDownloads: 0, likes: 0, comments: 0 }));
        return value;
      };
      for (const row of db.prepare('SELECT release, SUM(count) AS total, SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS recent FROM downloads GROUP BY release').all(since) as { release: string; total: number; recent: number }[]) {
        Object.assign(entry(row.release), { downloads: Number(row.total), recentDownloads: Number(row.recent) });
      }
      for (const row of db.prepare('SELECT release, COUNT(*) AS count FROM likes GROUP BY release').all() as { release: string; count: number }[]) entry(row.release).likes = Number(row.count);
      for (const row of db.prepare('SELECT release, COUNT(*) AS count FROM comments WHERE deleted_at IS NULL AND hidden = 0 GROUP BY release').all() as { release: string; count: number }[]) entry(row.release).comments = Number(row.count);
      return out;
    },
  };
}

export type SocialStore = ReturnType<typeof createSocialStore>;
