#!/usr/bin/env node
/**
 * One-shot reorg: move files into subfolders + rewrite relative imports.
 * Usage: node scripts/reorg-src.mjs
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, basename, extname } from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Record<string, string>} oldRel → newRel (from repo root) */
const MOVES = {
  // —— web components ——
  'web/src/components/Layout.tsx': 'web/src/components/layout/Layout.tsx',
  'web/src/components/BackButton.tsx': 'web/src/components/layout/BackButton.tsx',
  'web/src/components/BrandLogo.tsx': 'web/src/components/layout/BrandLogo.tsx',
  'web/src/components/InstallBanner.tsx': 'web/src/components/layout/InstallBanner.tsx',
  'web/src/components/OfflineBanner.tsx': 'web/src/components/layout/OfflineBanner.tsx',
  'web/src/components/ProxyHealthBanner.tsx': 'web/src/components/layout/ProxyHealthBanner.tsx',
  'web/src/components/PerfHud.tsx': 'web/src/components/layout/PerfHud.tsx',

  'web/src/components/PlayerBar.tsx': 'web/src/components/player/PlayerBar.tsx',
  'web/src/components/NowPlaying.tsx': 'web/src/components/player/NowPlaying.tsx',
  'web/src/components/QueuePanel.tsx': 'web/src/components/player/QueuePanel.tsx',
  'web/src/components/PlayingBars.tsx': 'web/src/components/player/PlayingBars.tsx',
  'web/src/components/EqualizerPanel.tsx': 'web/src/components/player/EqualizerPanel.tsx',
  'web/src/components/SaveQueueSheet.tsx': 'web/src/components/player/SaveQueueSheet.tsx',

  'web/src/components/CoverImage.tsx': 'web/src/components/media/CoverImage.tsx',
  'web/src/components/MediaCard.tsx': 'web/src/components/media/MediaCard.tsx',
  'web/src/components/MixCollageCard.tsx': 'web/src/components/media/MixCollageCard.tsx',
  'web/src/components/TrackRow.tsx': 'web/src/components/media/TrackRow.tsx',
  'web/src/components/ArtistLinks.tsx': 'web/src/components/media/ArtistLinks.tsx',
  'web/src/components/HomeShelfSkeleton.tsx': 'web/src/components/media/HomeShelfSkeleton.tsx',

  'web/src/components/AuthModal.tsx': 'web/src/components/auth/AuthModal.tsx',
  'web/src/components/DevicePicker.tsx': 'web/src/components/auth/DevicePicker.tsx',
  'web/src/components/OnboardingWizard.tsx': 'web/src/components/auth/OnboardingWizard.tsx',

  'web/src/components/ItemActionsSheet.tsx': 'web/src/components/sheets/ItemActionsSheet.tsx',
  'web/src/components/SearchIdentifySheet.tsx': 'web/src/components/sheets/SearchIdentifySheet.tsx',

  // —— web lib ——
  'web/src/lib/equalizer.ts': 'web/src/lib/audio/equalizer.ts',
  'web/src/lib/silenceSkip.ts': 'web/src/lib/audio/silenceSkip.ts',
  'web/src/lib/backgroundAudio.ts': 'web/src/lib/audio/backgroundAudio.ts',
  'web/src/lib/streamPrefetch.ts': 'web/src/lib/audio/streamPrefetch.ts',
  'web/src/lib/holdSeek.ts': 'web/src/lib/audio/holdSeek.ts',
  'web/src/lib/mediaKeys.ts': 'web/src/lib/audio/mediaKeys.ts',

  'web/src/lib/passkeyEnrollment.ts': 'web/src/lib/auth/passkeyEnrollment.ts',
  'web/src/lib/session.ts': 'web/src/lib/auth/session.ts',
  'web/src/lib/syncPrefs.ts': 'web/src/lib/auth/syncPrefs.ts',

  'web/src/lib/lyricSync.ts': 'web/src/lib/player/lyricSync.ts',
  'web/src/lib/sleepTimer.ts': 'web/src/lib/player/sleepTimer.ts',
  'web/src/lib/nowPlaying.ts': 'web/src/lib/player/nowPlaying.ts',
  'web/src/lib/cast.ts': 'web/src/lib/player/cast.ts',

  'web/src/lib/offlineCache.ts': 'web/src/lib/offline/offlineCache.ts',
  'web/src/lib/connectivity.ts': 'web/src/lib/offline/connectivity.ts',

  'web/src/lib/time.ts': 'web/src/lib/util/time.ts',
  'web/src/lib/appVersion.ts': 'web/src/lib/util/appVersion.ts',
  'web/src/lib/perf.ts': 'web/src/lib/util/perf.ts',
  'web/src/lib/telemetry.ts': 'web/src/lib/util/telemetry.ts',
  'web/src/lib/native.ts': 'web/src/lib/util/native.ts',
  'web/src/lib/mixCache.ts': 'web/src/lib/util/mixCache.ts',

  // —— web pages ——
  'web/src/pages/HomePage.tsx': 'web/src/pages/browse/HomePage.tsx',
  'web/src/pages/ExplorePage.tsx': 'web/src/pages/browse/ExplorePage.tsx',
  'web/src/pages/MoodPage.tsx': 'web/src/pages/browse/MoodPage.tsx',
  'web/src/pages/MixPage.tsx': 'web/src/pages/browse/MixPage.tsx',
  'web/src/pages/SearchPage.tsx': 'web/src/pages/browse/SearchPage.tsx',

  'web/src/pages/LibraryPage.tsx': 'web/src/pages/library/LibraryPage.tsx',
  'web/src/pages/LocalPlaylistPage.tsx': 'web/src/pages/library/LocalPlaylistPage.tsx',
  'web/src/pages/OfflinePage.tsx': 'web/src/pages/library/OfflinePage.tsx',
  'web/src/pages/ImportPage.tsx': 'web/src/pages/library/ImportPage.tsx',

  'web/src/pages/DetailPages.tsx': 'web/src/pages/detail/DetailPages.tsx',

  'web/src/pages/ProfilePage.tsx': 'web/src/pages/account/ProfilePage.tsx',
  'web/src/pages/AdminPage.tsx': 'web/src/pages/account/AdminPage.tsx',
  'web/src/pages/LoginDevicePage.tsx': 'web/src/pages/account/LoginDevicePage.tsx',
  'web/src/pages/VerifyEmailPage.tsx': 'web/src/pages/account/VerifyEmailPage.tsx',
  'web/src/pages/TvPage.tsx': 'web/src/pages/account/TvPage.tsx',

  // —— api ——
  'api/src/auth.ts': 'api/src/auth/auth.ts',
  'api/src/passkeys.ts': 'api/src/auth/passkeys.ts',
  'api/src/totp.ts': 'api/src/auth/totp.ts',
  'api/src/deviceLogin.ts': 'api/src/auth/deviceLogin.ts',
  'api/src/sessions.ts': 'api/src/auth/sessions.ts',

  'api/src/yt.ts': 'api/src/youtube/yt.ts',
  'api/src/youtubeCookies.ts': 'api/src/youtube/youtubeCookies.ts',
  'api/src/ytm-account.ts': 'api/src/youtube/ytm-account.ts',
  'api/src/ytm-sync.ts': 'api/src/youtube/ytm-sync.ts',
  'api/src/mappers.ts': 'api/src/youtube/mappers.ts',
  'api/src/types.ts': 'api/src/youtube/types.ts',

  'api/src/library.ts': 'api/src/library/library.ts',
  'api/src/offline.ts': 'api/src/library/offline.ts',
  'api/src/prefs.ts': 'api/src/library/prefs.ts',
  'api/src/mixCache.ts': 'api/src/library/mixCache.ts',
  'api/src/db.ts': 'api/src/library/db.ts',

  'api/src/stream.ts': 'api/src/media/stream.ts',
  'api/src/img.ts': 'api/src/media/img.ts',
  'api/src/identify.ts': 'api/src/media/identify.ts',
  'api/src/import.ts': 'api/src/media/import.ts',

  'api/src/reco.ts': 'api/src/reco/reco.ts',
  'api/src/searchRank.ts': 'api/src/reco/searchRank.ts',
  'api/src/searchHits.ts': 'api/src/reco/searchHits.ts',

  'api/src/platform.ts': 'api/src/platform/platform.ts',
  'api/src/mail.ts': 'api/src/platform/mail.ts',
  'api/src/telemetryAlert.ts': 'api/src/platform/telemetryAlert.ts',
  'api/src/batteryReport.ts': 'api/src/platform/batteryReport.ts',
  'api/src/rateLimit.ts': 'api/src/platform/rateLimit.ts',
  'api/src/log.ts': 'api/src/platform/log.ts',
  'api/src/admin.ts': 'api/src/platform/admin.ts',
  'api/src/deployRemote.ts': 'api/src/platform/deployRemote.ts',

  // —— scripts ——
  'scripts/adb/adb-ensure-device.sh': 'scripts/adb/adb-ensure-device.sh',
  'scripts/adb/adb-fix-auth.sh': 'scripts/adb/adb-fix-auth.sh',
  'scripts/adb/adb-login.sh': 'scripts/adb/adb-login.sh',
  'scripts/adb/adb-wifi.sh': 'scripts/adb/adb-wifi.sh',

  'scripts/android/android-battery-offline-check.sh': 'scripts/android/android-battery-offline-check.sh',
  'scripts/android/android-install.sh': 'scripts/android/android-install.sh',
  'scripts/android/android-publish-apk.sh': 'scripts/android/android-publish-apk.sh',
  'scripts/android/android-pull-logs.sh': 'scripts/android/android-pull-logs.sh',
  'scripts/android/kotlin-android-install.sh': 'scripts/android/kotlin-android-install.sh',
  'scripts/android/mobile-full-smoke.sh': 'scripts/android/mobile-full-smoke.sh',
  'scripts/android/mobile-install-adb.sh': 'scripts/android/mobile-install-adb.sh',
  'scripts/android/mobile-stress-battery.sh': 'scripts/android/mobile-stress-battery.sh',
  'scripts/android/publish-apk-remote.sh': 'scripts/android/publish-apk-remote.sh',
  'scripts/android/samsung-dual-qa.sh': 'scripts/android/samsung-dual-qa.sh',
  'scripts/android/e2e-mobile-adb.sh': 'scripts/android/e2e-mobile-adb.sh',
  'scripts/android/prod-mobile-smoke.sh': 'scripts/android/prod-mobile-smoke.sh',

  'scripts/battery/battery-mail-report.mjs': 'scripts/battery/battery-mail-report.mjs',
  'scripts/battery/battery-mail-report.sh': 'scripts/battery/battery-mail-report.sh',
  'scripts/battery/battery-session.sh': 'scripts/battery/battery-session.sh',
  'scripts/battery/battery-suite.sh': 'scripts/battery/battery-suite.sh',
  'scripts/battery/e2e-battery.mjs': 'scripts/battery/e2e-battery.mjs',

  'scripts/deploy/admin-deploy-prod.sh': 'scripts/deploy/admin-deploy-prod.sh',
  'scripts/deploy/redeploy-vps.sh': 'scripts/deploy/redeploy-vps.sh',
  'scripts/deploy/push-youtube-cookies.sh': 'scripts/deploy/push-youtube-cookies.sh',
  'scripts/deploy/bump-version.sh': 'scripts/deploy/bump-version.sh',
  'scripts/deploy/link-home-stream.sh': 'scripts/deploy/link-home-stream.sh',

  'scripts/dev/ensure-api.sh': 'scripts/dev/ensure-api.sh',
  'scripts/dev/kill-dev.sh': 'scripts/dev/kill-dev.sh',
  'scripts/dev/dev-up.sh': 'scripts/dev/dev-up.sh',
  'scripts/dev/env-check.sh': 'scripts/dev/env-check.sh',
  'scripts/dev/status-watch.sh': 'scripts/dev/status-watch.sh',
  'scripts/dev/db-ops.sh': 'scripts/dev/db-ops.sh',
  'scripts/dev/seed-users.mjs': 'scripts/dev/seed-users.mjs',
  'scripts/dev/make-maskable-icons.py': 'scripts/dev/make-maskable-icons.py',

  'scripts/test/test-register-verify-adb.mjs': 'scripts/test/test-register-verify-adb.mjs',
  'scripts/test/test-search-gold.mjs': 'scripts/test/test-search-gold.mjs',
  'scripts/test/test-search.mjs': 'scripts/test/test-search.mjs',
  'scripts/test/test-time.mjs': 'scripts/test/test-time.mjs',
  'scripts/test/test-verify-email.mjs': 'scripts/test/test-verify-email.mjs',
  'scripts/test/smoke-load-test.mjs': 'scripts/test/smoke-load-test.mjs',
  'scripts/test/sync-pins-between-apis.sh': 'scripts/test/sync-pins-between-apis.sh',
};

function toPosix(p) {
  return p.split('\\').join('/');
}

function stripExt(p) {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
}

/** Map: absolute path without ext → new absolute path without ext */
function buildModuleMap() {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const [from, to] of Object.entries(MOVES)) {
    if (!from.endsWith('.ts') && !from.endsWith('.tsx') && !from.endsWith('.mjs')) continue;
    const a = stripExt(resolve(ROOT, from));
    const b = stripExt(resolve(ROOT, to));
    map.set(toPosix(a), toPosix(b));
  }
  return map;
}

function ensureDirs() {
  for (const to of Object.values(MOVES)) {
    mkdirSync(dirname(resolve(ROOT, to)), { recursive: true });
  }
}

function gitMv() {
  for (const [from, to] of Object.entries(MOVES)) {
    const src = resolve(ROOT, from);
    const dst = resolve(ROOT, to);
    if (!existsSync(src)) {
      if (existsSync(dst)) {
        console.log('skip (already moved)', from);
        continue;
      }
      console.warn('MISSING', from);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    try {
      execSync(`git mv "${from}" "${to}"`, { cwd: ROOT, stdio: 'pipe' });
    } catch {
      // not tracked or already staged differently
      execSync(`mv "${src}" "${dst}"`, { cwd: ROOT, stdio: 'pipe' });
      try {
        execSync(`git add -A "${to}"`, { cwd: ROOT, stdio: 'pipe' });
      } catch {
        /* ignore */
      }
    }
    console.log('mv', from, '→', to);
  }
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

/**
 * Resolve an import specifier relative to importer file to absolute module path (no ext).
 */
function resolveImport(importerFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(importerFile), spec);
  // try with/without ext already in spec
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.mjs',
    join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    const noExt = stripExt(c);
    if (existsSync(c) || existsSync(noExt + '.ts') || existsSync(noExt + '.tsx') || existsSync(noExt + '.js')) {
      return toPosix(noExt);
    }
  }
  // Even if file not found yet (moved), normalize as posix no-ext path of intended target
  return toPosix(stripExt(base));
}

function rewriteFileImports(file, moduleMap) {
  let src = readFileSync(file, 'utf8');
  const importerNoExt = toPosix(stripExt(file));
  let changed = false;

  const re = /((?:import|export)\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"]+)\2/g;

  src = src.replace(re, (full, prefix, quote, spec) => {
    // Keep .js extensions for ESM api imports — rewrite path only
    const hadJs = spec.endsWith('.js');
    const specNoJs = hadJs ? spec.slice(0, -3) : spec;
    const resolvedOld = resolveImport(file, specNoJs);
    if (!resolvedOld) return full;

    // If this module itself moved, the "old" resolution from current location might already be new.
    // Also try mapping as if import pointed to old flat layout.
    let target = moduleMap.get(resolvedOld);

    // Heuristic: if importer was moved, relative ./foo from OLD location
    if (!target) {
      // Try: treat resolvedOld as already-new; ok
      return full;
    }

    // Compute new relative from current file location to target
    let rel = toPosix(relative(dirname(file), target));
    if (!rel.startsWith('.')) rel = './' + rel;
    if (hadJs) rel += '.js';

    if (rel === spec || rel === specNoJs || (hadJs && rel === spec)) return full;
    changed = true;
    return `${prefix}${quote}${rel}${quote}`;
  });

  if (changed) {
    writeFileSync(file, src);
    console.log('rewrite', toPosix(relative(ROOT, file)));
  }
}

/**
 * After moves, imports that still point to OLD flat paths (because resolve used new location)
 * need a second pass using basename lookup among moved modules.
 */
function rewriteViaBasename(file, byBasename) {
  let src = readFileSync(file, 'utf8');
  let changed = false;
  const re = /((?:import|export)\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"]+)\2/g;

  src = src.replace(re, (full, prefix, quote, spec) => {
    const hadJs = spec.endsWith('.js');
    const clean = hadJs ? spec.slice(0, -3) : spec;
    const base = basename(clean);
    // Only rewrite if the import path looks like old flat sibling (./Foo or ../lib/Foo)
    const targets = byBasename.get(base);
    if (!targets || targets.length !== 1) return full;
    const target = targets[0];
    // If already resolving near target, skip
    const absTry = toPosix(stripExt(resolve(dirname(file), clean)));
    if (absTry === target || absTry.endsWith('/' + base) && existsSync(target + '.ts') || existsSync(target + '.tsx')) {
      // check if file at absTry exists at NEW location incorrectly
      if (existsSync(absTry + '.ts') || existsSync(absTry + '.tsx') || existsSync(absTry + '.js')) {
        return full;
      }
    }
    if (existsSync(absTry + '.ts') || existsSync(absTry + '.tsx')) return full;

    let rel = toPosix(relative(dirname(file), target));
    if (!rel.startsWith('.')) rel = './' + rel;
    if (hadJs) rel += '.js';
    if (rel === spec) return full;
    changed = true;
    return `${prefix}${quote}${rel}${quote}`;
  });

  if (changed) {
    writeFileSync(file, src);
    console.log('basename-fix', toPosix(relative(ROOT, file)));
  }
}

function rewriteScriptPathsInTextFiles() {
  const files = [
    ...walk(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')),
    join(ROOT, 'Makefile'),
    join(ROOT, 'package.json'),
    join(ROOT, 'README.md'),
    join(ROOT, 'DEPLOY.md'),
    join(ROOT, 'TESTS.md'),
    join(ROOT, 'TESTS.LOCAL.md'),
    join(ROOT, 'TESTS_DEV.md'),
    join(ROOT, 'TESTS_PROD.md'),
    join(ROOT, 'ERRORS.md'),
    join(ROOT, 'STATUS.md'),
  ].filter((f) => existsSync(f));

  // Also all scripts (they may call each other)
  files.push(...walk(join(ROOT, 'scripts')));

  const scriptMoves = Object.entries(MOVES).filter(([f]) => f.startsWith('scripts/'));

  for (const file of files) {
    let src = readFileSync(file, 'utf8');
    let changed = false;
    for (const [from, to] of scriptMoves) {
      if (src.includes(from)) {
        src = src.split(from).join(to);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(file, src);
      console.log('scripts-ref', toPosix(relative(ROOT, file)));
    }
  }
}

function main() {
  ensureDirs();
  gitMv();

  const moduleMap = buildModuleMap();
  /** @type {Map<string, string[]>} */
  const byBasename = new Map();
  for (const [, toNoExt] of moduleMap) {
    const b = basename(toNoExt);
    if (!byBasename.has(b)) byBasename.set(b, []);
    byBasename.get(b).push(toNoExt);
  }

  const codeFiles = [
    ...walk(join(ROOT, 'web/src')),
    ...walk(join(ROOT, 'api/src')),
  ];

  // Pass 1: rewrite using module map from resolved paths
  // Build OLD→NEW: for imports written as ./X from a file that also moved,
  // resolve against OLD path of importer.
  const oldImporterOf = new Map();
  for (const [from, to] of Object.entries(MOVES)) {
    if (!/\.tsx?$/.test(from)) continue;
    oldImporterOf.set(toPosix(stripExt(resolve(ROOT, to))), toPosix(stripExt(resolve(ROOT, from))));
  }

  for (const file of codeFiles) {
    let src = readFileSync(file, 'utf8');
    const newImporter = toPosix(stripExt(file));
    const oldImporter = oldImporterOf.get(newImporter) || newImporter;
    let changed = false;

    const re =
      /((?:import|export)\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)(['"])(\.[^'"]+)\2/g;

    src = src.replace(re, (full, prefix, quote, spec) => {
      const hadJs = spec.endsWith('.js');
      const specCore = hadJs ? spec.slice(0, -3) : spec;

      // Resolve as if still at OLD importer location (pre-move relative paths)
      const resolvedFromOld = toPosix(stripExt(resolve(dirname(oldImporter + '.ts'), specCore)));
      let target = moduleMap.get(resolvedFromOld);

      // Or resolve from new location to already-moved target
      if (!target) {
        const resolvedFromNew = toPosix(stripExt(resolve(dirname(file), specCore)));
        target = moduleMap.get(resolvedFromNew) || null;
        // If points to a module that didn't move and exists, keep
        if (!target) {
          if (
            existsSync(resolvedFromNew + '.ts') ||
            existsSync(resolvedFromNew + '.tsx') ||
            existsSync(resolvedFromNew + '.js')
          ) {
            return full;
          }
          // basename fallback
          const b = basename(specCore);
          const opts = byBasename.get(b);
          if (opts?.length === 1) target = opts[0];
        }
      }

      if (!target) return full;

      let rel = toPosix(relative(dirname(file), target));
      if (!rel.startsWith('.')) rel = './' + rel;
      if (hadJs) rel += '.js';
      if (rel === spec) return full;
      changed = true;
      return `${prefix}${quote}${rel}${quote}`;
    });

    if (changed) {
      writeFileSync(file, src);
      console.log('import-fix', toPosix(relative(ROOT, file)));
    }
  }

  rewriteScriptPathsInTextFiles();
  console.log('DONE', Object.keys(MOVES).length, 'moves');
}

main();
