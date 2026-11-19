import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadTrust, type TrustAnchors } from '../../lib/trust.ts';
import type { Fetch } from '../../sensors/types.ts';

export const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export const fixture = (path: string) => readFile(here(`../../testdata/channels/${path}`));
export const fixtureText = async (path: string) => (await fixture(path)).toString('utf8');
export const trust = (): Promise<TrustAnchors> => loadTrust(here('../../ledger/trust/anchors.json'));

/** Header lines of a recorded HEAD response (testdata/channels/<platform>/head-*.txt). */
export function headersFixture(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0 && !line.startsWith('HTTP/')) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

export interface FakeFile { bytes: Uint8Array; etag: string; headers?: Record<string, string> }
export interface FakeBody { body: string | Uint8Array; status?: number; headers?: Record<string, string> }
export interface Call { url: string; method: string; headers: Record<string, string> }

/** A fetch serving fixed responses: files answer HEAD, Range and If-Match the way download.scdn.co does. */
export function fakeFetch(routes: Record<string, FakeFile | FakeBody>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ url, method, headers });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    if ('bytes' in route) {
      const base = { etag: route.etag, 'content-type': 'application/octet-stream', ...route.headers };
      if (headers['if-match'] && headers['if-match'] !== route.etag) return new Response(null, { status: 412 });
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'content-length': String(route.bytes.length) } });
      const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), route.bytes.length - 1);
        const slice = route.bytes.slice(start, end + 1);
        return new Response(slice as unknown as ConstructorParameters<typeof Response>[0], { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${route.bytes.length}`, 'content-length': String(slice.length) } });
      }
      return new Response(route.bytes as unknown as ConstructorParameters<typeof Response>[0], { status: 200, headers: { ...base, 'content-length': String(route.bytes.length) } });
    }
    return new Response(method === 'HEAD' ? null : route.body as unknown as ConstructorParameters<typeof Response>[0], { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetch: fetchImpl as Fetch, calls };
}

/**
 * A minimal PE32+ image: one .rsrc section holding a VS_VERSIONINFO-style ProductVersion string and a
 * certificate table entry, padded past 4 KB like a real installer's headers.
 */
export function syntheticPe(machine: number, productVersion: string): Uint8Array {
  const peOffset = 0x80;
  const optionalSize = 0xf0;
  const rsrcPointer = 0x1000;
  const resources = Buffer.concat([Buffer.alloc(96), Buffer.from('ProductVersion\0', 'utf16le'), Buffer.alloc(2), Buffer.from(productVersion, 'utf16le'), Buffer.alloc(2)]);
  const rsrcSize = Math.ceil(resources.length / 0x200) * 0x200;
  const certificate = Buffer.from('certificate table placeholder');
  const certOffset = rsrcPointer + rsrcSize;
  const image = Buffer.alloc(certOffset + certificate.length);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(peOffset, 0x3c);
  image.writeUInt32LE(0x00004550, peOffset);
  image.writeUInt16LE(machine, peOffset + 4);
  image.writeUInt16LE(1, peOffset + 6);
  image.writeUInt16LE(optionalSize, peOffset + 20);
  const optional = peOffset + 24;
  image.writeUInt16LE(0x20b, optional);
  image.writeUInt32LE(certOffset, optional + 112 + 32);
  image.writeUInt32LE(certificate.length, optional + 112 + 36);
  const section = optional + optionalSize;
  image.write('.rsrc', section, 'latin1');
  image.writeUInt32LE(rsrcSize, section + 16);
  image.writeUInt32LE(rsrcPointer, section + 20);
  resources.copy(image, rsrcPointer);
  certificate.copy(image, certOffset);
  return new Uint8Array(image);
}
