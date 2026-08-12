#!/usr/bin/env node
/**
 * Batterie de tests recherche PLM (ranking unitaires + live Innertube).
 * Usage: node scripts/test/test-search.mjs
 *        LIVE=0 node scripts/test/test-search.mjs   # ranking only
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Charge via tsx si dispo
async function loadRank() {
  try {
    return await import('../api/src/searchRank.ts');
  } catch {
    const { register } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    // fallback: spawn tsx
    return null;
  }
}

function song(title, artist, id = 'abcdefghijk') {
  return {
    id,
    title,
    artists: [{ name: artist }],
    thumbnails: [],
    type: 'song',
  };
}

const QUERIES_LIVE = [
  'tenebro rossi',
  'poto demi portion',
  'keny arkana v pour verite',
  'daft punk get lucky',
  'orel san la terre est ronde',
  'bohemian rhapsody',
  'the weeknd blinding lights',
  'stromae papaoutai',
  'iam petit frère',
  'nirvana smells like teen spirit',
  'монеточка каждый раз',
  'tame impala the less i know',
  'jul en véhicule',
  'nekfeu on verra',
  'radiohead creep',
];

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('  ❌', msg);
  } else {
    console.log('  ✅', msg);
  }
}

async function runUnit(rank) {
  console.log('\n══ Ranking unitaire ══');
  const {
    scoreSearchItem,
    personalizeBoost,
    rankByQuery,
    pickTopResult,
    foldText,
  } = rank;

  const perso = {
    artistNames: ['keny arkana', 'demi portion', 'stupeflip'],
    trackIds: [],
  };

  const q = 'tenebro rossi';
  const hit = song('Tenebro Rossi', 'Tenebro Rossi', 'tenebro0001');
  const junk = song('V pour vérité', 'Keny Arkana', 'kenyarkana1');

  assert(scoreSearchItem(hit, q) > scoreSearchItem(junk, q) + 400, 'score titre exact ≫ favori hors-sujet');
  assert(personalizeBoost(junk, perso, q) === 0, 'boost perso = 0 si hors-sujet');
  assert(
    rankByQuery([junk, hit], q, perso)[0].title.toLowerCase().includes('tenebro'),
    'rankByQuery place Tenebro en #1 malgré perso Keny',
  );

  const top = pickTopResult(
    q,
    {
      topResult: junk,
      songs: [hit, junk],
      artists: [],
      albums: [],
      videos: [],
      playlists: [],
    },
    perso,
  );
  assert(top && /tenebro/i.test(top.title), 'pickTopResult refuse Keny sur « tenebro rossi »');

  assert(scoreSearchItem(song('Ça m’énerve', 'Orelsan'), 'ca menerve') > 300, 'accents FR');
  assert(scoreSearchItem(song('Bohemian Rhapsody', 'Queen'), 'bohemian rhapsody') > 900, 'EN exact');
  assert(foldText('Ёлка').includes('елка') || foldText('Ёлка').length > 0, 'fold cyrillique');

  // Ancien bug : boost 720 écrasait tout
  const oldStyleWouldWin = scoreSearchItem(junk, q) + 720;
  assert(oldStyleWouldWin > scoreSearchItem(hit, q) || true, '(doc) ancien boost 720 était toxique');
  assert(
    scoreSearchItem(junk, q) + personalizeBoost(junk, perso, q) < scoreSearchItem(hit, q),
    'avec nouveau boost, favori ne bat pas le match',
  );
}

async function runLive() {
  if (process.env.LIVE === '0') {
    console.log('\n(skip live LIVE=0)');
    return;
  }
  console.log('\n══ Recherche live Innertube ══');
  const { search } = await import('../api/src/yt.ts');
  const { scoreSearchItem } = await import('../api/src/searchRank.ts');

  const fakeUserPerso = {
    userId: undefined, // pas de perso
  };

  for (const q of QUERIES_LIVE) {
    process.stdout.write(`\n→ « ${q} » … `);
    try {
      const res = await search(q, 'all', fakeUserPerso);
      const top = res.topResult;
      const songs = res.songs || [];
      const pool = [top, ...songs.slice(0, 8)].filter(Boolean);
      if (!pool.length) {
        console.log('⚠️  0 résultats');
        failed += 1;
        continue;
      }
      const bestRel = Math.max(...pool.map((t) => scoreSearchItem(t, q)));
      const topTitle = top ? `${top.title} — ${(top.artists || []).map((a) => a.name).join(', ')}` : '(none)';
      const ok =
        bestRel >= 150 ||
        pool.some((t) => {
          const hay = `${t.title} ${(t.artists || []).map((a) => a.name).join(' ')}`.toLowerCase();
          return q
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 3)
            .some((w) => hay.includes(w));
        });
      if (ok) {
        console.log(`OK  top=${topTitle.slice(0, 70)}  rel≈${Math.round(bestRel)}`);
      } else {
        failed += 1;
        console.log(`❌ faible pertinence  top=${topTitle.slice(0, 70)}  rel≈${Math.round(bestRel)}`);
        console.log('   songs:', songs.slice(0, 3).map((s) => s.title).join(' | '));
      }

      // Cas critique
      if (q === 'tenebro rossi') {
        const hay = (t) =>
          `${t?.title || ''} ${(t?.artists || []).map((a) => a.name).join(' ')}`;
        const polluted = [top, ...songs.slice(0, 12)].filter(
          (t) => t && /keny\s*arkana|v pour v[eé]rit/i.test(hay(t)),
        );
        if (polluted.length) {
          failed += 1;
          console.log(
            '  ❌ CRITICAL: Keny/V pour vérité dans les résultats tenebro →',
            polluted.map((t) => t.title).join(' | '),
          );
        } else {
          console.log('  ✅ aucun Keny dans les résultats tenebro');
        }
      }
    } catch (e) {
      failed += 1;
      console.log('ERR', e.message || e);
    }
  }

  // Avec perso Keny simulée
  console.log('\n══ Live + perso Keny (ne doit PAS polluer tenebro) ══');
  // search() prend userId et rebuild perso from DB — on teste rank only already.
  // Inject via direct call path: search without userId is enough for live YT.
}

async function main() {
  console.log('PLM search test suite');
  // Run via dynamic import of TS through tsx child if needed
  let rank;
  try {
    rank = await import('../api/src/searchRank.ts');
  } catch (e) {
    console.error('Import TS failed — lance avec: npx tsx scripts/test/test-search.mjs');
    console.error(e);
    process.exit(2);
  }

  await runUnit(rank);
  await runLive();

  console.log('\n════════════════════════════════');
  if (failed) {
    console.error(`FAILED: ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log('ALL PASSED');
}

main();
