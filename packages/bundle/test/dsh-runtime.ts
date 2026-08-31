import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

interface EntryOptions {
  readonly id?: string;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly config?: unknown;
  readonly group?: boolean;
}

interface PatchOptions {
  readonly id?: string;
  readonly insert?: EntryOptions[];
  readonly [key: string]: unknown;
}

interface AppBootRuntime {
  composeEntries(layers: readonly PatchOptions[][], warn?: (message: string) => void): EntryOptions[];
  loadOverlayPatches(binName: string, file: string): PatchOptions[];
}

export interface InstalledDshRuntime {
  readonly appBoot: AppBootRuntime;
  readonly version: string;
  resolve(specifier: string): string;
}

export function dshRuntimeAvailable(): boolean {
  if (process.env.DSH_TEST_PACKAGE_ROOT !== undefined) return true;
  try {
    findDshPackageRoot();
    return true;
  } catch {
    return false;
  }
}

export async function installedDshRuntime(): Promise<InstalledDshRuntime> {
  const packageRoot = process.env.DSH_TEST_PACKAGE_ROOT ?? findDshPackageRoot();
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: string };
  const requireFromDsh = createRequire(join(packageRoot, 'package.json'));
  const appBoot = await import(requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')) as AppBootRuntime;
  if (typeof manifest.version !== 'string') throw new Error(`invalid DSH manifest at ${packageRoot}`);
  return {
    appBoot,
    version: manifest.version,
    resolve: (specifier) => requireFromDsh.resolve(specifier),
  };
}

function findDshPackageRoot(): string {
  for (const searchDir of (process.env.PATH ?? '').split(delimiter)) {
    if (searchDir === '') continue;
    const candidate = join(searchDir, 'dsh');
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return dirname(dirname(realpathSync(candidate)));
    } catch {
      // Keep looking for an executable DSH installation later in PATH.
    }
  }
  throw new Error('DSH executable not found in PATH; set DSH_TEST_PACKAGE_ROOT to its package root');
}
