/**
 * Pré-diagnostic humain des erreurs télémétrie (Android + web).
 * Sert dans les mails admin : cause probable, pas seulement le stack brut.
 */

export type TelemetryDiagnosis = {
  family: string;
  title: string;
  summary: string;
  likelyCause: string;
  actions: string[];
  surface: 'android' | 'web' | 'server' | 'unknown';
};

function blob(ev: {
  kind?: string;
  message?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  meta?: unknown;
}): string {
  const m = ev.meta && typeof ev.meta === 'object' ? JSON.stringify(ev.meta) : String(ev.meta || '');
  return [ev.kind, ev.message, ev.stack, ev.url, ev.userAgent, m].join('\n');
}

/** Message + stack uniquement — évite qu’un vieux log DNS/502 fausse le pré-diagnostic. */
function coreBlob(ev: {
  kind?: string;
  message?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
}): string {
  return [ev.kind, ev.message, ev.stack, ev.url, ev.userAgent].join('\n');
}

function httpCode(text: string): number | null {
  const m =
    text.match(/Response code:\s*(\d{3})/i) ||
    text.match(/HTTP\s+(\d{3})/i) ||
    text.match(/\b(status|code)=(\d{3})\b/i);
  if (m) {
    const n = Number(m[1] || m[2]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function diagnoseTelemetryEvent(ev: {
  kind?: string;
  message?: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  meta?: unknown;
}): TelemetryDiagnosis {
  const text = blob(ev);
  const core = coreBlob(ev);
  const kind = String(ev.kind || '');
  const url = String(ev.url || '');
  const ua = String(ev.userAgent || '');
  const surface: TelemetryDiagnosis['surface'] =
    kind.startsWith('android') || url.startsWith('android://') || /PLM-Android/i.test(ua)
      ? 'android'
      : kind.startsWith('window') || kind === 'unhandledrejection' || url.startsWith('http')
        ? 'web'
        : kind.startsWith('server') || kind.startsWith('api')
          ? 'server'
          : 'unknown';

  const isWrongThread =
    /Player is accessed on the wrong thread|verifyApplicationThread/i.test(core);
  if (isWrongThread) {
    return {
      family: 'android-thread',
      title: 'ExoPlayer lu depuis un thread IO (bug app — pas DNS)',
      summary:
        'OfflineDownloadManager ou StreamPrefetcher a appelé ExoPlayer hors thread principal. Crash fatal immédiat. Les logs récents peuvent contenir des HTTP 502 offline — ce n’est pas la cause.',
      likelyCause:
        'Régression p+1.3.31 : isPlaybackActive() touchait ExoPlayer depuis Dispatchers.IO. Corrigé en p+1.3.32 (flag Holder.playbackActive).',
      actions: [
        'Installer p+1.3.32 ou plus sur l’appareil (Nothing / Samsung)',
        'Ne pas traiter comme panne DNS ni stream OAuth',
        'Si le crash persiste après mise à jour : renvoyer le mail avec appVersion dans meta',
      ],
      surface,
    };
  }

  const code = httpCode(text);
  const is502 = code === 502 || /HTTP 502|Response code:\s*502|home stream 502/i.test(core);
  const is503 = code === 503 || /HTTP 503|Response code:\s*503/i.test(core);
  const is504 = code === 504 || /HTTP 504|Response code:\s*504/i.test(core);
  const isTimeout = /SocketTimeoutException|timeout|ETIMEDOUT|timed out/i.test(core);
  const isAbort = /Software caused connection abort|connection abort|ECONNRESET|connection reset/i.test(core);
  const isDns =
    /Unable to resolve host|UnknownHostException|No address associated with hostname|ENOTFOUND/i.test(core);
  const is403 = code === 403 || /Response code:\s*403/i.test(core);
  const is401 = code === 401 || /LOGIN_REQUIRED|unauthorized/i.test(core);
  const player = /android\.player|ExoPlaybackException|Source error|onPlayerError/i.test(core);
  const offlineDl = /offline: DL retry|HTTP 502/i.test(text) && /offline/i.test(text);

  if (isDns) {
    return {
      family: 'dns',
      title: 'DNS — le domaine API n’est pas résolu',
      summary:
        'Le téléphone n’a pas obtenu d’adresse IP pour l’hôte API (ytmusic.delhomme.ovh ou LAN). Ce n’est pas un bug ExoPlayer.',
      likelyCause:
        'Enregistrement DNS manquant/instable, IPv6 cassé, Wi‑Fi sans DNS, ou APK pointant vers un hostname injoignable.',
      actions: [
        'dig / nslookup ytmusic.delhomme.ovh (A + AAAA) depuis le PC et depuis le VPS',
        'Vérifier que l’APK DEV pointe vers http://<LAN>:8787 et PROD vers https://ytmusic.delhomme.ovh',
        'Réessayer hors VPN / autre DNS (1.1.1.1)',
      ],
      surface,
    };
  }

  if (/ERR_OUT_OF_RANGE|start" is out of range|start is out of range/i.test(core)) {
    return {
      family: 'stream-range',
      title: 'Range disque invalide (start > end) sur /api/stream',
      summary:
        'createReadStream a reçu un Range past EOF (souvent Exo en fin de titre : start === fileSize). Sans garde-fou → unhandledRejection et mail sans trackId.',
      likelyCause:
        'Client demande bytes=SIZE- alors que le fichier fait SIZE octets (end = SIZE-1). Fix : safeDiskRangeBounds → 416 + meta.trackId.',
      actions: [
        'Déployer API ≥ 1.3.70 (PR #149) — ne plus planter, répondre 416',
        'Vérifier « Titres concernés » (meta.trackId / [stream ID] dans le message)',
        'Rejouer le titre jusqu’aux ~20 dernières secondes puis pause/seek',
      ],
      surface: 'server',
    };
  }

  if (player && (is502 || is503 || is504)) {
    return {
      family: 'stream-5xx',
      title: `Flux audio HTTP ${code || 502} — le proxy/backend n’a pas fourni le fichier`,
      summary:
        'ExoPlayer a ouvert l’URL /api/stream/:id et a reçu une erreur HTTP (souvent 502) au lieu d’un flux 200/206. Le décodage audio n’a même pas commencé. Les retries offline HTTP 502 sur d’autres IDs confirment une panne de chaîne stream, pas un titre isolé.',
      likelyCause:
        'YouTube bloque l’IP datacenter (LOGIN_REQUIRED / unavailable) → Innertube ne trouve pas de format audio → l’API répond 502. Autres causes : reverse proxy timeout, OAuth TV non validé, cookies vides, upstream mort.',
      actions: [
        'curl -I « https://ytmusic.delhomme.ovh/api/stream/<trackId> » -H « Range: bytes=0-1 » : 502 = serveur, pas Android',
        'Comparer avec dQw4w9WgXcQ (souvent 206) vs le titre listé dans « Titres concernés »',
        'Valider OAuth TV : POST /api/admin/youtube-stream-oauth/start puis https://www.google.com/device (docs/STREAM-VPS-OAUTH.md)',
        'Logs API au timestamp du mail : LOGIN_REQUIRED / NO_UPSTREAM / getAudioFormat vide',
        'Côté app : circuit-breaker stream down (coupe DL offline) — build ≥ p+1.3.47',
      ],
      surface,
    };
  }

  if (player && (isTimeout || isAbort)) {
    return {
      family: 'stream-timeout',
      title: 'Timeout / connexion abort pendant l’ouverture du flux',
      summary:
        'ExoPlayer n’a pas reçu les en-têtes HTTP à temps (SocketTimeoutException) ou le socket a été coupé (connection abort). Souvent le même incident que le 502 : le proxy attend YouTube trop longtemps puis coupe.',
      likelyCause:
        'Upstream YouTube lent/bloqué, timeout Nginx trop court, Wi‑Fi instable, ou trop de DL offline en parallèle du lecteur.',
      actions: [
        'Même checklist que stream-5xx (OAuth TV / cookies / logs getAudioFormat)',
        'Vérifier timeouts reverse proxy (proxy_read_timeout ≥ 60s sur /api/stream/)',
        'Limiter la concurrence DL (1) pendant la lecture',
        'Si pos≈0 et dur=UNSET : le flux n’a jamais démarré — ce n’est pas une fin de piste',
      ],
      surface,
    };
  }

  if (is403 || is401) {
    return {
      family: 'auth-or-blocked',
      title: 'Accès refusé (401/403) ou LOGIN_REQUIRED YouTube',
      summary: 'Soit la session PLM a expiré, soit YouTube refuse la résolution de format depuis cette IP.',
      likelyCause: 'Token PLM périmé, cookies YouTube absents, ou IP datacenter bloquée.',
      actions: [
        'Revérifier login PLM / refresh token',
        'Session OAuth TV stream (docs/STREAM-VPS-OAUTH.md)',
        'Ne pas confondre avec un 403 googlevideo en fin de piste (EOS)',
      ],
      surface,
    };
  }

  if (player) {
    return {
      family: 'android-player',
      title: 'Erreur lecteur Android (source / ExoPlayer)',
      summary:
        'Le player a levé onPlayerError. Si network=true et local=false, la source est l’URL HTTP, pas le fichier hors-ligne.',
      likelyCause: 'URL stream morte, 5xx, timeout, ou cache Exo empoisonné.',
      actions: [
        'Lire errorCode Media3 (2004 = HTTP status, 2002 = timeout réseau)',
        'Vérifier streak + trackId dans meta',
        'Si dur=-9223372036854775807 (TIME_UNSET) : le média n’a jamais été ouvert',
      ],
      surface,
    };
  }

  if (offlineDl || /DL retry/i.test(text)) {
    return {
      family: 'offline-download',
      title: 'Téléchargement hors-ligne en échec',
      summary: 'Le gestionnaire offline n’a pas pu écrire le .m4a (souvent le même 502 que le stream).',
      likelyCause: 'Même chaîne /api/stream que la lecture. Les retries longs saturent le proxy.',
      actions: [
        'Circuit-breaker : arrêter OfflineKeeper tant que le stream est down',
        'Annuler les jobs (cancel) + supprimer les .part',
        'Réparer le stream (OAuth TV) avant de relancer les DL',
      ],
      surface,
    };
  }

  if (kind === 'window.error' || kind === 'unhandledrejection' || surface === 'web') {
    return {
      family: 'web-runtime',
      title: 'Erreur JavaScript web',
      summary: 'Exception non gérée dans le client web (fenêtre ou promesse).',
      likelyCause: kind === 'unhandledrejection' ? 'Promesse rejetée sans catch.' : 'throw / erreur script.',
      actions: [
        'Reproduire l’URL du meta + breadcrumbs',
        'Vérifier la version web vs /api/health (SW stale possible)',
        'Si message réseau/stream : même piste que stream-5xx côté API',
      ],
      surface: 'web',
    };
  }

  if (kind.includes('crash') || kind.includes('fatal')) {
    return {
      family: 'crash',
      title: 'Crash application',
      summary: 'Exception non catchée — l’app a pu être tuée.',
      likelyCause: 'Bug natif / Kotlin, OOM, ou service média.',
      actions: [
        'Lire la stack complète (PDF)',
        'Noter device / sdk / versionCode',
        'Vérifier si ça arrive au restore de file (PlaybackService)',
      ],
      surface,
    };
  }

  return {
    family: 'generic',
    title: 'Erreur applicative',
    summary: ev.message?.trim() || 'Pas de message — voir stack et logs récents.',
    likelyCause: 'À classer d’après kind + stack (pas assez de signatures connues).',
    actions: [
      'Lire breadcrumbs (nav / play) pour le dernier geste utilisateur',
      'Croiser recent logs (502, DNS, timeout)',
      'Si Android player : traiter comme un souci de flux /api/stream',
    ],
    surface,
  };
}

export function formatDiagnosisText(d: TelemetryDiagnosis): string {
  const actions = d.actions.map((a, i) => `  ${i + 1}. ${a}`).join('\n');
  return [
    `Famille : ${d.family} · surface : ${d.surface}`,
    d.title,
    '',
    d.summary,
    '',
    `Cause probable : ${d.likelyCause}`,
    '',
    'Actions :',
    actions,
  ].join('\n');
}
