/** Reads regular files out of a ustar/GNU tar archive held in memory, with bounds checks. */

export class TarError extends Error {
  override name = 'TarError';
}

const BLOCK = 512;

function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString('utf8');
}

function octal(header: Uint8Array, start: number, length: number, what: string): number {
  const text = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new TarError(`${what} "${text}" is not an octal number`);
  return Number.parseInt(text, 8);
}

/** Regular files by name ("./control" and "control" both appear in .deb control archives). */
export function tarFiles(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let at = 0;
  while (at + BLOCK <= archive.length) {
    const header = archive.subarray(at, at + BLOCK);
    if (header.every(byte => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < BLOCK; index++) checksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (checksum !== octal(header, 148, 8, 'header checksum')) throw new TarError(`the header at ${at} has a wrong checksum`);
    const prefix = field(header, 345, 155);
    const name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
    const size = octal(header, 124, 12, `${name} size`);
    const type = String.fromCharCode(header[156]!);
    const start = at + BLOCK;
    if (start + size > archive.length) throw new TarError(`${name} runs past the end of the archive`);
    if (type === '0' || type === '\0') {
      if (files.has(name)) throw new TarError(`the archive holds ${name} twice`);
      files.set(name, archive.subarray(start, start + size));
    }
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
