/**
 * Contrôle l'appariement utilisé pour remplacer un identifiant YouTube mort.
 * Un remplaçant trop laxiste ferait jouer un autre morceau, un remplaçant trop
 * strict laisse le titre en erreur : les deux bords sont vérifiés ici.
 *
 *   npx tsx scripts/qa/track-match-check.mts
 */
import { scoreCandidate } from '../../api/src/media/trackMatch.ts';

/** Doit rester aligné sur `MIN_SCORE` dans api/src/media/trackReplacement.ts. */
const MIN_SCORE = 75;

type Cas = {
  label: string;
  cand: { title: string; artists: { name: string }[]; durationSeconds: number | null };
  title: string;
  artist: string;
  durationSec: number | null;
  attendu: 'accepter' | 'refuser';
};

const cas: Cas[] = [
  {
    label: 'format « Artiste - Titre », le plus courant sur YouTube',
    cand: { title: "Shy'm - #ShimiSoldiers (Titre inédit)", artists: [{ name: "SHY'M" }], durationSeconds: null },
    title: '#ShimiSoldiers',
    artist: "Shy'm",
    durationSec: 218,
    attendu: 'accepter',
  },
  {
    label: 'format « Artiste - Titre » avec durée identique',
    cand: { title: 'Demi Portion - Poto (Official Video)', artists: [{ name: 'Demi Portion' }], durationSeconds: 207 },
    title: 'Poto',
    artist: 'Demi Portion',
    durationSec: 207,
    attendu: 'accepter',
  },
  {
    label: 'coquille dans le titre stocké en bibliothèque',
    cand: { title: "Demi Portion - Jusqu'à quand", artists: [{ name: 'Demi Portion' }], durationSeconds: 256 },
    title: "Juqu'à quand",
    artist: 'Demi Portion',
    durationSec: 256,
    attendu: 'accepter',
  },
  {
    label: 'réédition tierce nommant l’interprète dans le titre',
    cand: { title: 'Ave Maria païen - NOA', artists: [{ name: 'B Walbyx' }], durationSeconds: null },
    title: 'Ave Maria païen',
    artist: 'NOA',
    durationSec: 216,
    attendu: 'accepter',
  },
  {
    label: 'même titre par un autre interprète, durée identique',
    cand: {
      title: 'Ave Maria païen',
      artists: [{ name: 'Luc Plamondon, Riccardo Cocciante, Hélène Ségara' }],
      durationSeconds: 216,
    },
    title: 'Ave Maria païen',
    artist: 'NOA',
    durationSec: 216,
    attendu: 'refuser',
  },
  {
    label: 'reprise annoncée dans le titre d’une réédition',
    cand: { title: 'Ave Maria païen - NOA (cover)', artists: [{ name: 'B Walbyx' }], durationSeconds: 216 },
    title: 'Ave Maria païen',
    artist: 'NOA',
    durationSec: 216,
    attendu: 'refuser',
  },
  {
    label: 'autre chanson du même artiste',
    cand: { title: "L'Effet de serre", artists: [{ name: "Shy'm" }], durationSeconds: 204 },
    title: '#ShimiSoldiers',
    artist: "Shy'm",
    durationSec: 218,
    attendu: 'refuser',
  },
  {
    label: 'bon titre mais artiste sans rapport',
    cand: { title: 'Shimisoldiers', artists: [{ name: 'Rythme de la radio' }], durationSeconds: 218 },
    title: '#ShimiSoldiers',
    artist: "Shy'm",
    durationSec: 218,
    attendu: 'refuser',
  },
  {
    label: 'remix proposé à la place de l’original',
    cand: { title: "Don't Be So Shy (Filatov & Karas Remix)", artists: [{ name: 'Imany' }], durationSeconds: 200 },
    title: "Don't Be So Shy",
    artist: 'Imany',
    durationSec: 200,
    attendu: 'refuser',
  },
  {
    label: 'reprise par un autre interprète',
    cand: { title: 'Poto', artists: [{ name: 'Jean Cover' }], durationSeconds: 207 },
    title: 'Poto',
    artist: 'Demi Portion',
    durationSec: 207,
    attendu: 'refuser',
  },
  {
    label: 'durée très éloignée (mix, version longue)',
    cand: { title: 'Demi Portion - Poto', artists: [{ name: 'Demi Portion' }], durationSeconds: 480 },
    title: 'Poto',
    artist: 'Demi Portion',
    durationSec: 207,
    attendu: 'refuser',
  },
];

let echecs = 0;
for (const c of cas) {
  const score = scoreCandidate(c.cand as never, c.title, c.artist, c.durationSec);
  const verdict = score >= MIN_SCORE ? 'accepter' : 'refuser';
  const ok = verdict === c.attendu;
  if (!ok) echecs++;
  console.log(
    `${ok ? 'OK   ' : 'ÉCHEC'} score=${String(score).padStart(3)} ` +
      `(${verdict}, attendu ${c.attendu})  ${c.label}`,
  );
}
console.log(
  echecs === 0 ? `\n${cas.length} cas conformes (seuil ${MIN_SCORE}).` : `\n${echecs} cas en échec.`,
);
process.exit(echecs ? 1 : 0);
