const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jukebox', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  onSettingsUpdated: (callback) => ipcRenderer.on('settings:updated', (_event, settings) => callback(settings)),

  onLoadQueue: (callback) => ipcRenderer.on('player:load-queue', (_event, payload) => callback(payload)),
  onPlay: (callback) => ipcRenderer.on('player:play', () => callback()),
  onPause: (callback) => ipcRenderer.on('player:pause', () => callback()),
  onTogglePlayPause: (callback) => ipcRenderer.on('player:toggle-play-pause', () => callback()),
  onSkip: (callback) => ipcRenderer.on('player:skip', () => callback()),
  onPrevious: (callback) => ipcRenderer.on('player:previous', () => callback()),
  onSetCrossfadeDuration: (callback) => ipcRenderer.on('player:set-crossfade-duration', (_event, seconds) => callback(seconds)),
  onSetVolume: (callback) => ipcRenderer.on('player:set-volume', (_event, volume) => callback(volume)),

  reportState: (state) => ipcRenderer.send('player:state', state),
})
