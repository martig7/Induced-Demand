/**
 * Release helper — `npm run release`.
 *
 * Two-phase, so you can edit the notes before anything is published:
 *
 *   1. First run (no RELEASE_NOTES.md): drafts release notes for the current version
 *      (commit subjects since the last tag) into RELEASE_NOTES.md and stops. Edit that file.
 *   2. Second run (RELEASE_NOTES.md present): runs the tests, creates the annotated tag
 *      vX.Y.Z with your edited notes as its body, and pushes the branch + tag. The Release
 *      workflow (.github/workflows/release.yml) then builds and publishes the GitHub release
 *      (induced-demand-vX.Y.Z.zip + manifest.json), reading the notes from the tag body —
 *      the same format the Improved Schematics project uses.
 *
 * The tag version comes from src/version.ts (kept in sync with manifest.json / package.json
 * by the build), so bump that and rebuild before releasing.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { MOD_VERSION } from '../src/version';

const NOTES_FILE = 'RELEASE_NOTES.md';
const sh = (cmd: string): string => execSync(cmd, { encoding: 'utf8' }).trim();
const run = (cmd: string): void => execSync(cmd, { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as { version: string };
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const version = manifest.version;
const tag = `v${version}`;

// All three must agree, since the workflow verifies the tag against manifest/package.
if (manifest.version !== pkg.version || manifest.version !== MOD_VERSION) {
  console.error(`✗ Version mismatch: version.ts=${MOD_VERSION}, manifest.json=${manifest.version}, package.json=${pkg.version}`);
  console.error('  Bump src/version.ts, run `npm run build`, and commit so all three agree, then retry.');
  process.exit(1);
}

if (!existsSync(NOTES_FILE)) {
  // ---- Phase 1: draft the notes ----
  let range = '';
  try {
    const last = execSync('git describe --tags --abbrev=0', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    range = `${last}..HEAD`;
  } catch { /* no prior tag: fall back to recent history */ }
  const raw = sh(range ? `git log ${range} --pretty=format:%s` : 'git log --pretty=format:%s -40');
  const bullets = raw.split('\n').filter(Boolean).filter((s) => !s.startsWith('Merge '))
    .map((s) => `- ${s}`).join('\n') || '- (describe the changes)';
  const draft =
    `Induced Demand ${tag}\n\n` +           // first line = tag subject; NOT part of the release body
    `## What's new in ${tag}\n\n${bullets}\n`;
  writeFileSync(NOTES_FILE, draft);
  console.log(`✍  Draft release notes for ${tag} written to ${NOTES_FILE}.`);
  console.log('   Edit it (keep the first line as the tag subject), then run `npm run release` again to');
  console.log(`   tag ${tag} and push — the Release workflow publishes induced-demand-${tag}.zip + manifest.json.`);
  process.exit(0);
}

// ---- Phase 2: tag + push (RELEASE_NOTES.md present = your edited draft) ----
const dirty = sh('git status --porcelain');
if (dirty) {
  console.error(`✗ Working tree has uncommitted changes — commit them first so ${tag} points at a clean state:\n${dirty}`);
  process.exit(1);
}
if (sh('git tag -l').split('\n').includes(tag)) {
  console.error(`✗ Tag ${tag} already exists. Bump the version (src/version.ts + rebuild) or delete the tag first.`);
  process.exit(1);
}

console.log('▶ Running tests before tagging…');
run('npm test');

console.log(`▶ Tagging ${tag} with your notes and pushing…`);
run(`git tag -a ${tag} -F ${NOTES_FILE}`);
run('git push origin HEAD');
run(`git push origin ${tag}`);
rmSync(NOTES_FILE);

console.log(`✓ Pushed ${tag}. The Release workflow will build and publish the GitHub release.`);
console.log('  Watch it with: gh run watch   (or the repo Actions tab)');
