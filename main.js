const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, screen } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

// ffmpeg-static's own path points inside app.asar once packaged, which
// isn't directly executable - electron-builder is configured (see
// package.json's asarUnpack) to unpack this one file out to
// app.asar.unpacked at the same relative path, so this just needs to
// swap that one path segment rather than knowing the real path itself.
const ffmpegStaticPath = require('ffmpeg-static')
const FFMPEG_PATH = app.isPackaged
  ? ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked')
  : ffmpegStaticPath

// Two windows: Control (staff-facing, PC's own monitor - library, playlists,
// queue, settings) and Display (frameless fullscreen, sent to the TV's
// display - just the two crossfading video decks, no UI chrome at all).
// The two renderers never talk to each other directly - every command and
// every state update is relayed through this main process, since that's
// the only thing both sides can reach.

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v'])

const USER_DATA = app.getPath('userData')
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json')
const PLAYLISTS_PATH = path.join(USER_DATA, 'playlists.json')
const QUEUE_PATH = path.join(USER_DATA, 'queue.json')
const METADATA_PATH = path.join(USER_DATA, 'metadata.json')
const THUMBNAILS_DIR = path.join(USER_DATA, 'thumbnails')
const CONVERTED_DIR = path.join(USER_DATA, 'converted')

const DEFAULT_SETTINGS = { mediaFolder: '', crossfadeSeconds: 3, volume: 1 }

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value))
}

function fileKey(filePath, mtimeMs) {
  return crypto.createHash('md5').update(`${filePath}:${mtimeMs}`).digest('hex')
}

// --- Media folder scanning ---

function walkVideoFiles(dir, results = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkVideoFiles(full, results)
    } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const stat = fs.statSync(full)
      results.push({ path: full, filename: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, key: fileKey(full, stat.mtimeMs) })
    }
  }
  return results
}

// --- Windows ---

let controlWindow = null
let displayWindow = null
let tray = null
let isQuitting = false
let updateReady = false

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#173F4F',
    title: 'MSLSC Jukebox',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      sandbox: false,
    },
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
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  // Prefer whichever connected display isn't the primary one (the TV) -
  // falls back to the primary display if this machine only has one
  // (e.g. during local dev), just without forcing true fullscreen so it
  // doesn't take over the only screen while working on it.
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
    webPreferences: {
      preload: path.join(__dirname, 'preload-display.js'),
      contextIsolation: true,
      sandbox: false,
    },
  })
  displayWindow.loadFile(path.join(__dirname, 'display', 'index.html'))
  if (process.env.JUKEBOX_DEBUG) displayWindow.webContents.openDevTools({ mode: 'detach' })

  displayWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    displayWindow.hide()
  })
}

// --- IPC: settings / playlists / queue (plain JSON read/write in main) ---

ipcMain.handle('settings:get', () => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }))
ipcMain.handle('settings:save', (_event, settings) => {
  writeJson(SETTINGS_PATH, settings)
  if (displayWindow) displayWindow.webContents.send('settings:updated', settings)
  return true
})

ipcMain.handle('media-folder:choose', async () => {
  const result = await dialog.showOpenDialog(controlWindow, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const folder = result.filePaths[0]
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}), mediaFolder: folder }
  writeJson(SETTINGS_PATH, settings)
  return folder
})

ipcMain.handle('media-folder:list', () => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  if (!settings.mediaFolder) return []
  return walkVideoFiles(settings.mediaFolder)
})

ipcMain.handle('playlists:get-all', () => readJson(PLAYLISTS_PATH, []))
ipcMain.handle('playlists:save', (_event, playlist) => {
  const playlists = readJson(PLAYLISTS_PATH, [])
  const idx = playlists.findIndex((p) => p.id === playlist.id)
  if (idx >= 0) playlists[idx] = playlist
  else playlists.push(playlist)
  writeJson(PLAYLISTS_PATH, playlists)
  return playlists
})
ipcMain.handle('playlists:delete', (_event, id) => {
  const playlists = readJson(PLAYLISTS_PATH, []).filter((p) => p.id !== id)
  writeJson(PLAYLISTS_PATH, playlists)
  return playlists
})

ipcMain.handle('queue:get', () => readJson(QUEUE_PATH, { tracks: [], currentIndex: 0 }))
ipcMain.handle('queue:save', (_event, queue) => {
  writeJson(QUEUE_PATH, queue)
  return true
})

// --- IPC: thumbnails (generated client-side in Control via <video>+<canvas>, saved here) ---

ipcMain.handle('thumbnails:save', (_event, key, dataUrl) => {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true })
  const filePath = path.join(THUMBNAILS_DIR, `${key}.jpg`)
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
  return filePath
})
ipcMain.handle('thumbnails:get-path', (_event, key) => {
  const filePath = path.join(THUMBNAILS_DIR, `${key}.jpg`)
  return fs.existsSync(filePath) ? filePath : null
})

// --- IPC: format conversion for files Chromium can't decode natively
// (HEVC, AV1, AVI, WMV, etc) - re-encodes to plain H.264/AAC MP4 via
// the bundled ffmpeg binary. The original file is never touched; the
// converted copy is cached in userData keyed the same way as
// thumbnails, so it only ever needs converting once per file.

ipcMain.handle('convert:get-path', (_event, key) => {
  const filePath = path.join(CONVERTED_DIR, `${key}.mp4`)
  return fs.existsSync(filePath) ? filePath : null
})

ipcMain.handle('convert:run', (_event, key, sourcePath) => {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(CONVERTED_DIR, { recursive: true })
    const outputPath = path.join(CONVERTED_DIR, `${key}.mp4`)
    const tempPath = path.join(CONVERTED_DIR, `${key}.tmp.mp4`)

    const ffmpeg = spawn(FFMPEG_PATH, [
      '-y',
      '-i', sourcePath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      tempPath,
    ])

    let stderrTail = ''
    ffmpeg.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    ffmpeg.on('error', (err) => reject(new Error(`Could not start the converter: ${err.message}`)))
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Renamed into place only on success - a failed/interrupted
        // conversion never leaves a half-written file at the real path
        // for a later run to mistake for a finished one.
        fs.renameSync(tempPath, outputPath)
        resolve(outputPath)
      } else {
        fs.rmSync(tempPath, { force: true })
        reject(new Error(`Conversion failed (exit code ${code}): ${stderrTail.split('\n').pop()}`))
      }
    })
  })
})

// --- IPC: metadata enrichment (iTunes Search API - best-effort, cached
// permanently, never required for playback) ---

function guessArtistTitle(filename) {
  let name = filename.replace(/\.[^.]+$/, '')
  name = name.replace(/[\[(].*?(official|video|hd|lyrics|audio|4k|hq).*?[\])]/gi, '')
  name = name.replace(/^\s*\d+[\s._-]+/, '') // leading track numbers
  name = name.replace(/[_]+/g, ' ').trim()
  const parts = name.split(/\s*-\s*/)
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
  return { artist: '', title: name.trim() }
}

ipcMain.handle('metadata:get-cache', () => readJson(METADATA_PATH, {}))

ipcMain.handle('metadata:lookup', async (_event, key, filename) => {
  const cache = readJson(METADATA_PATH, {})
  if (cache[key]) return cache[key]

  const { artist, title } = guessArtistTitle(filename)
  const term = artist ? `${artist} ${title}` : title
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=musicVideo&limit=1`
    const response = await fetch(url)
    const data = await response.json()
    const hit = data.results && data.results[0]
    const entry = hit
      ? {
          artist: hit.artistName || artist || 'Unknown',
          genre: hit.primaryGenreName || 'Unknown',
          decade: hit.releaseDate ? `${Math.floor(new Date(hit.releaseDate).getFullYear() / 10) * 10}s` : 'Unknown',
          confidence: artist ? 'high' : 'low',
        }
      : { artist: artist || 'Unknown', genre: 'Unknown', decade: 'Unknown', confidence: 'none' }
    cache[key] = entry
    writeJson(METADATA_PATH, cache)
    return entry
  } catch {
    // Offline or the API's unreachable - leave uncached so it's retried
    // next time, never blocks anything in the meantime.
    return { artist: artist || 'Unknown', genre: 'Unknown', decade: 'Unknown', confidence: 'none', offline: true }
  }
})

ipcMain.handle('metadata:set-manual', (_event, key, entry) => {
  const cache = readJson(METADATA_PATH, {})
  cache[key] = { ...entry, confidence: 'manual' }
  writeJson(METADATA_PATH, cache)
  return cache[key]
})

// --- IPC: player command/state relay between the two windows ---

const PLAYER_COMMANDS = ['load-queue', 'play', 'pause', 'toggle-play-pause', 'skip', 'previous', 'set-crossfade-duration', 'set-volume']
for (const command of PLAYER_COMMANDS) {
  ipcMain.on(`player:${command}`, (_event, payload) => {
    if (displayWindow) displayWindow.webContents.send(`player:${command}`, payload)
  })
}
ipcMain.on('player:state', (_event, state) => {
  if (controlWindow) controlWindow.webContents.send('player:state', state)
})

// --- Tray + auto-update (mirrors MSLSC Shell's proven pattern) ---

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-tray.png'))
  tray = new Tray(icon)
  tray.setToolTip('MSLSC Jukebox')
  refreshTrayMenu()
  tray.on('click', () => {
    if (controlWindow.isVisible()) controlWindow.hide()
    else { controlWindow.show(); controlWindow.focus() }
  })
}

function refreshTrayMenu() {
  if (!tray) return
  const items = [
    { label: 'Open Control Panel', click: () => { controlWindow.show(); controlWindow.focus() } },
    { label: 'Show on TV', click: () => { displayWindow.show() } },
  ]
  if (updateReady) {
    items.push({ type: 'separator' })
    items.push({ label: 'Restart to Update', click: () => autoUpdater.quitAndInstall() })
  }
  items.push({ type: 'separator' })
  items.push({ label: 'Quit', click: () => app.quit() })
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setToolTip(updateReady ? 'MSLSC Jukebox - update ready, restart to apply' : 'MSLSC Jukebox')
}

function setupAutoUpdate() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  if (process.env.JUKEBOX_DEBUG) autoUpdater.logger = console

  autoUpdater.on('update-downloaded', () => {
    updateReady = true
    refreshTrayMenu()
  })
  autoUpdater.on('error', (err) => {
    if (process.env.JUKEBOX_DEBUG) console.log('AUTO-UPDATE ERROR', err)
  })

  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createControlWindow()
  createDisplayWindow()
  createTray()
  setupAutoUpdate()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
