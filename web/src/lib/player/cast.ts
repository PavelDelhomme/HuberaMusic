import { apiUrl, artistNames, getToken, thumb, type Track } from '../../api';

declare global {
  interface Window {
    chrome?: any;
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
  }
}

let castLoaded = false;

function loadCastSdk(): Promise<void> {
  if (castLoaded && window.chrome?.cast) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.__onGCastApiAvailable = (ok) => {
      if (ok) {
        castLoaded = true;
        resolve();
      } else reject(new Error('Cast API indisponible'));
    };
    if (document.getElementById('cast-sdk')) {
      if (window.chrome?.cast) {
        castLoaded = true;
        resolve();
      }
      return;
    }
    const s = document.createElement('script');
    s.id = 'cast-sdk';
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.onerror = () => reject(new Error('Impossible de charger le SDK Cast'));
    document.body.appendChild(s);
  });
}

export function isCastAvailable() {
  return typeof window !== 'undefined';
}

export async function castToChromecast(track: Track) {
  await loadCastSdk();
  const context = window.cast?.framework?.CastContext?.getInstance?.();
  if (!context) {
    // Fallback: classic chrome.cast session
    return castClassic(track);
  }

  context.setOptions({
    receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  await context.requestSession();
  const session = context.getCurrentSession();
  if (!session) throw new Error('Aucune session Cast');

  const token = getToken();
  const q = token ? `?access_token=${encodeURIComponent(token)}` : '';
  const url = apiUrl(`/api/stream/${track.id}${q}`);
  const mediaInfo = new window.chrome.cast.media.MediaInfo(url, 'audio/mp4');
  mediaInfo.metadata = new window.chrome.cast.media.MusicTrackMediaMetadata();
  mediaInfo.metadata.title = track.title;
  mediaInfo.metadata.artist = artistNames(track);
  const art = thumb(track, 512);
  if (art) {
    mediaInfo.metadata.images = [new window.chrome.cast.Image(art)];
  }
  const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
  await session.loadMedia(request);
}

function castClassic(track: Track): Promise<void> {
  return new Promise((resolve, reject) => {
    const chrome = window.chrome;
    if (!chrome?.cast?.isAvailable) {
      reject(new Error('Chromecast non disponible sur ce navigateur'));
      return;
    }
    const sessionRequest = new chrome.cast.SessionRequest(chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID);
    const apiConfig = new chrome.cast.ApiConfig(
      sessionRequest,
      () => undefined,
      () => undefined,
    );
    chrome.cast.initialize(
      apiConfig,
      () => {
        chrome.cast.requestSession(
          (session: any) => {
            const token = getToken();
            const q = token ? `?access_token=${encodeURIComponent(token)}` : '';
            const url = apiUrl(`/api/stream/${track.id}${q}`);
            const mediaInfo = new chrome.cast.media.MediaInfo(url, 'audio/mp4');
            mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
            mediaInfo.metadata.title = track.title;
            mediaInfo.metadata.artist = artistNames(track);
            const req = new chrome.cast.media.LoadRequest(mediaInfo);
            session.loadMedia(
              req,
              () => resolve(),
              (err: unknown) => reject(err),
            );
          },
          (err: unknown) => reject(err),
        );
      },
      (err: unknown) => reject(err),
    );
  });
}

// cast.framework global
declare global {
  interface Window {
    cast?: any;
  }
}
