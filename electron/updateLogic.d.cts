// Types for electron/updateLogic.cjs (used by tests/updater.test.ts).
import type { KeyObject } from 'node:crypto';

export interface FileRef { readonly name: string; readonly sha256: string; readonly size?: number }
export interface Manifest {
  readonly schema: 1;
  readonly version: string;
  readonly minShell: string;
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
  readonly installers: { readonly setup?: FileRef; readonly portable?: FileRef };
}
export interface Feed { readonly version: string; readonly manifestName: string; readonly sigName: string; readonly assets: Readonly<Record<string, string>> }
export interface BundleState { readonly bad: readonly string[]; readonly confirmed: readonly string[]; readonly trial: { readonly version: string; readonly attempts: number } | null }
export type ManifestCheck =
  | { ok: true; manifest: Manifest; kind: 'bundle' | 'installer' }
  | { ok: false; stage: 'signature' | 'manifest' | 'minShell'; error: string };
export type Decision = 'up-to-date' | 'known-bad' | 'installer' | 'already-installed' | 'download';

export const FEED_URL: string;
export const ALLOWED_HOSTS: readonly string[];
export const LIMITS: { readonly feedBytes: number; readonly manifestBytes: number; readonly sigBytes: number; readonly bundleBytes: number; readonly installerBytes: number };
export const MAX_UNCONFIRMED_LAUNCHES: number;
export const KEEP_BUNDLES: number;
export const PLACEHOLDER_KEY: string;
export const EMPTY_STATE: BundleState;

export function parseSemver(raw: unknown): [number, number, number] | null;
export function compareSemver(a: string, b: string): number | null;
export function isNewer(candidate: string, current: string): boolean;
export function isStrictVersion(v: unknown): v is string;
export function isAllowedUrl(raw: unknown, opts?: { allowLocal?: boolean }): boolean;
export function resolveFeed(env: Record<string, string | undefined>, isPackaged: boolean): { url: string; allowLocal: boolean } | null;
export function parseFeed(json: unknown, opts?: { allowLocal?: boolean }): Feed | null;
export function validateManifest(m: unknown): { ok: true; manifest: Manifest } | { ok: false; error: string };
export function isPlaceholderKey(key: unknown): boolean;
export function loadPublicKey(b64: string): KeyObject;
export function verifySignature(data: Uint8Array | string, sigText: string, publicKeyB64: string): boolean;
export function signManifest(data: Uint8Array | string, privateKey: KeyObject): string;
export function sha256(buf: Uint8Array | string): string;
export function checkManifest(args: { manifestBytes: Uint8Array; sigText: string; publicKey: string; shellVersion: string; feedVersion?: string }): ManifestCheck;
export function checkPayload(expected: { size?: number; sha256: string }, actual: { size: number; sha256: string }): { ok: true } | { ok: false; stage: 'size' | 'sha256'; error: string };
export function decide(args: { manifest: Manifest; kind: 'bundle' | 'installer'; servingVersion: string; installed?: readonly string[]; bad?: readonly string[] }): Decision;
export function shellCompatible(manifestText: string, shellVersion: string): boolean;
export function portableRelaunchPath(file: unknown, exists: (f: string) => boolean): string | null;
export function pickInstaller(manifest: Manifest, isPortable: boolean): FileRef | null;
export function normalizeState(raw: unknown): BundleState;
export function pickServed(state: BundleState, installed: readonly string[], builtinVersion: string): string | null;
export function markBad(state: BundleState, version: string): BundleState;
export function onLaunch(state: unknown, installed: readonly string[], builtinVersion: string): { state: BundleState; serve: string | null };
export function onReady(state: unknown, version: string): BundleState;
export function onFailure(state: unknown, version: string): BundleState;
export function toPrune(state: unknown, installed: readonly string[], serving: string | null): string[];
