import { isDigestHour, madrid, tr, type BotModule, type Lang, type Reply, type TickMessage } from '@robyrew/bot-sdk'

export interface CatalogEntry {
  version: string
  fullVersion?: string
  platform: string
  architecture: string
  date?: string
  sha256?: string
  hash?: string
  sources?: { url?: string }[]
}

export interface CatalogFile {
  entries?: CatalogEntry[]
}

const PLATFORMS = ['windows', 'macos', 'linux'] as const
const ARCHS = ['x64', 'arm64', 'x86'] as const
const EVERY = ['weekly', 'monthly', 'quarterly'] as const
type Every = (typeof EVERY)[number]

const help: Record<Lang, string> = {
  en: 'Search desktop build versions. /spotify 1.2.96 — follow with /spotify follow windows arm64 weekly. Digests are weekly, monthly, or every 3 months, at 08:00 Madrid. No audio and no installers.',
  ro: 'Caută versiuni desktop. /spotify 1.2.96 — abonare cu /spotify follow windows arm64 weekly. Rezumatul e săptămânal, lunar sau la 3 luni, la 08:00 Madrid. Fără audio și fără instalatoare.',
  es: 'Busca versiones de escritorio. /spotify 1.2.96 — suscripción con /spotify follow windows arm64 weekly. El resumen es semanal, mensual o cada 3 meses, a las 08:00 en Madrid. Sin audio y sin instaladores.',
}

let loadCatalog: () => Promise<CatalogFile> = async () => {
  const res = await fetch('https://robyrew.github.io/spotify-versions-history/api/v1/catalog.json')
  if (!res.ok) throw new Error(`catalog HTTP ${res.status}`)
  return (await res.json()) as CatalogFile
}

/** Tests replace the network fetch. */
export function setCatalogLoader(fn: () => Promise<CatalogFile>): void {
  loadCatalog = fn
}

function line(entry: CatalogEntry): string {
  const hash = entry.sha256 || entry.hash || ''
  const url = entry.sources?.find((s) => s.url)?.url ?? ''
  return [entry.version, entry.date ?? '', entry.platform, entry.architecture, hash, url].filter(Boolean).join(' · ')
}

function search(entries: CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries.slice(0, 8)
  return entries.filter((e) => `${e.version} ${e.fullVersion ?? ''} ${e.platform} ${e.architecture}`.toLowerCase().includes(q)).slice(0, 8)
}

interface Sub {
  platform: string
  architecture: string
  every: Every
  lastSent: string
}

function parseSub(raw: string | null): Sub | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Sub
  } catch {
    return null
  }
}

function due(every: Every, lastSent: string, today: string): boolean {
  if (!lastSent) return true
  const prev = new Date(`${lastSent}T00:00:00Z`).getTime()
  const now = new Date(`${today}T00:00:00Z`).getTime()
  const days = Math.round((now - prev) / 86_400_000)
  if (every === 'weekly') return days >= 7
  if (every === 'monthly') return days >= 28
  return days >= 89
}

export const spotifyModule: BotModule = {
  id: 'spotify',
  commands: ['spotify'],
  bucket: 'lookup',
  signIn: 'no',
  menu: (lang) => tr(lang, { en: 'Spotify versions', ro: 'Versiuni Spotify', es: 'Versiones de Spotify' }),
  help: (lang) => help[lang],
  async handle(input, api) {
    const args = input.args.trim()
    if (args.startsWith('follow')) {
      const [, platform, architecture, every] = args.split(/\s+/)
      if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number]) || !ARCHS.includes(architecture as (typeof ARCHS)[number]) || !EVERY.includes(every as Every)) {
        return { kind: 'text', text: help[input.lang] }
      }
      const sub: Sub = { platform, architecture, every: every as Every, lastSent: '' }
      api.set('sub', JSON.stringify(sub))
      return {
        kind: 'text',
        text: tr(input.lang, {
          en: `Digest saved: ${platform} ${architecture}, ${every}. It arrives at 08:00 Europe/Madrid.`,
          ro: `Rezumat salvat: ${platform} ${architecture}, ${every}. Ajunge la 08:00 Europa/Madrid.`,
          es: `Resumen guardado: ${platform} ${architecture}, ${every}. Llega a las 08:00 Europe/Madrid.`,
        }),
      }
    }
    if (args === 'stop') {
      api.del('sub')
      return { kind: 'text', text: tr(input.lang, { en: 'Digest stopped.', ro: 'Rezumat oprit.', es: 'Resumen parado.' }) }
    }
    let catalog: CatalogFile
    try {
      catalog = await loadCatalog()
    } catch {
      return {
        kind: 'text',
        text: tr(input.lang, {
          en: 'Spotify versions is offline.',
          ro: 'Versiunile Spotify sunt oprite.',
          es: 'Las versiones de Spotify están apagadas.',
        }),
      }
    }
    const hits = search(catalog.entries ?? [], args)
    if (hits.length === 0) {
      return { kind: 'text', text: tr(input.lang, { en: 'No build matched.', ro: 'Nicio versiune nu s-a potrivit.', es: 'Ninguna versión ha coincidido.' }) }
    }
    const reply: Reply = { kind: 'text', text: hits.map(line).join('\n') }
    return reply
  },
  async tick(api, now): Promise<TickMessage[]> {
    if (!isDigestHour(now)) return []
    const today = madrid(now).date
    let catalog: CatalogFile
    try {
      catalog = await loadCatalog()
    } catch {
      return []
    }
    const messages: TickMessage[] = []
    for (const userId of api.usersWith('sub')) {
      const sub = parseSub(api.getFor(userId, 'sub'))
      if (!sub || !due(sub.every, sub.lastSent, today)) continue
      const chatId = api.privateChat(userId)
      if (!chatId) continue
      const hits = (catalog.entries ?? []).filter((e) => e.platform === sub.platform && e.architecture === sub.architecture).slice(0, 5)
      sub.lastSent = today
      api.setFor(userId, 'sub', JSON.stringify(sub))
      messages.push({
        userId,
        chatId,
        reply: {
          kind: 'text',
          text: hits.length ? hits.map(line).join('\n') : `${sub.platform} ${sub.architecture}: no builds in the catalog`,
        },
      })
    }
    return messages
  },
}
