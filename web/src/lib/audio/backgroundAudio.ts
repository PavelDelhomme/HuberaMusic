import { Capacitor, registerPlugin } from '@capacitor/core';

export type BackgroundAudioPlugin = {
  enable(options: { title?: string; artist?: string }): Promise<{ ok: boolean }>;
  update(options: { title?: string; artist?: string }): Promise<{ ok: boolean }>;
  disable(): Promise<{ ok: boolean }>;
};

const BackgroundAudio = registerPlugin<BackgroundAudioPlugin>('BackgroundAudio');

export async function setNativePlaybackNotification(opts: {
  playing: boolean;
  title?: string;
  artist?: string;
}) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
  try {
    if (opts.playing) {
      await BackgroundAudio.enable({
        title: opts.title || 'PLM',
        artist: opts.artist || 'Lecture en cours',
      });
    } else {
      await BackgroundAudio.disable();
    }
  } catch (err) {
    console.warn('BackgroundAudio', err);
  }
}

export { BackgroundAudio };
