// Types for electron/bundle.cjs (used by tests/updater.test.ts).
import type { BundleState } from './updateLogic.cjs';

export const MANIFEST_FILE: string;
export function readState(dir: string): BundleState;
export function writeState(dir: string, state: BundleState): void;
export function listInstalled(dir: string, shellVersion?: string): string[];
export function bundlePath(dir: string, version: string): string;
export function installBundle(dir: string, version: string, zipBuf: Buffer, manifestBytes: Uint8Array): string;
export function removeBundles(dir: string, versions: readonly string[]): void;
export function cleanupStaging(dir: string): void;
export function writeFileAtomic(file: string, data: string | Uint8Array): void;
export function insideRoot(root: string, rel: string): string;
