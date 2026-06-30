/** Copy dist/ into the game's mods folder. Runs after `build` via `postbuild`. */
import { existsSync, mkdirSync, rmSync, cpSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';

const MODS_PATHS: Record<string, string> = {
  darwin: `${process.env.HOME}/Library/Application Support/metro-maker4/mods`,
  win32: `${process.env.APPDATA}\\metro-maker4\\mods`,
  linux: `${process.env.HOME}/.config/metro-maker4/mods`,
};

function getModId(): string {
  const manifestPath = join(process.cwd(), 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const parts: string[] = manifest.id?.split('.') || [];
      return parts[parts.length - 1] || 'my-mod';
    } catch { /* fall through */ }
  }
  return 'my-mod';
}

const modsPath = MODS_PATHS[process.platform];
if (!modsPath) { console.error(`Unsupported platform: ${process.platform}`); process.exit(1); }
const distPath = join(process.cwd(), 'dist');
const targetPath = join(modsPath, getModId());
if (!existsSync(distPath)) { console.error('dist/ not found. Run build first.'); process.exit(1); }
if (!existsSync(modsPath)) mkdirSync(modsPath, { recursive: true });
if (existsSync(targetPath)) { lstatSync(targetPath); rmSync(targetPath, { recursive: true, force: true }); }
cpSync(distPath, targetPath, { recursive: true });
console.log(`Installed mod to: ${targetPath}`);
