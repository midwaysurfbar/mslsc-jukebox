const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jukebox', {
  // Settings / media folder
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseMediaFolder: () => ipcRenderer.invoke('media-folder:choose'),
  listVideos: () => ipcRenderer.invoke('media-folder:list'),

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
})
