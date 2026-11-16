import { originPills, sourceNote, isExpired, selectSource, platformNames, permalink } from './catalog.mjs';

const root = document.getElementById('release');
const id = new URLSearchParams(location.search).get('id') ?? '';
const title = document.getElementById('release-title');
const counted = location.hostname === 'spotify-versions-history.robyrew.com';

function text(id, value) { document.getElementById(id).textContent = value; }

async function main() {
  const response = await fetch(root.dataset.api);
  const catalog = await response.json();
  const entry = catalog.entries.find(item => item.id === id);
  if (!entry) { title.textContent = 'This release is not in the catalog.'; return; }
  title.textContent = entry.fullVersion;
  text('release-meta', `${platformNames[entry.platform] ?? entry.platform} · ${entry.architecture} · ${entry.format.toUpperCase()}`);
  const pills = originPills(entry);
  const origins = document.getElementById('release-origins');
  for (const [item, label] of [[pills.spotify, 'Spotify'], [pills.archive, 'Archive'], [pills.mirror, 'amd64fox']]) {
    const node = document.createElement(item && !isExpired(item) ? 'a' : 'span');
    node.className = 'pill' + (!item ? ' is-missing' : isExpired(item) ? ' is-down' : '');
    node.textContent = label;
    if (item && !isExpired(item)) node.href = item.url;
    node.title = item ? sourceNote(item) : 'No link on record';
    origins.append(node);
  }
  const source = selectSource(entry);
  const download = document.getElementById('release-download');
  if (source && !isExpired(source)) {
    download.hidden = false;
    download.href = counted ? `/r/${entry.fullVersion}/${entry.platform}/${entry.architecture}` : source.url;
  }
  const link = permalink(entry.fullVersion, entry.platform, entry.architecture);
  const linkNode = document.getElementById('release-link');
  linkNode.textContent = link;
  await loadSocial(entry.id);
}

async function loadSocial(releaseId) {
  const me = await fetch('/api/v1/me').then(r => r.ok ? r.json() : null).catch(() => null);
  const signedIn = !!me?.user;
  document.getElementById('release-form').hidden = !signedIn;
  document.getElementById('release-signin').hidden = signedIn || location.hostname !== 'spotify-versions-history.robyrew.com';
  const state = await fetch(`/api/v1/releases/${encodeURIComponent(releaseId)}`).then(r => r.ok ? r.json() : null).catch(() => null);
  const reactions = document.getElementById('release-reactions');
  if (state) {
    for (const kind of ['works', 'broken', 'needed']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rw-btn';
      button.textContent = `${kind} ${state.reactions[kind] ?? 0}`;
      button.addEventListener('click', () => sendReaction(releaseId, kind, !state.viewer.reactions.includes(kind)));
      reactions.append(button);
    }
    const like = document.createElement('button');
    like.type = 'button';
    like.className = 'rw-btn';
    like.textContent = state.viewer.liked ? `Liked ${state.likes}` : `Like ${state.likes}`;
    like.addEventListener('click', () => sendLike(releaseId, !state.viewer.liked));
    reactions.append(like);
  }
  const comments = await fetch(`/api/v1/releases/${encodeURIComponent(releaseId)}/comments`).then(r => r.ok ? r.json() : null).catch(() => null);
  const list = document.getElementById('release-comments');
  for (const comment of comments?.comments ?? []) {
    const item = document.createElement('div');
    item.className = 'comment';
    const who = document.createElement('strong');
    who.textContent = comment.username ? `@${comment.username}` : (comment.name || 'Signed-in user');
    const body = document.createElement('p');
    body.textContent = comment.body;
    item.append(who, body);
    list.append(item);
  }
  document.getElementById('release-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = new FormData(event.currentTarget).get('body');
    const error = document.getElementById('release-form-error');
    const result = await fetch(`/api/v1/releases/${encodeURIComponent(releaseId)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!result.ok) { error.hidden = false; error.textContent = 'The comment was not posted.'; return; }
    location.reload();
  });
}

async function sendLike(releaseId, on) {
  await fetch(`/api/v1/releases/${encodeURIComponent(releaseId)}/like`, { method: on ? 'POST' : 'DELETE' });
  location.reload();
}
async function sendReaction(releaseId, kind, on) {
  await fetch(`/api/v1/releases/${encodeURIComponent(releaseId)}/reactions${on ? '' : '/' + kind}`, {
    method: on ? 'POST' : 'DELETE',
    headers: on ? { 'content-type': 'application/json' } : undefined,
    body: on ? JSON.stringify({ kind }) : undefined,
  });
  location.reload();
}

main();
