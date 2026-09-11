const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jukebox', {
  // Settings / media folder
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseMediaFolder: () => ipcRenderer.invoke('media-folder:choose'),
  listVideos: () => ipcRenderer.invoke('media-folder:list'),
  chooseAdsFolder: () => ipcRenderer.invoke('ads-folder:choose'),
  listAdImages: () => ipcRenderer.invoke('ads-folder:list'),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke('playlists:get-all'),
  savePlaylist: (playlist) => ipcRenderer.invoke('playlists:save', playlist),
  deletePlaylist: (id) => ipcRenderer.invoke('playlists:delete', id),

  // Queue
  getQueue: () => ipcRenderer.invoke('queue:get'),
  saveQueue: (queue) => ipcRenderer.invoke('queue:save', queue),

  // Wipes playlists/queue/caches/media-folder selection - never touches
  // the actual video files. Returns the reset settings.
  resetLibrary: () => ipcRenderer.invoke('library:reset-all'),

  // Permanently deletes one real file from the media drive - the one
  // library action that DOES touch a source file. Returns the cleaned-up
  // playlists/queue with every reference to it already removed.
  deleteFile: (key, filePath) => ipcRenderer.invoke('library:delete-file', key, filePath),
  // Same cleanup as deleteFile, but sends the source to the Recycle Bin
  // instead of permanently deleting it - used automatically when a
  // conversion attempt confirms a file can never be played (see
  // convertTrack in control/app.js), never from a direct user click.
  trashUnplayableFile: (key, filePath) => ipcRenderer.invoke('library:trash-unplayable-file', key, filePath),

  // Physically moves confidently-matched, currently-unsorted files into
  // decade subfolders (e.g. "1980s") based on cached metadata - see
  // library:sort-unsorted-by-decade in main.js for exactly what "confident"
  // and "unsorted" mean here.
  sortUnsortedByDecade: () => ipcRenderer.invoke('library:sort-unsorted-by-decade'),

  // Moves one file into an existing (or brand-new) folder - how a track
  // "joins" a folder-synced playlist from the Library's own picker.
  moveFileToFolder: (filePath, folderPath) => ipcRenderer.invoke('library:move-file-to-folder', filePath, folderPath),

  // Thumbnails (generated in this renderer via <video>+<canvas>, saved via main)
  saveThumbnail: (key, dataUrl) => ipcRenderer.invoke('thumbnails:save', key, dataUrl),
  getThumbnailPath: (key) => ipcRenderer.invoke('thumbnails:get-path', key),

  // Format conversion (bundled ffmpeg, runs in main - see convert:run)
  getConvertedPath: (key) => ipcRenderer.invoke('convert:get-path', key),
  convertFile: (key, sourcePath) => ipcRenderer.invoke('convert:run', key, sourcePath),

  // Metadata enrichment
  getMetadataCache: () => ipcRenderer.invoke('metadata:get-cache'),
  lookupMetadata: (key, filename) => ipcRenderer.invoke('metadata:lookup', key, filename),
  setManualMetadata: (key, entry) => ipcRenderer.invoke('metadata:set-manual', key, entry),

  // Player commands (relayed to the Display window)
  playerLoadQueue: (payload) => ipcRenderer.send('player:load-queue', payload),
  // Replaces Display's in-memory queue array without touching playback -
  // no reload, no restart-from-0 - used after a reorder (Shuffle) where
  // whatever's currently playing should keep playing right where it is.
  playerUpdateQueue: (tracks) => ipcRenderer.send('player:update-queue', tracks),
  playerPlay: () => ipcRenderer.send('player:play'),
  playerPause: () => ipcRenderer.send('player:pause'),
  playerTogglePlayPause: () => ipcRenderer.send('player:toggle-play-pause'),
  playerSkip: () => ipcRenderer.send('player:skip'),
  playerPrevious: () => ipcRenderer.send('player:previous'),
  playerSetCrossfadeDuration: (seconds) => ipcRenderer.send('player:set-crossfade-duration', seconds),
  playerSetVolume: (volume) => ipcRenderer.send('player:set-volume', volume),

  // Player state (relayed back from the Display window)
  onPlayerState: (callback) => ipcRenderer.on('player:state', (_event, state) => callback(state)),

  // Brings the TV/Display window back if it was accidentally closed -
  // same effect as the tray icon's "Show on TV" item, just somewhere
  // actually visible.
  reopenDisplay: () => ipcRenderer.invoke('display:reopen'),

  // Fires (debounced) whenever main's live filesystem watch notices a
  // change under the media folder - a new folder, added/removed/moved
  // files, all of it - so Control can silently re-run the same scan
  // Rescan Folder triggers manually, without anyone having to click it.
  onMediaFolderChanged: (callback) => ipcRenderer.on('media-folder:changed', () => callback()),

  // Auto-update (Settings tab's "Check for Updates" button + status line).
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  onUpdateStatus: (callback) => ipcRenderer.on('update:status', (_event, status) => callback(status)),

  // Web-uploaded ads (the standalone mslsc-jukebox-ad-upload page) -
  // Settings' own link/managed-list section.
  getAdUploadUrl: () => ipcRenderer.invoke('web-ads:get-upload-url'),
  listRemoteAds: () => ipcRenderer.invoke('web-ads:list-remote'),
  deleteRemoteAd: (passphrase, path) => ipcRenderer.invoke('web-ads:delete-remote', passphrase, path),
  // Fires after every periodic background sync (roughly every 2 minutes)
  // whether or not it actually changed anything, so Settings can show a
  // live "last checked" status.
  onWebAdsSynced: (callback) => ipcRenderer.on('web-ads:synced', (_event, result) => callback(result)),

  // Auto-generated "upcoming bar session" ads (see syncBarSessionAds in
  // main.js) - same "fires every pass, whether or not it changed
  // anything" status pattern as onWebAdsSynced above.
  syncBarSessionAdsNow: () => ipcRenderer.invoke('bar-session-ads:sync-now'),
  onBarSessionAdsSynced: (callback) => ipcRenderer.on('bar-session-ads:synced', (_event, result) => callback(result)),
})
