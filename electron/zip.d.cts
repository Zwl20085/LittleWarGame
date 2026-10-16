// Types for electron/zip.cjs (used by tests/updater.test.ts).
export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number; maxNameLength: number }
export interface ZipEntry { readonly path: string; readonly dir: boolean; readonly data: Buffer | null }

export const DEFAULT_LIMITS: Readonly<ZipLimits>;
export const S_IFLNK: number;
export const S_IFREG: number;
export class ZipError extends Error {}
export function crc32(buf: Uint8Array): number;
export function safeEntryPath(name: unknown, maxLen?: number): string | null;
export function writeZip(entries: readonly { name: string; data: Uint8Array | string; mode?: number }[]): Buffer;
export function readZip(buf: Buffer, limits?: Partial<ZipLimits>): ZipEntry[];
