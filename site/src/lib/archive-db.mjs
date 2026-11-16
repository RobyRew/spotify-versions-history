import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export const REACTIONS = ['works', 'broken', 'needed'];
const USERNAME = /^[a-z0-9_]{3,20}$/;
const HOUR = 60 * 60 * 1000;

export function openArchive(path = ':memory:') {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      logto_sub TEXT NOT NULL UNIQUE,
      username TEXT UNIQUE,
      name TEXT,
      email TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS likes (
      release_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (release_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS reactions (
      release_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (release_id, user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS downloads (
      release_id TEXT PRIMARY KEY,
      downloads INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health (
      url TEXT PRIMARY KEY,
      status INTEGER,
      etag TEXT,
      size INTEGER,
      checked_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function usernameFromClaims(claims) {
  const raw = claims?.username ?? claims?.preferred_username;
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return USERNAME.test(name) ? name : null;
}

export function upsertUser(db, claims, now = Date.now()) {
  const sub = claims?.sub;
  if (typeof sub !== 'string' || !sub) throw new Error('missing sub');
  const username = usernameFromClaims(claims);
  const name = typeof claims.name === 'string' ? claims.name.slice(0, 120) : null;
  const email = typeof claims.email === 'string' ? claims.email.slice(0, 200) : null;
  const existing = db.prepare('SELECT id, username FROM users WHERE logto_sub = ?').get(sub);
  if (!existing) {
    const id = randomBytes(12).toString('base64url');
    try {
      db.prepare('INSERT INTO users (id, logto_sub, username, name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, sub, username, name, email, now);
    } catch {
      db.prepare('INSERT INTO users (id, logto_sub, username, name, email, created_at) VALUES (?, ?, NULL, ?, ?, ?)').run(id, sub, name, email, now);
    }
    return db.prepare('SELECT id, logto_sub, username, name FROM users WHERE id = ?').get(id);
  }
  try {
    db.prepare('UPDATE users SET username = ?, name = ?, email = ? WHERE id = ?').run(username, name, email, existing.id);
  } catch {
    db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, existing.id);
  }
  return db.prepare('SELECT id, logto_sub, username, name FROM users WHERE id = ?').get(existing.id);
}

export function cleanBody(body) {
  if (typeof body !== 'string') return null;
  const text = body.replace(/\r\n/g, '\n').trim();
  if (!text || text.length > 2000 || text.includes('\0')) return null;
  return text;
}

export function commentsThisHour(db, userId, now = Date.now()) {
  return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND deleted_at IS NULL AND created_at > ?').get(userId, now - HOUR).n;
}

export function addComment(db, { releaseId, userId, body, now = Date.now() }) {
  const text = cleanBody(body);
  if (!text) return { error: 'invalid', status: 400 };
  if (commentsThisHour(db, userId, now) >= 20) return { error: 'slow down', status: 429 };
  const id = randomBytes(12).toString('base64url');
  db.prepare('INSERT INTO comments (id, release_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, releaseId, userId, text, now);
  return { comment: { id, releaseId, body: text, createdAt: new Date(now).toISOString(), username: null } };
}

export function listComments(db, releaseId) {
  return db.prepare(`
    SELECT comments.id, comments.body, comments.created_at AS createdAt, users.username, users.name
    FROM comments JOIN users ON users.id = comments.user_id
    WHERE comments.release_id = ? AND comments.deleted_at IS NULL
    ORDER BY comments.created_at ASC
  `).all(releaseId).map(row => ({
    id: row.id,
    body: row.body,
    createdAt: new Date(row.createdAt).toISOString(),
    username: row.username,
    name: row.name,
  }));
}

/** Author or admin. Anyone else, including a missing id, is a 404. */
export function deleteComment(db, { id, userId, admin = false, now = Date.now() }) {
  const row = db.prepare('SELECT user_id, deleted_at FROM comments WHERE id = ?').get(id);
  if (!row || row.deleted_at || (row.user_id !== userId && !admin)) return false;
  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(now, id);
  return true;
}

export function setLike(db, releaseId, userId, on, now = Date.now()) {
  if (on) db.prepare('INSERT OR IGNORE INTO likes (release_id, user_id, created_at) VALUES (?, ?, ?)').run(releaseId, userId, now);
  else db.prepare('DELETE FROM likes WHERE release_id = ? AND user_id = ?').run(releaseId, userId);
}

export function setReaction(db, releaseId, userId, kind, on, now = Date.now()) {
  if (!REACTIONS.includes(kind)) return false;
  if (on) db.prepare('INSERT OR IGNORE INTO reactions (release_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)').run(releaseId, userId, kind, now);
  else db.prepare('DELETE FROM reactions WHERE release_id = ? AND user_id = ? AND kind = ?').run(releaseId, userId, kind);
  return true;
}

export function recordDownload(db, releaseId) {
  db.prepare(`
    INSERT INTO downloads (release_id, downloads) VALUES (?, 1)
    ON CONFLICT(release_id) DO UPDATE SET downloads = downloads + 1
  `).run(releaseId);
}

export function socialState(db, releaseId, userId = null) {
  const downloads = db.prepare('SELECT downloads FROM downloads WHERE release_id = ?').get(releaseId)?.downloads ?? 0;
  const likes = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE release_id = ?').get(releaseId).n;
  const comments = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE release_id = ? AND deleted_at IS NULL').get(releaseId).n;
  const reactions = { works: 0, broken: 0, needed: 0 };
  for (const row of db.prepare('SELECT kind, COUNT(*) AS n FROM reactions WHERE release_id = ? GROUP BY kind').all(releaseId)) {
    if (row.kind in reactions) reactions[row.kind] = row.n;
  }
  const viewer = { liked: false, reactions: [] };
  if (userId) {
    viewer.liked = !!db.prepare('SELECT 1 AS n FROM likes WHERE release_id = ? AND user_id = ?').get(releaseId, userId);
    viewer.reactions = db.prepare('SELECT kind FROM reactions WHERE release_id = ? AND user_id = ?').all(releaseId, userId).map(row => row.kind);
  }
  return { downloads, likes, comments, reactions, viewer };
}

export function allCounts(db) {
  const out = {};
  const touch = (id) => out[id] ??= { downloads: 0, likes: 0, comments: 0 };
  for (const row of db.prepare('SELECT release_id, downloads FROM downloads').all()) touch(row.release_id).downloads = row.downloads;
  for (const row of db.prepare('SELECT release_id, COUNT(*) AS n FROM likes GROUP BY release_id').all()) touch(row.release_id).likes = row.n;
  for (const row of db.prepare('SELECT release_id, COUNT(*) AS n FROM comments WHERE deleted_at IS NULL GROUP BY release_id').all()) touch(row.release_id).comments = row.n;
  return out;
}

export function upsertHealth(db, rows, now = Date.now()) {
  const statement = db.prepare('INSERT INTO health (url, status, etag, size, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET status = excluded.status, etag = excluded.etag, size = excluded.size, checked_at = excluded.checked_at');
  for (const row of rows) {
    if (typeof row?.url !== 'string' || !row.url.startsWith('https://')) continue;
    const status = Number.isInteger(row.status) ? row.status : null;
    const size = Number.isInteger(row.size) ? row.size : null;
    statement.run(row.url, status, typeof row.etag === 'string' ? row.etag.slice(0, 200) : null, size, now);
  }
}
