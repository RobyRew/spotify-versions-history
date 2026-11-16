import gsap from 'gsap';
import { filterCatalog, orderedSources, originPills, sourceNote, isExpired, formatSize, platformNames } from './catalog.mjs';

const find = id => document.getElementById(id);
const catalogEl = find('catalog');
const base = catalogEl.dataset.base || '/';
const controls = { query: find('search'), architecture: find('architecture'), source: find('source') };
const platformButtons = [...document.querySelectorAll('[data-platform]')];
const sortButtons = [...document.querySelectorAll('#sort-seg [data-value]')];
const allowed = {
  platform: ['all', 'windows', 'windows-store', 'macos', 'linux', 'android', 'ios'],
  architecture: ['all', 'x64', 'x86', 'arm64'],
  source: ['all', 'official', 'archive', 'mirror'],
  sort: ['newest', 'oldest', 'downloads', 'likes'],
};
const params = new URLSearchParams(location.search);
const state = { query: params.get('q')?.slice(0, 100) ?? '', platform: 'windows', architecture: 'all', source: 'all', sort: 'newest' };
for (const key of Object.keys(allowed)) if (allowed[key].includes(params.get(key))) state[key] = params.get(key);
let entries = [];
let page = 0;
const pageSize = 30;
const counted = location.hostname === 'spotify-versions-history.robyrew.com';
const motionOk = !matchMedia('(prefers-reduced-motion: reduce)').matches;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function pill(item, label) {
  const live = item && !isExpired(item);
  const node = document.createElement(live ? 'a' : 'span');
  node.className = 'pill' + (!item ? ' is-missing' : isExpired(item) ? ' is-down' : '');
  node.append(document.createElement('i'), document.createTextNode(label));
  if (!item) node.title = 'No link on record';
  else {
    node.title = sourceNote(item);
    if (live) node.href = item.url;
  }
  return node;
}

function row(entry) {
  const tr = element('tr');
  tr.dataset.id = entry.id;
  const version = element('td');
  const link = element('a', entry.version, 'ver');
  link.href = `${base}release/?id=${encodeURIComponent(entry.id)}`;
  version.append(link, element('small', entry.fullVersion.split('.').at(-1), 'hash'));
  const platform = element('td');
  platform.append(element('span', platformNames[entry.platform] ?? entry.platform, 'platform-label'), element('small', `${entry.architecture} · ${entry.format.toUpperCase()}`));
  const date = element('td');
  date.append(element('time', entry.date ?? 'Not listed'), element('small', formatSize(entry.size)));
  const origins = element('td');
  const pills = originPills(entry);
  const group = element('span', null, 'pills');
  group.append(pill(pills.spotify, 'Spotify'), pill(pills.archive, 'Archive'), pill(pills.mirror, 'amd64fox'));
  origins.append(group);
  const counts = element('td', null, 'counts');
  counts.append(element('span', String(entry.likes ?? 0)), document.createTextNode(' likes · '), element('span', String(entry.comments ?? 0)));
  const ordered = orderedSources(entry, state.source);
  const source = ordered.find(candidate => !isExpired(candidate)) ?? ordered[0];
  const others = ordered.filter(candidate => candidate !== source);
  const action = element('td', null, 'row-action');
  if (!source || isExpired(source)) {
    const none = element('span', 'No download', 'download-link expired');
    if (source) none.title = sourceNote(source);
    action.append(none);
  } else {
    const download = element('a', 'Download', 'download-link');
    download.href = counted ? `/r/${entry.fullVersion}/${entry.platform}/${entry.architecture}` : source.url;
    if (entry.sha256) download.title = `SHA-256 ${entry.sha256}`;
    download.setAttribute('aria-label', `Download Spotify ${entry.fullVersion} for ${platformNames[entry.platform]} ${entry.architecture} from ${source.label}`);
    action.append(download);
  }
  const live = others.filter(other => !isExpired(other));
  if (live.length) {
    const alternatives = element('small', 'also: ', 'alt-links');
    for (const other of live) {
      const alt = element('a', other.label);
      alt.href = other.url;
      alt.title = sourceNote(other);
      alternatives.append(alt);
    }
    action.append(alternatives);
  }
  for (const other of others.filter(other => isExpired(other))) {
    const path = element('small', null, 'official-path');
    path.title = sourceNote(other);
    path.append(element('span', `${other.label} · expired`, 'expired-label'), element('code', other.url));
    action.append(path);
  }
  tr.append(version, platform, date, origins, counts, action);
  return tr;
}

function syncControls() {
  controls.query.value = state.query;
  controls.architecture.value = state.architecture;
  controls.source.value = state.source;
  for (const button of platformButtons) button.setAttribute('aria-checked', String(button.dataset.platform === state.platform));
  for (const button of sortButtons) button.setAttribute('aria-checked', String(button.dataset.value === state.sort));
}

function render(updateUrl = true, animate = false) {
  syncControls();
  const filtered = filterCatalog(entries, state);
  page = Math.max(0, Math.min(page, Math.ceil(filtered.length / pageSize) - 1));
  const slice = filtered.slice(page * pageSize, (page + 1) * pageSize);
  find('results').replaceChildren(...slice.map(row));
  find('empty').hidden = filtered.length > 0;
  const name = state.platform === 'all' ? 'all platforms' : (platformNames[state.platform] ?? state.platform);
  find('result-count').textContent = `${filtered.length.toLocaleString()} installer${filtered.length === 1 ? '' : 's'} for ${name}`;
  find('page-label').textContent = filtered.length ? `Showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filtered.length)} of ${filtered.length.toLocaleString()}` : 'No results';
  find('previous').disabled = page === 0;
  find('next').disabled = (page + 1) * pageSize >= filtered.length;
  if (updateUrl) {
    const query = new URLSearchParams();
    if (state.query) query.set('q', state.query);
    for (const [key, value] of Object.entries(state)) {
      const fallback = key === 'platform' ? 'windows' : key === 'sort' ? 'newest' : key === 'query' ? '' : 'all';
      if (key !== 'query' && value !== fallback) query.set(key, value);
    }
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query : '') + location.hash);
  }
  if (animate && motionOk && slice.length) gsap.from('#results > tr', { opacity: 0, y: 6, duration: 0.25, stagger: 0.012, overwrite: true });
}

function reset() {
  Object.assign(state, { query: '', platform: 'windows', architecture: 'all', source: 'all', sort: 'newest' });
  page = 0;
  render(true, true);
}

async function load() {
  find('load-error').hidden = true;
  try {
    const response = await fetch(catalogEl.dataset.api, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Catalog unavailable');
    const catalog = await response.json();
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) throw new Error('Unknown catalog');
    entries = catalog.entries;
    render(false, false);
    loadCounts();
  } catch { find('load-error').hidden = false; }
}

async function loadCounts() {
  try {
    const response = await fetch('/api/v1/counts', { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return;
    const counts = await response.json();
    for (const entry of entries) {
      const rowCounts = counts[entry.id];
      if (!rowCounts) continue;
      entry.downloads = rowCounts.downloads ?? 0;
      entry.likes = rowCounts.likes ?? 0;
      entry.comments = rowCounts.comments ?? 0;
    }
    render(false, false);
  } catch { /* counts exist only on the signed-in host */ }
}

for (const [key, control] of Object.entries(controls)) control.addEventListener(key === 'query' ? 'input' : 'change', () => {
  state[key] = control.value;
  page = 0;
  if (entries.length) render(true, key !== 'query');
});
find('platform-seg').addEventListener('rw:change', (event) => {
  const value = event.detail?.item?.dataset?.platform;
  if (!value) return;
  state.platform = value;
  page = 0;
  if (entries.length) render(true, true);
});
find('sort-seg').addEventListener('rw:change', (event) => {
  const value = event.detail?.item?.dataset?.value;
  if (!allowed.sort.includes(value)) return;
  state.sort = value;
  page = 0;
  if (entries.length) render(true, true);
});
find('reset').addEventListener('click', reset);
find('empty-reset').addEventListener('click', reset);
find('retry').addEventListener('click', load);
for (const [id, direction] of [['previous', -1], ['next', 1]]) find(id).addEventListener('click', () => {
  page += direction;
  render(false, true);
  catalogEl.scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    find('search').focus();
  }
});
syncControls();
load();
