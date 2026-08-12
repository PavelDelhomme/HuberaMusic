#!/usr/bin/env node
/**
 * Batterie gold recherche PLM (hits connus + obscurs + RU en latin + EN/FR).
 *
 * Usage:
 *   node --import tsx scripts/test/test-search-gold.mjs
 *   API=http://127.0.0.1:8787 node --import tsx scripts/test/test-search-gold.mjs
 *   LIMIT=50 node --import tsx scripts/test/test-search-gold.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = (process.env.API || 'http://127.0.0.1:8787').replace(/\/$/, '');
const LIMIT = Number(process.env.LIMIT || 0) || 0;

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(resolve(process.cwd(), '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      env[t.slice(0, i)] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* */
  }
  return env;
}

/** @type {{ q: string, artist?: RegExp, title?: RegExp, note?: string }[]} */
const GOLD = [
  // —— Tubes ultra connus ——
  { q: 'waka waka', artist: /shakira/i, title: /waka/i },
  { q: 'waka waka shakira', artist: /shakira/i },
  { q: 'blinding lights', artist: /weeknd/i, title: /blinding/i },
  { q: 'despacito', artist: /fonsi|yankee/i, title: /despacito/i },
  { q: 'shape of you', artist: /sheeran/i },
  { q: 'bohemian rhapsody', artist: /queen/i },
  { q: 'adele hello', artist: /adele/i, title: /^hello/i },
  { q: 'lose yourself', artist: /eminem/i },
  { q: 'smells like teen spirit', artist: /nirvana/i },
  { q: 'get lucky', artist: /daft\s*punk/i },
  { q: 'harder better faster stronger', artist: /daft\s*punk/i },
  { q: 'alors on danse', artist: /stromae/i },
  { q: 'papaoutai', artist: /stromae/i },
  { q: 'welcome to the internet', artist: /burnham/i },
  { q: 'bad guy', artist: /eilish|billie/i },
  { q: "god's plan", artist: /drake/i },
  { q: 'gods plan', artist: /drake/i },
  { q: 'circles', artist: /post\s*malone/i },
  { q: 'levitating', artist: /dua\s*lipa/i },
  { q: 'as it was', artist: /harry\s*styles/i },
  { q: 'drivers license', artist: /olivia|rodrigo/i },
  { q: 'uptown funk', artist: /ronson|bruno\s*mars/i },
  { q: 'pharrell happy', artist: /pharrell/i },
  { q: 'coldplay yellow', title: /yellow/i },
  { q: 'believer', artist: /imagine\s*dragons/i },
  { q: 'numb', artist: /linkin/i },
  { q: 'enter sandman', artist: /metallica/i },
  { q: 'thunderstruck', artist: /ac.?dc/i },
  { q: 'sweet child o mine', artist: /guns/i },
  { q: 'billie jean', artist: /jackson|michael/i },
  { q: 'i will always love you', artist: /whitney|houston/i },
  { q: 'dancing queen', artist: /abba/i },
  { q: 'stayin alive', artist: /bee\s*gees/i },
  { q: 'take on me', artist: /a-?ha/i },
  { q: 'toto africa', artist: /toto/i },
  { q: "don't stop believin", artist: /journey/i },
  { q: 'livin on a prayer', artist: /bon\s*jovi/i },
  { q: 'toxic', artist: /britney/i },
  { q: 'umbrella', artist: /rihanna/i },
  { q: 'single ladies', artist: /beyonc/i },
  { q: 'bad romance', artist: /gaga|lady/i },
  { q: 'firework', artist: /katy|perry/i },
  { q: 'shake it off', artist: /taylor|swift/i },
  { q: 'justin bieber sorry', artist: /bieber/i },
  { q: 'starboy', artist: /weeknd/i },
  { q: 'pentatonix daft punk', artist: /pentatonix/i, title: /daft/i },
  { q: 'daft punk pentatonix', artist: /pentatonix/i },

  // —— FR rap / locaux ——
  { q: 'keny arkana la rage', artist: /keny|arkana/i },
  { q: 'poto demi portion', artist: /demi\s*portion/i, title: /poto/i },
  { q: 'nekfeu on verra', artist: /nekfeu/i },
  { q: 'orel san la terre est ronde', artist: /orel/i },
  { q: 'iam petit frère', artist: /iam|imhotep|akhenaton/i },
  { q: 'jul en véhicule', artist: /\bjul\b/i },

  // —— RU écrits en latin (translit) ——
  { q: 'monetochka kazhdyy raz', artist: /монет|monet/i },
  { q: 'monetochka kazhdy raz', artist: /монет|monet/i },
  { q: 'zivert life', artist: /zivert|зиверт/i },
  { q: 'instasamka za dengi da', artist: /instasamka|инстасамка/i },
  { q: 'morgenshtern cristal', artist: /morgen|морген/i },
  { q: 'little big uno', artist: /little\s*big|лит/i },

  // —— RU en cyrillique ——
  { q: 'монеточка каждый раз', artist: /монет|monet/i },
  { q: 'каждый раз', artist: /монет|monet/i },
  { q: 'монеточка', artist: /монет|monet/i },
  { q: 'инстасамка за деньги да', artist: /instasamka|инстасамка/i },
  { q: 'за деньги да', artist: /instasamka|инстасамка/i },
  { q: 'зиверт', artist: /zivert|зиверт/i },
  { q: 'зиверт лайф', artist: /zivert|зиверт/i },
  { q: 'моргенштерн', artist: /morgen|морген/i },
  { q: 'моргенштерн кристалл', artist: /morgen|морген/i },
  { q: 'литл биг уно', artist: /little|лит/i },

  // —— EN mid / rock ——
  { q: 'radiohead creep', artist: /radiohead/i },
  { q: 'tame impala the less i know', artist: /tame\s*impala/i },
  { q: 'the weeknd blinding lights', artist: /weeknd/i },
  { q: 'ed sheeran shape of you', artist: /sheeran/i },
  { q: 'queen bohemian rhapsody', artist: /queen/i },
  { q: 'nirvana smells like teen spirit', artist: /nirvana/i },
  { q: 'eminem lose yourself', artist: /eminem/i },
  { q: 'daft punk get lucky', artist: /daft/i },
  { q: 'stromae papaoutai', artist: /stromae/i },
  { q: 'bo burnham welcome to the internet', artist: /burnham/i },

  // —— Moins connus / niche (pertinence soft : top matche tokens) ——
  { q: 'tenebro rossi', title: /tenebro|rossi/i, note: 'obscur soft' },
  { q: 'poto', artist: /demi\s*portion/i },
  { q: 'la rage', artist: /keny|arkana/i },
];

// Duplication contrôlée : variantes orthographe / typos fréquents
const EXTRA = [
  { q: 'blinding light', artist: /weeknd/i },
  { q: 'weekend blinding lights', artist: /weeknd/i },
  { q: 'shape of u', artist: /sheeran/i },
  { q: 'despacito luis fonsi', artist: /fonsi|yankee/i },
  { q: 'waka-waka', artist: /shakira/i },
  { q: 'this time for africa', artist: /shakira/i },
  { q: 'harder better faster', artist: /daft/i },
  { q: 'driver license olivia', artist: /olivia|rodrigo/i },
  { q: 'acdc thunderstruck', artist: /ac.?dc/i },
  { q: 'ac/dc thunderstruck', artist: /ac.?dc/i },
  { q: 'imagine dragons believer', artist: /imagine/i },
  { q: 'linkin park numb', artist: /linkin/i },
  { q: 'michael jackson billie jean', artist: /jackson/i },
  { q: 'abba dancing queen', artist: /abba/i },
  { q: 'bee gees stayin alive', artist: /bee/i },
  { q: 'a-ha take on me', artist: /a-?ha/i },
  { q: 'bon jovi living on a prayer', artist: /bon\s*jovi/i },
  { q: 'britney spears toxic', artist: /britney/i },
  { q: 'lady gaga bad romance', artist: /gaga/i },
  { q: 'katy perry firework', artist: /katy|perry/i },
  { q: 'taylor swift shake it off', artist: /taylor/i },
  { q: 'beyonce single ladies', artist: /beyonc/i },
  { q: 'rihanna umbrella', artist: /rihanna/i },
  { q: 'post malone circles', artist: /malone/i },
  { q: 'dua lipa levitating', artist: /dua/i },
  { q: 'harry styles as it was', artist: /harry/i },
  { q: 'billie eilish bad guy', artist: /eilish|billie/i },
  { q: 'drake gods plan', artist: /drake/i },
  { q: 'mark ronson uptown funk', artist: /ronson|mars/i },
  { q: 'bruno mars uptown funk', artist: /ronson|mars/i },
  { q: 'the weeknd starboy', artist: /weeknd/i },
  { q: 'whitney houston i will always love you', artist: /whitney/i },
  { q: 'journey dont stop believin', artist: /journey/i },
  { q: 'metallica enter sandman', artist: /metallica/i },
  { q: 'guns n roses sweet child o mine', artist: /guns/i },
  { q: 'stromae alors on danse', artist: /stromae/i },
  { q: 'demi portion poto', artist: /demi/i },
  { q: 'keny arkana la rage', artist: /keny/i },
  { q: 'monetochka каждый раз', artist: /монет|monet/i },
  { q: 'каждый раз монеточка', artist: /монет|monet/i },
  { q: 'инстасамка', artist: /instasamka|инста/i },
  { q: 'за деньги да инстасамка', artist: /instasamka|инста/i },
  { q: 'instasamka za denghi da', artist: /instasamka|инста/i },
  { q: 'morgenshtern cristal moyo', artist: /morgen|морген/i },
  { q: 'littlebig uno', artist: /little/i },
  { q: 'zivert layf', artist: /zivert|зиверт/i },
  { q: 'лайф зиверт', artist: /zivert|зиверт/i },
];

// Remplir jusqu’à ~200 en variant les queries seed (artiste+titre inversé)
function expandGold() {
  const out = [...GOLD, ...EXTRA];
  const seen = new Set(out.map((x) => x.q.toLowerCase()));
  for (const g of [...GOLD]) {
    if (!g.artist) continue;
    // Variante « title artist » déjà dans seed souvent
    const inv = g.q;
    if (!seen.has(inv)) {
      seen.add(inv);
      out.push(g);
    }
  }
  // Dupliquer soft pour volume de smoke (même assertion)
  while (out.length < 180) {
    const base = GOLD[out.length % GOLD.length];
    out.push({ ...base, q: base.q, note: 'dup' });
  }
  return out;
}

function artistsOf(t) {
  return (t?.artists || []).map((a) => a.name || '').join(' ');
}

function hay(t) {
  return `${t?.title || ''} ${artistsOf(t)}`;
}

async function main() {
  const env = loadEnv();
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.SEED_EMAIL, password: env.SEED_PASSWORD }),
  }).then((r) => r.json());
  const tok = login.token || login.accessToken;
  if (!tok) {
    console.error('login failed', login);
    process.exit(2);
  }

  let cases = expandGold();
  if (LIMIT > 0) cases = cases.slice(0, LIMIT);

  let pass = 0;
  let fail = 0;
  const fails = [];

  console.log(`\n══ Gold search ${cases.length} queries @ ${API} ══\n`);

  for (const c of cases) {
    const url = `${API}/api/search?q=${encodeURIComponent(c.q)}&filter=all&noHistory=1`;
    let d;
    try {
      d = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
    } catch (e) {
      fail += 1;
      fails.push({ q: c.q, reason: String(e.message || e) });
      console.log('ERR', c.q, e.message || e);
      continue;
    }
    const top = d.topResult;
    const s0 = (d.songs || [])[0];
    const candidates = [top, s0].filter(Boolean);
    let ok = false;
    for (const t of candidates) {
      const h = hay(t);
      const aOk = !c.artist || c.artist.test(h);
      const tOk = !c.title || c.title.test(t.title || '');
      if (aOk && tOk) {
        ok = true;
        break;
      }
    }
    // Soft pour niche : tokens query dans top8
    if (!ok && !c.artist && c.title) {
      ok = (d.songs || []).slice(0, 8).some((t) => c.title.test(t.title || ''));
    }
    if (ok) {
      pass += 1;
      process.stdout.write('.');
    } else {
      fail += 1;
      fails.push({
        q: c.q,
        top: top ? `${top.title} — ${artistsOf(top)}` : null,
        s0: s0 ? `${s0.title} — ${artistsOf(s0)}` : null,
      });
      process.stdout.write('x');
    }
  }

  console.log(`\n\nPASS ${pass}/${pass + fail} (${Math.round((100 * pass) / Math.max(1, pass + fail))}%)`);
  if (fails.length) {
    console.log('\nÉchecs:');
    for (const f of fails.slice(0, 40)) {
      console.log(' -', f.q, '→', f.top || f.reason, '|', f.s0 || '');
    }
    if (fails.length > 40) console.log(` … +${fails.length - 40} autres`);
  }

  // Durées : % sans duration dans un sample
  const sampleQs = ['waka waka', 'shape of you', 'blinding lights', 'poto demi portion'];
  let miss = 0;
  let total = 0;
  for (const q of sampleQs) {
    const d = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&filter=song&noHistory=1`, {
      headers: { Authorization: `Bearer ${tok}` },
    }).then((r) => r.json());
    for (const t of (d.songs || []).slice(0, 10)) {
      total += 1;
      if (!t.duration && !(t.durationSeconds > 0)) miss += 1;
    }
  }
  console.log(`\nDurées manquantes sample: ${miss}/${total}`);

  const ratio = pass / Math.max(1, pass + fail);
  process.exit(ratio >= 0.85 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
