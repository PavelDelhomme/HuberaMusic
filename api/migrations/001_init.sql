-- PostgreSQL 16 schema (from SQLite ytmusic.db + CREATE TABLE sources)
-- INTEGER timestamps/ids/counts → BIGINT; flags (0/1) → INTEGER; TEXT → TEXT; REAL → DOUBLE PRECISION

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  google_id TEXT UNIQUE,
  password_hash TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  email_verified INTEGER DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tracks_cache (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS reco_weights (
  mode TEXT PRIMARY KEY,
  w_content DOUBLE PRECISION NOT NULL,
  w_seq DOUBLE PRECISION NOT NULL,
  w_ctx DOUBLE PRECISION NOT NULL,
  w_bandit DOUBLE PRECISION NOT NULL,
  w_satisf DOUBLE PRECISION NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_canonical_hits (
  query_fold TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'seed',
  score BIGINT NOT NULL DEFAULT 100,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (query_fold, video_id)
);

CREATE TABLE IF NOT EXISTS track_duration_cache (
  video_id TEXT PRIMARY KEY,
  duration_seconds BIGINT NOT NULL,
  duration_text TEXT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  env TEXT,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT,
  stack TEXT,
  url TEXT,
  user_agent TEXT,
  user_id TEXT,
  device_id TEXT,
  meta TEXT,
  battery_level DOUBLE PRECISION,
  battery_charging INTEGER,
  perf_json TEXT
);

CREATE TABLE IF NOT EXISTS mail_outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  delivered INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS liked_tracks (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS library_tracks (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS liked_playlists (
  user_id TEXT NOT NULL,
  playlist_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, playlist_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS library_albums (
  user_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, album_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS library_artists (
  user_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, artist_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS library_mixes (
  user_id TEXT NOT NULL,
  mix_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, mix_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS library_album_tracks (
  user_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, album_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  cover_url TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  position BIGINT NOT NULL,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (playlist_id, track_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS history (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  played_at BIGINT NOT NULL,
  play_count BIGINT DEFAULT 1,
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_history (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  played_at BIGINT NOT NULL,
  play_count BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind, entity_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS downloads (
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  path TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, track_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS offline_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress BIGINT DEFAULT 0,
  total BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER DEFAULT 0,
  name TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  device_label TEXT,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ytm_accounts (
  user_id TEXT PRIMARY KEY,
  cookie_enc TEXT,
  oauth_enc TEXT,
  connected_at BIGINT NOT NULL,
  last_sync_at BIGINT,
  last_sync_summary TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  genres TEXT DEFAULT '[]',
  moods TEXT DEFAULT '[]',
  moments TEXT DEFAULT '[]',
  onboarding_done INTEGER DEFAULT 0,
  discovery_bias DOUBLE PRECISION DEFAULT 0.1,
  updated_at BIGINT NOT NULL,
  autoplay_suggestions INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS artist_follows (
  user_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  artist_name TEXT,
  payload TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, artist_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS listen_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  event TEXT NOT NULL,
  progress_pct DOUBLE PRECISION DEFAULT 0,
  duration_ms BIGINT,
  seed_id TEXT,
  hour BIGINT,
  is_weekend INTEGER,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS search_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  query TEXT NOT NULL,
  clicked_id TEXT,
  clicked_kind TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  position BIGINT DEFAULT 0,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, kind, target_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reco_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  seed_id TEXT,
  verdict TEXT NOT NULL,
  context TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS playback_state (
  user_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_mix_cache (
  user_id TEXT NOT NULL,
  mix_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  generated_at BIGINT NOT NULL,
  track_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, mix_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes (DESC from SQLite → normal btree)
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_events(created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_level ON telemetry_events(level);
CREATE INDEX IF NOT EXISTS idx_listen_user_time ON listen_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_search_user_time ON search_history(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_liked_tracks_user ON liked_tracks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_liked_tracks_track ON liked_tracks(track_id);
CREATE INDEX IF NOT EXISTS idx_history_user_played ON history(user_id, played_at);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pl ON playlist_tracks(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_refresh_user_active ON refresh_tokens(user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_library_tracks_user ON library_tracks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entity_history_user ON entity_history(user_id, played_at);
CREATE INDEX IF NOT EXISTS idx_search_hits_fold ON search_canonical_hits(query_fold);
CREATE INDEX IF NOT EXISTS idx_search_hits_video ON search_canonical_hits(video_id);
CREATE INDEX IF NOT EXISTS idx_user_mix_cache_gen ON user_mix_cache(generated_at);
CREATE INDEX IF NOT EXISTS idx_library_album_tracks_user_track ON library_album_tracks(user_id, track_id);
