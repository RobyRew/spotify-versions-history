import { filterCatalog, orderedSources, sourceNote, isExpired, formatSize, platformNames } from './catalog.mjs';

const find = id => document.getElementById(id);
const controls = { query: find('search'), architecture: find('architecture'), source: find('source'), sort: find('sort') };
const tabs = [...document.querySelectorAll('[data-platform]')];
const allowed = { platform: ['all', 'windows', 'macos', 'linux'], architecture: ['all', 'x64', 'x86', 'arm64'], source: ['all', 'official', 'archive', 'mirror'], sort: ['newest', 'oldest'] };
const params = new URLSearchParams(location.search);
const state = { query: params.get('q')?.slice(0, 100) ?? '', platform: 'windows', architecture: 'all', source: 'all', sort: 'newest' };
for (const key of Object.keys(allowed)) if (allowed[key].includes(params.get(key))) state[key] = params.get(key);
let entries = [], page = 0;
const pageSize = 30;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function row(entry) {
  const tr = element('tr');
  const version = element('td');
  version.append(element('strong', entry.version));
  version.append(element('small', entry.fullVersion.split('.').at(-1), 'hash'));
  const platform = element('td');
  platform.append(element('span', platformNames[entry.platform], 'platform-label'), element('small', `${entry.architecture} · ${entry.format.toUpperCase()}`));
  const date = element('td');
  date.append(element('span', entry.date ?? 'Not listed'), element('small', formatSize(entry.size)));
  const ordered = orderedSources(entry, state.source);
  const source = ordered.find(candidate => !isExpired(candidate)) ?? ordered[0];
  const others = ordered.filter(candidate => candidate !== source);
  const sourceCell = element('td');
  sourceCell.append(element('span', source.label, `source-label ${source.kind}`), element('small', sourceNote(source)));
  const action = element('td', null, 'row-action');
  if (isExpired(source)) {
    const none = element('span', 'No download', 'download-link expired');
    none.title = sourceNote(source);
    action.append(none);
  } else {
    const download = element('a', 'Download ↗', 'download-link');
    download.href = source.url;
    if (entry.sha256) download.title = `SHA-256 ${entry.sha256}`;
    download.setAttribute('aria-label', `Download Spotify ${entry.fullVersion} for ${platformNames[entry.platform]} ${entry.architecture} from ${source.label}`);
    action.append(download);
  }
  const live = others.filter(other => !isExpired(other));
  if (live.length) {
    const alternatives = element('small', 'also: ', 'alt-links');
    for (const other of live) {
      const link = element('a', other.label);
      link.href = other.url; link.title = sourceNote(other);
      link.setAttribute('aria-label', `Download Spotify ${entry.fullVersion} for ${platformNames[entry.platform]} ${entry.architecture} from ${other.label}`);
      alternatives.append(link);
    }
    action.append(alternatives);
  }
  // Spotify's own paths stay on the row as a record of the build, selectable, even once they answer 403.
  for (const other of others.filter(other => isExpired(other))) {
    const path = element('small', null, 'official-path');
    path.title = sourceNote(other);
    path.append(element('span', `${other.label} · expired`, 'expired-label'), element('code', other.url));
    action.append(path);
  }
  tr.append(version, platform, date, sourceCell, action);
  return tr;
}
function syncControls() {
  for (const [key, control] of Object.entries(controls)) control.value = state[key];
  tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.platform === state.platform)));
}
function render(updateUrl = true) {
  syncControls();
  const filtered = filterCatalog(entries, state);
  page = Math.max(0, Math.min(page, Math.ceil(filtered.length / pageSize) - 1));
  find('results').replaceChildren(...filtered.slice(page * pageSize, (page + 1) * pageSize).map(row));
  find('empty').hidden = filtered.length > 0;
  find('result-count').textContent = `${filtered.length.toLocaleString()} installer${filtered.length === 1 ? '' : 's'}${state.platform === 'all' ? ' across all platforms' : ` for ${platformNames[state.platform]}`}`;
  find('page-label').textContent = filtered.length ? `Showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filtered.length)} of ${filtered.length.toLocaleString()}` : 'No results';
  find('previous').disabled = page === 0;
  find('next').disabled = (page + 1) * pageSize >= filtered.length;
  if (updateUrl) {
    const query = new URLSearchParams();
    if (state.query) query.set('q', state.query);
    for (const [key, value] of Object.entries(state)) if (key !== 'query' && value !== (key === 'platform' ? 'windows' : key === 'sort' ? 'newest' : 'all')) query.set(key, value);
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query : '') + location.hash);
  }
}
function reset() {
  Object.assign(state, { query: '', platform: 'windows', architecture: 'all', source: 'all', sort: 'newest' });
  page = 0; render();
}
async function load() {
  find('load-error').hidden = true;
  try {
    const response = await fetch(find('catalog').dataset.api, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Catalog unavailable');
    const catalog = await response.json();
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.entries)) throw new Error('Unknown catalog');
    entries = catalog.entries;
    render(false);
  } catch { find('load-error').hidden = false; }
}
for (const [key, control] of Object.entries(controls)) control.addEventListener(key === 'query' ? 'input' : 'change', () => { state[key] = control.value; page = 0; if (entries.length) render(); });
tabs.forEach(tab => tab.addEventListener('click', () => { state.platform = tab.dataset.platform; page = 0; if (entries.length) render(); }));
find('reset').addEventListener('click', reset);
find('empty-reset').addEventListener('click', reset);
find('retry').addEventListener('click', load);
for (const [id, direction] of [['previous', -1], ['next', 1]]) find(id).addEventListener('click', () => { page += direction; render(); find('catalog').scrollIntoView({ block: 'start' }); });
find('theme-toggle').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('catalog-theme', theme); } catch {}
});
document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { event.preventDefault(); find('search').focus(); }
});
syncControls();
load();
