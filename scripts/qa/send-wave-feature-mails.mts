/**
 * Mails par fonctionnalité — vague vidéo / file / batterie (11 sept. 2026)
 * Validation Samsung + Blackview (p+1.3.226). Pas d’automation ADB pendant l’envoi.
 *
 *   node --env-file=.env --import tsx scripts/qa/send-wave-feature-mails.mts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from '../../api/src/platform/mail.ts';

const to =
  process.env.BATTERY_REPORT_TO?.trim() ||
  process.env.REPORT_TO?.trim() ||
  'dev@delhomme.ovh, [SET_VIA_ENV]';

const version = readFileSync(join(process.cwd(), 'VERSION'), 'utf8').trim();
const iso = new Date().toISOString();
const OUT = join(process.cwd(), 'tmp', 'qa-wave-20260911');
mkdirSync(OUT, { recursive: true });

type Status = 'OK' | 'WARN' | 'FAIL' | 'SKIP';
type DeviceResult = {
  label: string;
  version?: string;
  passes?: number;
  fails?: number;
  warns?: number;
  results?: { id: string; status: string; detail: string }[];
};

function loadDevice(label: string): DeviceResult | null {
  const p = join(OUT, label, 'REPORT.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as DeviceResult;
}

const samsung = loadDevice('samsung');
const blackview = loadDevice('blackview');

function find(dev: DeviceResult | null, id: string) {
  return dev?.results?.find((r) => r.id === id);
}

function combine(id: string): { status: Status; detail: string } {
  const a = find(samsung, id);
  const b = find(blackview, id);
  const rank = (s?: string) =>
    s === 'FAIL' ? 3 : s === 'WARN' ? 2 : s === 'PASS' ? 1 : 0;
  const worst = [a, b].sort((x, y) => rank(y?.status) - rank(x?.status))[0];
  const status: Status =
    worst?.status === 'FAIL'
      ? 'FAIL'
      : worst?.status === 'WARN'
        ? 'WARN'
        : worst?.status === 'PASS'
          ? 'OK'
          : 'SKIP';
  const parts = [
    a ? `Samsung: ${a.status} — ${a.detail}` : 'Samsung: n/a',
    b ? `Blackview: ${b.status} — ${b.detail}` : 'Blackview: n/a',
  ];
  return { status, detail: parts.join('\n') };
}

type Feature = {
  id: string;
  title: string;
  versions: string;
  description: string;
  checkIds: string[];
  notes?: string;
};

const features: Feature[] = [
  {
    id: 'verifyerror',
    title: 'Stabilisation Now Playing (VerifyError DEX)',
    versions: '1.3.224',
    description:
      'Extraction VideoPlaybackHost pour éviter le plantage ART / VerifyError à l’ouverture NP en mode Vidéo.',
    checkIds: ['verifyerror', 'version'],
  },
  {
    id: 'no-clip-wait',
    title: 'Plus d’écran « Recherche du clip… »',
    versions: '1.3.223',
    description:
      'Pochette immédiate + pastille discrète + warm silencieux visualId + resolve en 2 temps.',
    checkIds: ['no_clip_wait', 'video_mode'],
  },
  {
    id: 'queue-no-cut',
    title: 'File d’attente sans couper la vidéo',
    versions: '1.3.219',
    description:
      'NP reste composé (alpha 0) sous le panneau file — Exo clip non disposé.',
    checkIds: ['queue_open'],
  },
  {
    id: 'queue-red-title',
    title: 'Titre en cours en rouge (file recroquevillée)',
    versions: '1.3.225',
    description:
      'Titre actuel affiché en SeekRed en haut de l’aperçu file + header file dépliée.',
    checkIds: ['queue_red_title', 'queue_open'],
  },
  {
    id: 'collapse-audio',
    title: 'Repli lecteur mode Vidéo → audio mini-lecteur',
    versions: '1.3.226',
    description:
      'Hand-off clip→titre à la rétractation : plus de silence / « Chargement… » bloquant.',
    checkIds: ['collapse_audio', 'collapse_crash'],
  },
  {
    id: 'offline-battery',
    title: 'Batterie sans purge offline + DL clips',
    versions: '1.3.221–1.3.222',
    description:
      'Paliers soft/actif, IdleGuard sans delete offline ; DL audio+mp4 parallèles.',
    checkIds: ['offline_intact'],
  },
  {
    id: 'api-prod',
    title: 'API / OTA production alignées',
    versions: '1.3.226',
    description: 'Health prod + APK p+1.3.226 sur flotte.',
    checkIds: ['api_prod', 'version'],
  },
];

function badge(s: Status) {
  const colors: Record<Status, string> = {
    OK: '#0a7a32',
    WARN: '#a15c00',
    FAIL: '#b00020',
    SKIP: '#666',
  };
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${colors[s]};color:#fff;font-weight:600;font-size:12px">${s}</span>`;
}

const sent: { id: string; status: Status; messageId?: string }[] = [];

for (const f of features) {
  const checks = f.checkIds.map((id) => ({ id, ...combine(id) }));
  const overall: Status = checks.some((c) => c.status === 'FAIL')
    ? 'FAIL'
    : checks.some((c) => c.status === 'WARN')
      ? 'WARN'
      : checks.every((c) => c.status === 'SKIP')
        ? 'SKIP'
        : 'OK';

  const subject = `[Hubera Music] ${overall} · ${f.title} — p+${version}`;

  const text = `PLM — Validation fonctionnalité
Statut: ${overall}
Feature: ${f.title}
Versions: ${f.versions}
APK/API: p+${version}
Date: ${iso}

${f.description}

Résultats:
${checks.map((c) => `- [${c.status}] ${c.id}\n  ${c.detail}`).join('\n\n')}

${f.notes || ''}

Note session: les scripts QA ADB interactifs ont été STOPPÉS car ils perturbaient l’écoute utilisateur (sauts de titres). Suite = tests read-only / manuels.
`;

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5;color:#222">
  <p style="margin:0 0 8px">${badge(overall)} <strong>${f.title}</strong></p>
  <p style="color:#666;margin:0 0 16px">p+${version} · ${f.versions} · ${new Date().toLocaleString('fr-FR')}</p>
  <p>${f.description}</p>
  <h3 style="font-size:15px;margin:20px 0 8px">Résultats appareils</h3>
  <ul style="padding-left:18px">
    ${checks
      .map(
        (c) =>
          `<li style="margin-bottom:10px"><code>${c.id}</code> ${badge(c.status)}<br/><pre style="white-space:pre-wrap;background:#f6f6f6;padding:8px;border-radius:6px;font-size:12px;margin:6px 0 0">${c.detail.replaceAll('<', '&lt;')}</pre></li>`,
      )
      .join('')}
  </ul>
  <p style="font-size:13px;color:#444;margin-top:16px"><strong>Contexte :</strong> Samsung SM-G990B2 + Blackview BV9700Pro, APK p+1.3.226. Offline Samsung ≈57 .m4a / 7 .mp4 ; Blackview ≈18 .m4a / 36 .mp4. API prod appVersion=p+1.3.226.</p>
  <p style="font-size:13px;color:#a15c00;margin-top:12px"><strong>Important :</strong> l’automation ADB (taps UI) a été interrompue — elle faisait sauter les titres pendant ton écoute. Les checks restants sont non-destructifs.</p>
  <p style="color:#888;font-size:12px;margin-top:24px">SMTP prod PLM · ${to.replaceAll('<', '&lt;')}</p>
</div>`;

  const r = await sendMail({ to, subject, html, text });
  sent.push({ id: f.id, status: overall, messageId: (r as { messageId?: string }).messageId });
  console.log('mail', f.id, overall, r);
}

// Mail synthèse
{
  const subject = `[Hubera Music] Synthèse validation vague vidéo/file/batterie — p+${version}`;
  const rows = sent
    .map((s) => {
      const f = features.find((x) => x.id === s.id)!;
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${badge(s.status)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${f.title}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${f.versions}</td></tr>`;
    })
    .join('');
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:760px;line-height:1.5;color:#222">
  <h1 style="font-size:20px;margin:0 0 8px">Synthèse validation PLM</h1>
  <p style="color:#666;margin:0 0 16px">p+${version} · Samsung + Blackview · ${new Date().toLocaleString('fr-FR')}</p>
  <table style="border-collapse:collapse;width:100%">${rows}</table>
  <h3 style="margin-top:24px;font-size:15px">Incidents session QA</h3>
  <ul>
    <li><b>Perturbation écoute :</b> scripts ADB (player-actions / wave) ont tapé Accueil / next / NP pendant que tu écoutais Oxxxymiron → sauts de titres (ex. Sia observé dans MediaSession). <b>Tous les scripts interactifs sont stoppés.</b></li>
    <li><b>État actuel Samsung (read-only) :</b> MediaSession = « Где нас нет — Oxxxymiron » PLAYING — rétabli.</li>
    <li><b>0 FAIL</b> sur la vague automatisée avant arrêt ; WARNs = switch Vidéo / NP parfois non détectés par uiautomator (pas forcément bug produit).</li>
  </ul>
  <p style="color:#888;font-size:12px;margin-top:24px">Un mail détaillé a été envoyé par fonctionnalité juste avant celui-ci.</p>
</div>`;
  const text = `Synthèse p+${version}\n` + sent.map((s) => `${s.status} ${s.id}`).join('\n');
  const r = await sendMail({ to, subject, html, text });
  console.log('synthèse', r);
}

writeFileSync(join(OUT, 'mails-sent.json'), JSON.stringify({ iso, version, to, sent }, null, 2));
console.log('done →', join(OUT, 'mails-sent.json'));
