import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOfficial } from '../src/lib/catalog.mjs';
import { openArchive, upsertUser } from '../src/lib/archive-db.mjs';
import { handleApi, nodeHeaders } from './handle.mjs';
import catalogSnapshot from '../data/catalog.json' with { type: 'json' };
import officialSnapshot from '../data/official.json' with { type: 'json' };

const root = fileURLToPath(new URL('../dist', import.meta.url));
const port = Number(process.env.PORT || 4321);
const publicOrigin = process.env.PUBLIC_SITE_URL || 'https://spotify-versions-history.robyrew.com';
const dbPath = process.env.ARCHIVE_DB || fileURLToPath(new URL('../var/archive.sqlite', import.meta.url));
if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true });
const db = openArchive(dbPath);

const entries = applyOfficial(catalogSnapshot.entries, officialSnapshot);
function findEntry(version, platform, architecture) {
  return entries.find(entry => entry.fullVersion.toLowerCase() === version.toLowerCase() && entry.platform === platform && entry.architecture === architecture) ?? null;
}
function entryById(id) { return entries.find(entry => entry.id.toLowerCase() === id.toLowerCase()) ?? null; }
function hasRelease(id) { return !!entryById(id); }

let auth = null;
if (process.env.LOGTO_ENDPOINT && process.env.LOGTO_APP_ID && process.env.LOGTO_APP_SECRET) {
  // A missing package or a down IdP must not stop the catalog from booting.
  let createLogtoAuth;
  let sqliteSessionStore;
  try {
    ({ createLogtoAuth } = await import('@robyrew/astro-logto'));
    ({ sqliteSessionStore } = await import('@robyrew/astro-logto/sqlite'));
  } catch (error) {
    console.warn(`Logto sign-in is off: ${error.message}`);
  }
  if (createLogtoAuth && sqliteSessionStore) {
    auth = createLogtoAuth({
      endpoint: process.env.LOGTO_ENDPOINT,
      appId: process.env.LOGTO_APP_ID,
      appSecret: process.env.LOGTO_APP_SECRET,
      publicOrigin,
      cookieName: 'sv_sid',
      store: sqliteSessionStore(db, { createTable: true }),
      resolveUser: (claims) => {
        const user = upsertUser(db, claims);
        const roles = Array.isArray(claims.roles) ? claims.roles : [];
        return { ...user, admin: roles.includes('archive-admin') };
      },
    });
  }
}

const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function routeContext(request, url) {
  const set = [];
  const current = () => {
    const header = request.headers.cookie ?? '';
    const fromJar = Object.fromEntries(set.map(line => {
      const part = line.split(';', 1)[0];
      const eq = part.indexOf('=');
      return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
    }));
    return (name) => {
      if (name in fromJar) return { value: fromJar[name] };
      const match = header.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='));
      return match ? { value: decodeURIComponent(match.slice(name.length + 1)) } : undefined;
    };
  };
  const cookies = current();
  return {
    url,
    request,
    cookies: {
      get: (name) => cookies(name),
      set(name, value, options) {
        const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`];
        if (options.maxAge != null) bits.push(`Max-Age=${options.maxAge}`);
        if (options.httpOnly) bits.push('HttpOnly');
        if (options.secure) bits.push('Secure');
        if (options.sameSite) bits.push(`SameSite=${options.sameSite}`);
        set.push(bits.join('; '));
      },
      delete(name, options) {
        set.push(`${name}=; Path=${options?.path || '/'}; Max-Age=0`);
      },
    },
    redirect(path, status = 302) {
      const headers = new Headers({ location: path });
      for (const line of set) headers.append('set-cookie', line);
      return new Response(null, { status, headers });
    },
  };
}

async function user(request) {
  if (!auth) return null;
  return auth.getUser(request);
}

async function sendFile(response, path) {
  const info = await stat(path);
  if (!info.isFile()) return false;
  response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'content-length': info.size });
  createReadStream(path).pipe(response);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${port}`;
    const request = new Request(`http://${host}${req.url}`, { method: req.method, headers: req.headers });
    const handled = await handleApi(request, { db, auth, user, routeContext, findEntry, hasRelease, entryById, publicOrigin, ingestToken: process.env.ARCHIVE_INGEST_TOKEN || '' });
    if (handled) {
      res.writeHead(handled.status, nodeHeaders(handled));
      res.end(Buffer.from(await handled.arrayBuffer()));
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, '');
    const candidates = [join(root, relative), join(root, relative, 'index.html')];
    for (const candidate of candidates) {
      if (!candidate.startsWith(root)) continue;
      try {
        if (await sendFile(res, candidate)) return;
      } catch { /* try the next candidate */ }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Error');
  }
});

server.listen(port, '0.0.0.0', () => console.log(`listening on ${port}`));
