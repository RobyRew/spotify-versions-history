import type { Reply } from '@robyrew/bot-sdk'

export interface SpotifyRef {
  kind: 'track' | 'album' | 'playlist' | 'artist' | 'episode' | 'show'
  id: string
}

const HOSTS = new Set(['open.spotify.com', 'api.spotify.com', 'accounts.spotify.com', 'i.scdn.co', 'p.scdn.co', 'spotify.link'])

export function parseSpotifyUrl(raw: string): SpotifyRef | null {
  const match = raw.match(/https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/i)
  if (!match) return null
  const kind = match[1].toLowerCase() as SpotifyRef['kind']
  return { kind, id: match[2] }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
let fetchAllowed: FetchLike = (url, init) => {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname)) {
    return Promise.reject(new Error('host'))
  }
  return fetch(parsed, { ...init, redirect: 'manual' })
}

/** Tests replace the network. */
export function setSpotifyFetch(fn: FetchLike | null): void {
  fetchAllowed = fn ?? ((url, init) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname)) return Promise.reject(new Error('host'))
    return fetch(parsed, { ...init, redirect: 'manual' })
  })
}

interface Image { url: string }
interface TrackItem {
  name?: string
  artists?: { name?: string }[]
  album?: { images?: Image[] }
  preview_url?: string | null
}
interface SpotifyObject {
  name?: string
  description?: string
  artists?: { name?: string }[]
  album?: { name?: string; images?: Image[] }
  images?: Image[]
  preview_url?: string | null
  tracks?: { items?: (TrackItem | { track?: TrackItem | null })[] }
  owner?: { display_name?: string }
}

let tokenCache: { value: string; until: number } | null = null

export function clearSpotifyToken(): void {
  tokenCache = null
}

async function appToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID
  const secret = process.env.SPOTIFY_CLIENT_SECRET
  if (!id || !secret) return null
  if (tokenCache && tokenCache.until > Date.now()) return tokenCache.value
  const res = await fetchAllowed('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) return null
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) return null
  tokenCache = { value: body.access_token, until: Date.now() + Math.max(30, (body.expires_in ?? 3600) - 60) * 1000 }
  return body.access_token
}

async function readCap(res: Response, cap: number): Promise<Uint8Array> {
  const claimed = Number(res.headers.get('content-length') ?? '0')
  if (claimed > cap) throw new Error('big')
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength > cap) throw new Error('big')
  return bytes
}

function names(artists: { name?: string }[] | undefined): string {
  return (artists ?? []).map((artist) => artist.name).filter(Boolean).join(', ')
}

function rows(object: SpotifyObject): string[] {
  const items = object.tracks?.items ?? []
  const lines: string[] = []
  for (const item of items) {
    const track = 'track' in item ? item.track : item
    if (!track?.name) continue
    const who = names(track.artists)
    lines.push(who ? `${lines.length + 1}. ${who} — ${track.name}` : `${lines.length + 1}. ${track.name}`)
    if (lines.length === 40) break
  }
  return lines
}

async function imageFile(url: string | undefined): Promise<Reply | null> {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'i.scdn.co') return null
  const res = await fetchAllowed(parsed.toString())
  if (!res.ok) return null
  const body = await readCap(res, 5 * 1024 * 1024)
  return { kind: 'file', filename: 'artwork.jpg', mime: 'image/jpeg', body, caption: 'artwork' }
}

async function previewFile(url: string | null | undefined): Promise<Reply | null> {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'p.scdn.co') return null
  const res = await fetchAllowed(parsed.toString())
  if (!res.ok) return null
  const body = await readCap(res, 2 * 1024 * 1024)
  return { kind: 'file', filename: 'preview.mp3', mime: 'audio/mpeg', body, caption: '30-second preview published by Spotify' }
}

/** Metadata, artwork, playlist rows, and Spotify's own 30-second preview. No full audio. */
export async function openSpotify(ref: SpotifyRef): Promise<Reply[]> {
  const token = await appToken()
  if (!token) {
    const embed = await fetchAllowed(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${ref.kind}/${ref.id}`)}`)
    if (!embed.ok) return [{ kind: 'text', text: 'Spotify did not publish that link.' }]
    const body = (await embed.json()) as { title?: string; author_name?: string; thumbnail_url?: string }
    const art = await imageFile(body.thumbnail_url).catch(() => null)
    const text = [body.title, body.author_name].filter(Boolean).join('\n') || ref.id
    return art ? [{ kind: 'text', text }, art] : [{ kind: 'text', text }]
  }
  const res = await fetchAllowed(`https://api.spotify.com/v1/${ref.kind}s/${ref.id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return [{ kind: 'text', text: `Spotify answered HTTP ${res.status}.` }]
  const object = (await res.json()) as SpotifyObject
  const title = object.name ?? ref.id
  const who = names(object.artists)
  const album = object.album?.name
  const list = rows(object)
  const more = (object.tracks?.items?.length ?? 0) > list.length ? `\n…` : ''
  const text = [title, who, album, object.description, list.join('\n') + more].filter(Boolean).join('\n')
  const artUrl = object.images?.[0]?.url ?? object.album?.images?.[0]?.url
  const preview = object.preview_url ?? object.tracks?.items?.map((item) => ('track' in item ? item.track?.preview_url : item.preview_url)).find(Boolean)
  const files = await Promise.all([imageFile(artUrl).catch(() => null), previewFile(preview).catch(() => null)])
  return [{ kind: 'text', text }, ...files.filter((file): file is Reply => file !== null)]
}
