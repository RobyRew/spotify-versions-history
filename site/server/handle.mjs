import { timingSafeEqual } from 'node:crypto';
import { isReleaseId, selectSource, permalink } from '../src/lib/catalog.mjs';
import { REACTIONS, addComment, allCounts, deleteComment, listComments, recordDownload, setLike, setReaction, socialState, upsertHealth } from '../src/lib/archive-db.mjs';

const PUBLIC_ORIGIN = 'https://spotify-versions-history.robyrew.com';

/** Node collapses repeated headers. Set-Cookie has to stay a list or the session id is dropped. */
export function nodeHeaders(response) {
  const headers = {};
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') continue;
    headers[key] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  return headers;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function sameToken(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return { error: json({ error: 'expected application/json' }, 415) };
  const text = await request.text();
  if (text.length > 256_000) return { error: json({ error: 'body too large' }, 413) };
  try { return { body: JSON.parse(text) }; }
  catch { return { error: json({ error: 'invalid json' }, 400) }; }
}

function originAllowed(request, origin) {
  const sent = request.headers.get('origin');
  return !sent || sent === origin;
}

/** Returns a Response when the path belongs to the write API, otherwise null so static files are served. */
export async function handleApi(request, deps) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;
  const origin = (deps.publicOrigin || PUBLIC_ORIGIN).replace(/\/$/, '');

  if (path.startsWith('/api/auth/')) {
    if (!deps.auth) return json({ error: 'sign-in is not configured' }, 503);
    const ctx = deps.routeContext(request, url);
    if (path === '/api/auth/sign-in' && method === 'GET') return deps.auth.signIn(ctx);
    if (path === '/api/auth/callback' && method === 'GET') return deps.auth.callback(ctx);
    if (path === '/api/auth/sign-out' && (method === 'GET' || method === 'POST')) return deps.auth.signOut(ctx);
    return json({ error: 'not found' }, 404);
  }

  if (path === '/api/v1/me' && method === 'GET') {
    const user = await deps.user(request);
    if (!user) return json({ user: null });
    return json({ user: { username: user.username, name: user.name } });
  }

  if (path === '/api/v1/counts' && method === 'GET') return json(allCounts(deps.db));

  if (path === '/api/v1/ingest' && method === 'POST') {
    const header = request.headers.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!sameToken(token, deps.ingestToken)) return json({ error: 'not found' }, 404);
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const rows = Array.isArray(parsed.body?.health) ? parsed.body.health.slice(0, 500) : [];
    upsertHealth(deps.db, rows);
    return json({ stored: rows.length });
  }

  const redirect = /^\/r\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (redirect && method === 'GET') {
    const [, version, platform, architecture] = redirect;
    const entry = deps.findEntry(version, platform, architecture);
    if (!entry) return json({ error: 'not found' }, 404);
    const source = selectSource(entry);
    if (!source || source.expired) return json({ error: 'no live download' }, 404);
    recordDownload(deps.db, entry.id);
    return new Response(null, { status: 302, headers: { location: source.url, 'cache-control': 'no-store' } });
  }

  const release = /^\/api\/v1\/releases\/([^/]+)$/.exec(path);
  if (release && method === 'GET') {
    const id = decodeURIComponent(release[1]);
    if (!isReleaseId(id) || !deps.hasRelease(id)) return json({ error: 'not found' }, 404);
    const user = await deps.user(request);
    const entry = deps.entryById(id);
    return json({ id, permalink: permalink(entry.fullVersion, entry.platform, entry.architecture, origin), ...socialState(deps.db, id, user?.id) });
  }

  const comments = /^\/api\/v1\/releases\/([^/]+)\/comments$/.exec(path);
  if (comments && method === 'GET') {
    const id = decodeURIComponent(comments[1]);
    if (!isReleaseId(id) || !deps.hasRelease(id)) return json({ error: 'not found' }, 404);
    return json({ comments: listComments(deps.db, id) });
  }
  if (comments && method === 'POST') {
    if (!originAllowed(request, origin)) return json({ error: 'bad origin' }, 403);
    const id = decodeURIComponent(comments[1]);
    if (!isReleaseId(id) || !deps.hasRelease(id)) return json({ error: 'not found' }, 404);
    const user = await deps.user(request);
    if (!user) return json({ error: 'sign in' }, 401);
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const result = addComment(deps.db, { releaseId: id, userId: user.id, body: parsed.body?.body });
    if (result.error) return json({ error: result.error }, result.status);
    result.comment.username = user.username;
    result.comment.name = user.name;
    return json(result.comment, 201);
  }

  const comment = /^\/api\/v1\/releases\/([^/]+)\/comments\/([^/]+)$/.exec(path);
  if (comment && method === 'DELETE') {
    if (!originAllowed(request, origin)) return json({ error: 'bad origin' }, 403);
    const user = await deps.user(request);
    if (!user) return json({ error: 'sign in' }, 401);
    const ok = deleteComment(deps.db, { id: decodeURIComponent(comment[2]), userId: user.id, admin: user.admin === true });
    if (!ok) return json({ error: 'not found' }, 404);
    return json({ deleted: true });
  }

  const like = /^\/api\/v1\/releases\/([^/]+)\/like$/.exec(path);
  if (like && (method === 'POST' || method === 'DELETE')) {
    if (!originAllowed(request, origin)) return json({ error: 'bad origin' }, 403);
    const id = decodeURIComponent(like[1]);
    if (!isReleaseId(id) || !deps.hasRelease(id)) return json({ error: 'not found' }, 404);
    const user = await deps.user(request);
    if (!user) return json({ error: 'sign in' }, 401);
    setLike(deps.db, id, user.id, method === 'POST');
    return json(socialState(deps.db, id, user.id));
  }

  const reaction = /^\/api\/v1\/releases\/([^/]+)\/reactions(?:\/([^/]+))?$/.exec(path);
  if (reaction && (method === 'POST' || method === 'DELETE')) {
    if (!originAllowed(request, origin)) return json({ error: 'bad origin' }, 403);
    const id = decodeURIComponent(reaction[1]);
    if (!isReleaseId(id) || !deps.hasRelease(id)) return json({ error: 'not found' }, 404);
    const user = await deps.user(request);
    if (!user) return json({ error: 'sign in' }, 401);
    let kind = reaction[2] ? decodeURIComponent(reaction[2]) : null;
    if (method === 'POST') {
      const parsed = await readJson(request);
      if (parsed.error) return parsed.error;
      kind = parsed.body?.kind;
    }
    if (!REACTIONS.includes(kind)) return json({ error: 'unknown reaction' }, 400);
    setReaction(deps.db, id, user.id, kind, method === 'POST');
    return json(socialState(deps.db, id, user.id));
  }

  if (path.startsWith('/api/v1/releases') || path.startsWith('/r/')) return json({ error: 'not found' }, 404);
  return null;
}
