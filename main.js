// MSLSC Jukebox - main process.
//
// Two windows: Control (staff-facing, the PC's own monitor - library,
// playlists, queue, settings) and Display (frameless fullscreen on the TV -
// just the two crossfading video decks). They never talk directly: every
// command and state update is relayed through here, the only thing both
// can reach. The real work lives in lib/ (no Electron there, so it's
// tested under plain Node - see test/); this file creates the windows and
// tray, wires IPC to lib/, and starts things up.
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, screen, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { createStore } = require('./lib/store')
const { createLibrary, walkImageFiles, requireFileKey, isFileKey } = require('./lib/library')
const { createConverter } = require('./lib/convert')
const { createMetadata } = require('./lib/metadata')
const { createWebAds } = require('./lib/web-ads')
const { createMediaWatch } = require('./lib/media-watch')
const { createUpdates } = require('./lib/updates')

// Deck videos play unmuted (to the venue's Bluetooth sound system), so
// allow autoplay without a gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// An uncaught error used to pop Electron's "A JavaScript error occurred"
// dialog live at the bar (2026-09-12: an EBUSY from a temp-file clean-up).
// Log it and keep running instead.
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err))
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason))

// ffmpeg-static points inside app.asar once packaged, which can't be
// executed - package.json's asarUnpack puts it beside it instead.
const ffmpegStaticPath = require('ffmpeg-static')
const FFMPEG_PATH = app.isPackaged ? ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked') : ffmpegStaticPath

// Development/testing only: JUKEBOX_USER_DATA points the app at a separate
// data folder, so a test run never touches the real library/queue/settings.
if (process.env.JUKEBOX_USER_DATA) app.setPath('userData', process.env.JUKEBOX_USER_DATA)

// Bundled with the app - there's exactly one intro clip, so nothing to pick.
const INTRO_VIDEO_PATH = path.join(__dirname, 'assets', 'intro-video.mp4')

const store = createStore(app.getPath('userData'))
const { paths } = store
let requests = null
const library = createLibrary(store, {
  trashItem: (p) => shell.trashItem(p),
  onScanned: () => { if (requests) requests.invalidateLibrary() },
})
const converter = createConverter({ store, library, ffmpegPath: FFMPEG_PATH, trashItem: (p) => shell.trashItem(p) })
const metadata = createMetadata({ store, library })
const webAds = createWebAds({ store })
const mediaWatch = createMediaWatch(() => {
  if (requests) requests.invalidateLibrary()
  sendToControl('media-folder:changed')
})

// --- Windows ---

let controlWindow = null
let displayWindow = null
let tray = null
let isQuitting = false
let updateReady = false
let displayHasLoaded = false

function alive(win) {
  return win && !win.isDestroyed()
}
function sendToControl(channel, payload) {
  if (alive(controlWindow)) controlWindow.webContents.send(channel, payload)
}
function sendToDisplay(channel, payload) {
  if (alive(displayWindow)) displayWindow.webContents.send(channel, payload)
}

// Both windows are sandboxed: their pages get only what their preload
// hands over (a fixed list of named calls), never Node itself.
const WEB_PREFERENCES = { contextIsolation: true, sandbox: true, nodeIntegration: false }

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#173F4F',
    title: 'MSLSC Jukebox',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { ...WEB_PREFERENCES, preload: path.join(__dirname, 'preload-control.js') },
  })
  controlWindow.loadFile(path.join(__dirname, 'control', 'index.html'))
  if (process.env.JUKEBOX_DEBUG) controlWindow.webContents.openDevTools({ mode: 'detach' })
  controlWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    controlWindow.hide()
  })
}

function createDisplayWindow() {
  // The TV is whichever display isn't the primary one. With only one screen
  // (development) it opens there, without taking over the whole screen.
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const target = displays.find((d) => d.id !== primary.id) || primary
  const singleDisplay = target.id === primary.id

  displayWindow = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    fullscreen: !singleDisplay,
    alwaysOnTop: !singleDisplay,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: { ...WEB_PREFERENCES, preload: path.join(__dirname, 'preload-display.js') },
  })
  displayWindow.loadFile(path.join(__dirname, 'display', 'index.html'))
  if (process.env.JUKEBOX_DEBUG) displayWindow.webContents.openDevTools({ mode: 'detach' })

  // If the TV's page crashes (a bad video can take it down), load it again
  // rather than leave a frozen or black screen. Any load after the very
  // first - this, or a window rebuilt by "Show on TV" - asks Control to hand
  // the queue back, so the music carries on.
  displayWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[display] renderer gone:', details.reason)
    if (details.reason !== 'clean-exit' && alive(displayWindow)) displayWindow.reload()
  })
  displayWindow.webContents.on('did-finish-load', () => {
    if (displayHasLoaded) sendToControl('display:restarted')
    displayHasLoaded = true
  })
  displayWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    displayWindow.hide()
  })
}

// Normally the Display window is only hidden (its close handler turns a
// close into a hide), so .show() is enough; if it's genuinely gone it's
// rebuilt - never a dead end only a restart gets out of (Sam, 2026-09-12).
function reopenDisplayWindow() {
  if (alive(displayWindow)) {
    displayWindow.show()
    displayWindow.focus()
  } else {
    createDisplayWindow()
  }
}

function showControl() {
  if (!alive(controlWindow)) return
  if (controlWindow.isMinimized()) controlWindow.restore()
  controlWindow.show()
  controlWindow.focus()
}

// --- IPC: settings, media folder ---

ipcMain.handle('settings:get', () => store.getSettings())
ipcMain.handle('settings:save', (_event, settings) => {
  store.writeJson(paths.settings, settings)
  sendToDisplay('settings:updated', settings)
  return true
})

ipcMain.handle('media-folder:choose', async () => {
  const result = await dialog.showOpenDialog(controlWindow, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const folder = result.filePaths[0]
  const previousFolder = store.getSettings().mediaFolder || ''
  store.writeJson(paths.settings, { ...store.getSettings(), mediaFolder: folder })
  await library.relinkMovedLibrary(previousFolder, folder)
  mediaWatch.start(folder)
  return folder
})
ipcMain.handle('media-folder:list', () => library.listLibrary())

// --- IPC: library ---

ipcMain.handle('track-info:save', (_event, key, info) => {
  store.loadTrackInfo()[requireFileKey(key)] = {
    duration: Number(info.duration) || 0,
    error: Boolean(info.error),
    needsConversion: Boolean(info.needsConversion),
  }
  store.scheduleTrackInfoWrite()
  return true
})
ipcMain.handle('library:sort-unsorted-by-decade', () => library.sortUnsortedByDecade())
ipcMain.handle('library:move-file-to-folder', (_event, sourcePath, folderPath) => library.moveFileToFolder(sourcePath, folderPath))
ipcMain.handle('library:delete-file', (_event, key, filePath) => library.deleteFile(key, filePath))
ipcMain.handle('library:trash-unplayable-file', (_event, key, filePath) => library.trashUnplayableFile(key, filePath))
ipcMain.handle('library:reset-all', () => {
  const settings = library.resetAll()
  mediaWatch.stop()
  sendToDisplay('settings:updated', settings)
  sendToDisplay('player:load-queue', { tracks: [], startIndex: 0 })
  return settings
})

// --- IPC: playlists, queue ---

ipcMain.handle('playlists:get-all', () => store.getPlaylists())
ipcMain.handle('playlists:save', (_event, playlist) => {
  const playlists = store.getPlaylists()
  const idx = playlists.findIndex((p) => p.id === playlist.id)
  if (idx >= 0) playlists[idx] = playlist
  else playlists.push(playlist)
  store.writeJson(paths.playlists, playlists)
  return playlists
})
ipcMain.handle('playlists:delete', (_event, id) => {
  const playlists = store.getPlaylists().filter((p) => p.id !== id)
  store.writeJson(paths.playlists, playlists)
  return playlists
})
ipcMain.handle('queue:get', () => store.getQueue())
ipcMain.handle('queue:save', (_event, queue) => {
  store.writeJson(paths.queue, queue)
  return true
})

// --- IPC: thumbnails (made in Control with <video>+<canvas>, saved here) ---

ipcMain.handle('thumbnails:save', (_event, key, dataUrl) => {
  requireFileKey(key)
  fs.mkdirSync(paths.thumbnails, { recursive: true })
  const filePath = path.join(paths.thumbnails, `${key}.jpg`)
  fs.writeFileSync(filePath, Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64'))
  return filePath
})
ipcMain.handle('thumbnails:get-path', (_event, key) => {
  if (!isFileKey(key)) return null
  const filePath = path.join(paths.thumbnails, `${key}.jpg`)
  return fs.existsSync(filePath) ? filePath : null
})

// --- IPC: conversion ---

ipcMain.handle('convert:get-path', (_event, key) => {
  if (!isFileKey(key)) return null
  const filePath = converter.convertedPathFor(key)
  return fs.existsSync(filePath) ? filePath : null
})
ipcMain.handle('convert:run', (_event, key, sourcePath) => converter.runConversion(key, sourcePath))
ipcMain.handle('convert:replace-original', (_event, key, sourcePath) => converter.replaceOriginal(key, sourcePath))
ipcMain.handle('convert:can-replace-originals', () => converter.canReplaceOriginals())

// --- IPC: tags ---

ipcMain.handle('metadata:get-cache', () => metadata.getCache())
ipcMain.handle('metadata:lookup', (_event, key, filename) => metadata.lookup(key, filename))
ipcMain.handle('metadata:set-manual', (_event, key, entry) => metadata.setManual(key, entry))

// --- IPC: intro clip, ads ---

ipcMain.handle('intro-video:get-path', () => (fs.existsSync(INTRO_VIDEO_PATH) ? INTRO_VIDEO_PATH : null))
ipcMain.handle('ads-folder:list', () => {
  const files = fs.existsSync(paths.webAds) ? walkImageFiles(paths.webAds) : []
  // Each ad's own display seconds/size, set in the Ad Manager.
  const adSettings = store.readJson(paths.webAdsMetadata, {})
  return { files: files.map((f) => ({ ...f, ...adSettings[f.filename] })) }
})
ipcMain.handle('web-ads:sync', () => webAds.sync())

// --- IPC: player relay between the two windows ---

const PLAYER_COMMANDS = ['load-queue', 'update-queue', 'play', 'pause', 'toggle-play-pause', 'skip', 'previous', 'seek', 'set-crossfade-duration', 'set-volume']
for (const command of PLAYER_COMMANDS) {
  ipcMain.on(`player:${command}`, (_event, payload) => sendToDisplay(`player:${command}`, payload))
}
ipcMain.on('player:state', (_event, state) => sendToControl('player:state', state))

// Same as the tray's "Show on TV", as a button in Control itself.
ipcMain.handle('display:reopen', () => {
  reopenDisplayWindow()
  return true
})

// --- Tray + updates ---

const updates = createUpdates({
  app,
  dialog,
  getControlWindow: () => controlWindow,
  sendStatus: (status) => sendToControl('update:status', status),
  onReady: () => { updateReady = true; refreshTrayMenu() },
})
ipcMain.handle('update:check', () => updates.checkNow())
ipcMain.handle('app:get-version', () => app.getVersion())

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-tray.png')))
  tray.setToolTip('MSLSC Jukebox')
  refreshTrayMenu()
  tray.on('click', () => {
    if (controlWindow.isVisible()) controlWindow.hide()
    else showControl()
  })
}

function refreshTrayMenu() {
  if (!tray) return
  const items = [
    { label: 'Open Control Panel', click: showControl },
    { label: 'Show on TV', click: reopenDisplayWindow },
  ]
  if (updateReady) {
    items.push({ type: 'separator' })
    items.push({ label: 'Restart to Update', click: () => updates.quitAndInstall() })
  }
  items.push({ type: 'separator' })
  items.push({ label: 'Quit', click: () => app.quit() })
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setToolTip(updateReady ? 'MSLSC Jukebox - update ready, restart to apply' : 'MSLSC Jukebox')
}

// --- Patron song requests (requests.js) ---

function startRequests() {
  try {
    requests = require('./requests')({
      ipcMain,
      getControlWindow: () => controlWindow,
      userData: paths.userData,
      thumbnailsDir: paths.thumbnails,
      readJson: store.readJson,
      writeJson: store.writeJson,
      listLibrary: () => library.listRequestLibrary(),
    })
  } catch (err) {
    // Requests are an extra - nothing about playing videos depends on them.
    console.error('[requests] could not start', err)
  }
}

// --- Start-up ---

// One Jukebox per PC. It hides in the tray, so the desktop icon gets
// double-clicked while it's running - that used to start a second copy (a
// second TV window, two copies writing the same queue). Now the running
// one comes to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showControl)
  app.whenReady().then(startApp)
}

function startApp() {
  Menu.setApplicationMenu(null)
  createControlWindow()
  createDisplayWindow()
  createTray()
  updates.start()
  mediaWatch.start(store.getSettings().mediaFolder)
  // A new or removed ad reaches the slideshow through the same "settings
  // changed" message Display already listens for.
  webAds.start(() => sendToDisplay('settings:updated', store.getSettings()))
  startRequests()
}

app.on('before-quit', () => {
  isQuitting = true
  store.flushTrackInfo()
  mediaWatch.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
