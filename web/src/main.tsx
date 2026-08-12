import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { installGlobalTelemetry } from './lib/util/telemetry';
import { initNativeShell } from './lib/util/native';
import { initConnectivityWatch, isBrowserOnline } from './lib/offline/connectivity';
import { usePlayer } from './store/player';

installGlobalTelemetry();
void initNativeShell();
initConnectivityWatch(() => {
  const s = usePlayer.getState();
  if (s.playError) usePlayer.setState({ playError: null });
  // Reprend la lecture si elle était coupée par le réseau
  const audio = s.audioEl;
  if (audio && s.current && audio.paused && s.isPlaying === false) {
    void audio.play().then(() => {
      usePlayer.setState({ isPlaying: true, isLoading: false, playError: null });
    }).catch(() => {
      /* laisse l’utilisateur relancer */
    });
  }
});
// Hors ligne au boot : message doux, pas d’alarme
if (!isBrowserOnline()) {
  /* circuit breaker déjà armé par initConnectivityWatch */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
