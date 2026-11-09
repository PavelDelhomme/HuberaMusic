/**
 * Balayage jouabilité IN-PROCESS (dans le container ytmusic) — pas de nginx 504.
 *
 *   docker exec -d -w /app -e USER_EMAIL=paul@delhomme.ovh ytmusic \
 *     node --import tsx /app/scripts/qa/run-playability-inprocess.mjs
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'data', 'playability-full-run');
mkdirSync(OUT, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  appendFileSync(join(OUT, 'live.log'), line + '\n');
};

const EMAIL = process.env.USER_EMAIL || 'paul@delhomme.ovh';
const BATCH = Math.max(3, Math.min(12, Number(process.env.BATCH || 8)));

const { findUserByEmail } = await import('../../api/src/library/db.ts');
const { runPlayabilitySweep, playabilitySweepStatus } = await import(
  '../../api/src/library/playabilitySweep.ts',
);

const user = findUserByEmail(EMAIL);
if (!user?.id) {
  log(`user introuvable: ${EMAIL}`);
  process.exit(1);
}
log(`start in-process user=${EMAIL} id=${user.id} batch=${BATCH}`);

let rounds = 0;
let totalChecked = 0;
let totalReplaced = 0;
let totalFail = 0;
let emptyStreak = 0;

while (rounds < 2000) {
  rounds++;
  const st = playabilitySweepStatus();
  log(`status ok=${st.ok} fail=${st.fail} replaced=${st.replaced}`);
  const summary = await runPlayabilitySweep({
    userId: user.id,
    limit: BATCH,
    recover: true,
    concurrency: 2,
    sleepMs: 400,
  });
  totalChecked += summary.checked || 0;
  totalReplaced += summary.replaced || 0;
  totalFail += summary.fail || 0;
  writeFileSync(
    join(OUT, 'last-summary.json'),
    JSON.stringify({ at: new Date().toISOString(), rounds, totalChecked, totalReplaced, totalFail, summary }, null, 2),
  );
  log(
    `round=${rounds} checked=${summary.checked} ok=${summary.ok} fail=${summary.fail} replaced=${summary.replaced} totals c=${totalChecked} r=${totalReplaced} f=${totalFail}`,
  );
  if (!summary.checked) {
    emptyStreak++;
  } else {
    emptyStreak = 0;
  }
  if (emptyStreak >= 3) {
    log('done — plus de titres à balayer');
    break;
  }
  await new Promise((r) => setTimeout(r, 800));
}
log(`finished rounds=${rounds} checked=${totalChecked} replaced=${totalReplaced} fail=${totalFail}`);
