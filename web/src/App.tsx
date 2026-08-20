import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { HomePage } from './pages/browse/HomePage';
import { ExplorePage } from './pages/browse/ExplorePage';
import { SearchPage } from './pages/browse/SearchPage';
import { LibraryPage } from './pages/library/LibraryPage';
import { ArtistPage, ArtistSongsPage, AlbumPage, PlaylistPage } from './pages/detail/DetailPages';
import { MoodPage } from './pages/browse/MoodPage';
import { LocalPlaylistPage } from './pages/library/LocalPlaylistPage';
import { MixPage } from './pages/browse/MixPage';
import { ImportPage } from './pages/library/ImportPage';
import { OfflinePage } from './pages/library/OfflinePage';
import { TvPage } from './pages/account/TvPage';
import { ProfilePage } from './pages/account/ProfilePage';
import { AdminPage } from './pages/account/AdminPage';
import { VerifyEmailPage } from './pages/account/VerifyEmailPage';
import { LoginDevicePage } from './pages/account/LoginDevicePage';
import { WatchPage } from './pages/browse/WatchPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="tv" element={<TvPage />} />
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="explore" element={<ExplorePage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="offline" element={<OfflinePage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route path="login-device" element={<LoginDevicePage />} />
          <Route path="watch/:id" element={<WatchPage />} />
          <Route path="artist/:id/songs" element={<ArtistSongsPage />} />
          <Route path="artist/:id" element={<ArtistPage />} />
          <Route path="album/:id" element={<AlbumPage />} />
          <Route path="playlist/:id" element={<PlaylistPage />} />
          <Route path="mix/:id" element={<MixPage />} />
          <Route path="mood/:id" element={<MoodPage />} />
          <Route path="local-playlist/:id" element={<LocalPlaylistPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
