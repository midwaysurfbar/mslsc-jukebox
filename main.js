const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, screen, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

// Deck videos play unmuted (audio goes to the Windows default output -
// the venue's Bluetooth sound system), so allow autoplay without a gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Safety net for the venue: an uncaught error anywhere in the main
// process used to pop Electron's default "A JavaScript error occurred
// in the main process" dialog - jarring and disruptive live, and it hit
// for real (2026-09-12: an EBUSY from a temp-file cleanup racing a just-
// killed ffmpeg process on Windows). Log it and keep the app running
// instead - Display/Control staying up in a possibly-degraded state
// beats a crash dialog interrupting whoever's at the bar.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

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

// .avi/.wmv almost always carry a codec Chromium can't decode natively
// (Xvid/DivX/WMV3/VC-1) - they'll just get flagged "Needs conversion"
// like any other unsupported file, same as before, but now they at
// least show up in the library to be converted at all.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.wmv'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

const USER_DATA = app.getPath('userData')
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json')
const PLAYLISTS_PATH = path.join(USER_DATA, 'playlists.json')
const QUEUE_PATH = path.join(USER_DATA, 'queue.json')
const METADATA_PATH = path.join(USER_DATA, 'metadata.json')
const THUMBNAILS_DIR = path.join(USER_DATA, 'thumbnails')
const CONVERTED_DIR = path.join(USER_DATA, 'converted')
// Local cache of ads synced down from the web uploader (see
// syncWebAds below) - kept entirely separate from adsFolder (the
// person's own manually-picked local folder) so both can coexist; the
// combined ad-slideshow list is just the two folders' contents added
// together (see ads-folder:list).
const WEB_ADS_DIR = path.join(USER_DATA, 'web-ads')
// Auto-generated "upcoming bar session" ads (see syncBarSessionAds
// below) - a THIRD ad source, deliberately its own folder rather than
// living inside WEB_ADS_DIR, since syncWebAds treats that folder as a
// mirror of the jukebox-ads bucket and deletes anything in it that
// isn't in the bucket's own listing. These ads never touch that bucket
// at all - they're rendered and managed entirely locally.
const BAR_SESSION_ADS_DIR = path.join(USER_DATA, 'bar-session-ads')
const BAR_SESSION_ADS_MANIFEST_PATH = path.join(BAR_SESSION_ADS_DIR, 'manifest.json')

const DEFAULT_SETTINGS = {
  mediaFolder: '',
  crossfadeSeconds: 3,
  volume: 1,
  // Ad slideshow between songs - off by default (adsEnabled false, and
  // adsFolder empty either way means nothing to show even if enabled).
  adsEnabled: false,
  adsFolder: '',
  adsEverySongs: 4,
  adsSecondsPerImage: 6,
  // Only needed to delete a web-uploaded ad from this app's own Settings
  // (rather than from the upload page itself) - typed once, remembered
  // here same as any other setting. Never sent anywhere except the
  // jukebox-ads function's own delete action.
  adUploadPassphrase: '',
  // Auto-generated "upcoming bar session" ads - off by default like
  // every other ad-related setting. No passphrase field for this one -
  // see BAR_SESSION_FEED_SECRET below, it's not a human-shared value.
  barSessionAdsEnabled: false,
}

// The standalone web page (separate repo: mslsc-jukebox-ad-upload) and
// the Supabase Edge Function backing it - lets anyone with the shared
// passphrase add or remove an ad image from anywhere, which this app
// then syncs down on its own. Same shared Supabase project every other
// MSLSC app already uses; these are public/anon-level values (an anon
// key + a well-known function URL), not secrets.
const JUKEBOX_AD_UPLOAD_PAGE = 'https://midwaysurfjukeboxads.vercel.app'
const JUKEBOX_ADS_FN_URL = 'https://zzfcadiphconmkeudrby.supabase.co/functions/v1/jukebox-ads'
const JUKEBOX_ADS_ANON_KEY = 'sb_publishable_IDOXZicxdptjL667yWpVAQ_H1jB2saj'
const WEB_ADS_SYNC_INTERVAL_MS = 2 * 60 * 1000

// Bar Booking System's feed of upcoming bar sessions (same shared
// Supabase project) - BAR_SESSION_FEED_SECRET isn't a human-shared
// value like adUploadPassphrase, it exists purely to keep casual
// scraping off a feed of real booking titles/dates, same threat model
// as the anon key above already being "not a secret" - so it's a
// second hardcoded constant rather than a Settings text field.
const UPCOMING_BAR_SESSIONS_FN_URL = 'https://zzfcadiphconmkeudrby.supabase.co/functions/v1/upcoming-bar-sessions'
const BAR_SESSION_FEED_SECRET = 'mS_ZTya-w3ZqjLNpfGeFMP4TvQSE_vlH'
const BAR_SESSION_SYNC_INTERVAL_MS = 30 * 60 * 1000
const BAR_SESSION_AD_HORIZON_DAYS = 14

function callJukeboxAdsFn(body) {
  return fetch(JUKEBOX_ADS_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${JUKEBOX_ADS_ANON_KEY}`,
      apikey: JUKEBOX_ADS_ANON_KEY,
    },
    body: JSON.stringify(body),
  }).then((r) => r.json())
}

// Pulls the current web-uploaded ad list and reconciles it against
// WEB_ADS_DIR - downloads anything new, deletes anything no longer
// listed remotely (so a delete from the web page takes effect here on
// the next pass, not just on the page itself). Never touches adsFolder,
// the person's own separately-managed local folder. Failure here (no
// internet, function unreachable) is never fatal - whatever's already
// downloaded keeps working exactly as before, same principle as every
// other "best-effort background sync" in this app.
async function syncWebAds() {
  let files
  try {
    const data = await callJukeboxAdsFn({ action: 'list' })
    if (!data.ok) throw new Error(data.error || 'Could not list web ads.')
    files = data.files
  } catch (err) {
    return { ok: false, error: err.message }
  }

  fs.mkdirSync(WEB_ADS_DIR, { recursive: true })
  const remoteNames = new Set(files.map((f) => f.path))
  const existingLocal = new Set(fs.readdirSync(WEB_ADS_DIR))

  let downloaded = 0
  for (const file of files) {
    if (existingLocal.has(file.path)) continue // already have it - the path is timestamp-prefixed, so it's stable and unique
    try {
      const response = await fetch(file.url)
      if (!response.ok) continue // try again on the next pass
      fs.writeFileSync(path.join(WEB_ADS_DIR, file.path), Buffer.from(await response.arrayBuffer()))
      downloaded += 1
    } catch { /* offline mid-download, or similar - try again next pass */ }
  }

  let removed = 0
  for (const localName of existingLocal) {
    if (!remoteNames.has(localName)) {
      try { fs.rmSync(path.join(WEB_ADS_DIR, localName), { force: true }); removed += 1 } catch { /* best effort */ }
    }
  }

  return { ok: true, downloaded, removed, total: files.length }
}

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

// --- Auto-generated "upcoming bar session" ads ---
//
// Renders a real ad image for every bar session the Bar Booking System
// says is upcoming (see upcoming-bar-sessions Edge Function) and keeps
// BAR_SESSION_ADS_DIR reconciled to that list on a timer - a session
// that's no longer in the list (its date arrived, it got cancelled, or
// a standing occurrence got closed) has its ad deleted on the very next
// pass. One diff pass handles add/update/remove together.

function callUpcomingBarSessionsFn(horizonDays) {
  return fetch(UPCOMING_BAR_SESSIONS_FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-bar-session-feed-secret': BAR_SESSION_FEED_SECRET,
    },
    body: JSON.stringify({ horizonDays }),
  }).then((r) => r.json())
}

// The session title is free text a committee member typed when creating
// a booking or standing rule - has to be escaped before it goes into
// the ad's HTML, or a stray < or & breaks the layout.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function formatSessionDate(eventDate) {
  return new Date(`${eventDate}T00:00:00`).toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' })
}

function formatSessionTime12h(hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number)
  const period = h < 12 ? 'am' : 'pm'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${hour12}${period}` : `${hour12}:${String(m).padStart(2, '0')}${period}`
}

// Longer titles shrink instead of running toward the edge of the
// title-safe area below - Sam, 2026-09-12: a real "Friday Club Bar
// Session" title got its last few letters cut clean off on the venue's
// actual TV, even though the full text sat comfortably inside the
// rendered 1920x1080 image with room to spare - the TV's own Overscan/
// Zoom picture mode was cropping the edges of the incoming PC signal.
// That needs fixing on the TV itself, but a broadcast-standard
// "title-safe" margin (keep text within the inner ~80% of the frame)
// means this can't be clipped even on a TV where it isn't.
function titleFontSizeFor(title) {
  const len = title.length
  if (len > 32) return 68
  if (len > 24) return 82
  if (len > 18) return 96
  return 112
}

// Inline template, not a separate file - no external resources needed
// (system fonts only), which also sidesteps adding a new file to
// package.json's electron-builder "files" whitelist.
function buildBarSessionAdHtml(session) {
  const dateLabel = formatSessionDate(session.eventDate)
  const timeLabel = `${formatSessionTime12h(session.startTime)}–${formatSessionTime12h(session.endTime)}`
  const titleFontSize = titleFontSizeFor(session.title)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:1920px;height:1080px;overflow:hidden;background:linear-gradient(135deg,#0d2635,#153b50 55%,#1c4f66);font-family:Arial,Helvetica,sans-serif}
    .wrap{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#eef6f7;text-align:center;box-sizing:border-box;padding:110px 180px;position:relative}
    .eyebrow{font-size:40px;letter-spacing:12px;text-transform:uppercase;color:#5fd0e0;font-weight:700;margin-bottom:32px}
    .title{font-size:${titleFontSize}px;font-weight:800;line-height:1.15;margin:0 0 46px;text-shadow:0 4px 18px rgba(0,0,0,.35)}
    .date{font-size:60px;font-weight:700;color:#ffffff;margin-bottom:16px}
    .time{font-size:50px;font-weight:600;color:#bfe3ea}
    .footer{position:absolute;left:0;right:0;bottom:74px;text-align:center;font-size:30px;letter-spacing:4px;color:#7fa8b8;font-weight:700;text-transform:uppercase}
    .bar{position:absolute;left:0;bottom:0;width:100%;height:14px;background:linear-gradient(90deg,#2b7182,#5fd0e0)}
  </style></head><body><div class="wrap">
    <div class="eyebrow">Coming Up</div>
    <div class="title">${escapeHtml(session.title)}</div>
    <div class="date">${dateLabel}</div>
    <div class="time">${timeLabel}</div>
    <div class="footer">Midway Surf Life Saving Club &middot; Bar</div>
    <div class="bar"></div>
  </div></body></html>`
}

// NOT ":" in the allowed set - a sourceKey like "standing:<uuid>:<date>"
// would otherwise produce a colon-containing filename, which NTFS on
// the real venue PC (Windows) reserves for alternate-data-stream syntax
// and can reject or mishandle - caught by actually running this against
// a real sourceKey rather than just reasoning about it.
function sanitizeSourceKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_-]/g, '-')
}

// Off-screen BrowserWindow + capturePage() - Electron's own Chromium
// renderer, used as a free screenshot engine. show:false is the
// standard technique for this, though a small number of Electron/
// Chromium versions have returned a blank capture from a never-shown
// window on certain GPU drivers - if that turns out to be the case on
// the venue PC, the fallback is positioning the window off every
// display's bounds and calling show() before capturing instead.
async function renderBarSessionAdPng(session) {
  const html = buildBarSessionAdHtml(session)
  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    frame: false,
    useContentSize: true,
    width: 1920,
    height: 1080,
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    try {
      await win.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true'
      )
    } catch { /* system fonts only - this is a hedge, not a requirement */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const image = await win.webContents.capturePage()
    return image.toPNG()
  } finally {
    win.destroy()
  }
}

// Reconciles BAR_SESSION_ADS_DIR to the current eligible-sessions list -
// renders/saves a PNG for anything new, re-renders anything whose
// content changed (a committee member can edit a booking's title/time
// after ads for it already exist), and deletes anything no longer
// eligible (date passed, cancelled, or a standing date got closed).
async function syncBarSessionAds() {
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  if (!settings.barSessionAdsEnabled) return { ok: true, skipped: true, added: 0, removed: 0, updated: 0, total: 0 }

  let sessions
  try {
    const data = await callUpcomingBarSessionsFn(BAR_SESSION_AD_HORIZON_DAYS)
    if (!data.ok) throw new Error(data.error || 'Could not load upcoming bar sessions.')
    sessions = data.sessions
  } catch (err) {
    return { ok: false, error: err.message }
  }

  fs.mkdirSync(BAR_SESSION_ADS_DIR, { recursive: true })
  const manifest = readJson(BAR_SESSION_ADS_MANIFEST_PATH, { entries: {} })
  const eligibleByKey = new Map(sessions.map((s) => [s.sourceKey, s]))

  let added = 0
  let removed = 0
  let updated = 0

  for (const key of Object.keys(manifest.entries)) {
    if (!eligibleByKey.has(key)) {
      try { fs.rmSync(path.join(BAR_SESSION_ADS_DIR, manifest.entries[key].pngFilename), { force: true }) } catch { /* best effort */ }
      delete manifest.entries[key]
      removed += 1
    }
  }

  for (const [key, session] of eligibleByKey) {
    const signature = JSON.stringify([session.title, session.eventDate, session.startTime, session.endTime])
    const existing = manifest.entries[key]
    if (existing && existing.signature === signature) continue

    let pngBuffer
    try {
      pngBuffer = await renderBarSessionAdPng(session)
    } catch {
      continue // try again next pass rather than failing the whole sync
    }

    if (existing) {
      try { fs.rmSync(path.join(BAR_SESSION_ADS_DIR, existing.pngFilename), { force: true }) } catch { /* best effort */ }
    }

    const pngFilename = `${sanitizeSourceKey(key)}.png`
    fs.writeFileSync(path.join(BAR_SESSION_ADS_DIR, pngFilename), pngBuffer)
    manifest.entries[key] = { pngFilename, signature, generatedAt: new Date().toISOString() }
    if (existing) updated += 1
    else added += 1
  }

  if (added > 0 || removed > 0 || updated > 0) writeJson(BAR_SESSION_ADS_MANIFEST_PATH, manifest)

  return { ok: true, added, removed, updated, total: Object.keys(manifest.entries).length }
}

// Same "run now, then every interval" shape as startSyncingWebAds - the
// settings:updated broadcast (only when something actually changed) is
// what makes a new/removed bar-session ad show up in the slideshow on
// its own.
function startSyncingBarSessionAds() {
  const runSync = async () => {
    const result = await syncBarSessionAds()
    if (controlWindow) controlWindow.webContents.send('bar-session-ads:synced', result)
    if (result.ok && (result.added > 0 || result.removed > 0 || result.updated > 0) && displayWindow) {
      const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
      displayWindow.webContents.send('settings:updated', settings)
    }
  }
  runSync()
  setInterval(runSync, BAR_SESSION_SYNC_INTERVAL_MS)
}

// Deliberately NOT keyed on mtime - copying files onto the PC (from a
// USB stick, extracting an archive, a sync tool) very commonly resets
// modified-time even though the content is byte-identical. That used to
// mint a brand new key for the exact same video, so its already-converted
// copy silently became unreachable (orphaned on disk) and the track
// looked unconverted again despite a perfectly good converted copy
// already existing. Size changes far less often than mtime for a file
// that's genuinely the same content, so path+size is a much more stable
// identity for this purpose.
function fileKey(filePath, size) {
  return crypto.createHash('md5').update(`${filePath}:${size}`).digest('hex')
}

// --- Media folder scanning ---

// `root` is threaded through the recursion (unchanged on every call)
// purely so each file can record which subfolder it's actually in,
// relative to the media folder - e.g. a file in `<root>/80's/x.mp4` gets
// folder: "80's", one in `<root>/80's/Rock/y.mp4` gets folder: "80's/Rock",
// and one directly in the root gets folder: "". That's what lets
// syncFolderPlaylists (below) turn "make a folder" into "get a playlist"
// with no extra step.
function walkVideoFiles(dir, root, results = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    // Dot-prefixed entries are hidden Unix/macOS convention, never a
    // real video a person meant to add - most commonly .AppleDouble
    // (a whole folder of 0-byte same-named sidecar files macOS leaves
    // behind when files are copied to/from a Mac onto a filesystem that
    // can't store its metadata) and ._filename sidecars sitting next to
    // the real file. Without this, each one looks like a second, broken
    // copy of every real video - same filename, fails to play (it's not
    // actually video data), shows as "needs conversion" right next to
    // the real, working entry. fs.readdirSync doesn't filter these out
    // itself the way Windows Explorer / Get-ChildItem do by default.
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkVideoFiles(full, root, results)
    } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const stat = fs.statSync(full)
      const folder = path.relative(root, dir).split(path.sep).join('/')
      results.push({ path: full, filename: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, key: fileKey(full, stat.size), folder })
    }
  }
  return results
}

// Auto-creates/syncs one playlist per subfolder actually found under the
// media folder (e.g. "80's", or "80's/Rock" for a nested one) - dragging
// videos into a folder is then the whole "add to playlist" step, no
// manual per-track picking needed. Marked `autoFolder: true` with the
// `folderPath` it came from so it's never confused with, or clobbered by
// editing, a manually-built playlist of the same name - Control uses that
// flag to hide manual add/remove controls on these, since membership here
// is always exactly "what's in the folder right now" as of the last scan,
// not something worth hand-editing only to have the next rescan undo it.
// Files sitting directly in the media folder's root (folder: "") don't
// get a playlist - there's no folder name to draw one from.
function syncFolderPlaylists(files) {
  const byFolder = new Map()
  for (const file of files) {
    if (!file.folder) continue
    if (!byFolder.has(file.folder)) byFolder.set(file.folder, [])
    byFolder.get(file.folder).push(file.key)
  }

  let playlists = readJson(PLAYLISTS_PATH, [])
  // A folder that's been deleted, emptied, or renamed no longer has a
  // matching entry in byFolder - drop the stale auto-playlist along with
  // it. A manually-built playlist (autoFolder unset) is never touched here.
  playlists = playlists.filter((p) => !p.autoFolder || byFolder.has(p.folderPath))

  for (const [folderPath, trackKeys] of byFolder) {
    const name = folderPath.split('/').join(' / ')
    const existing = playlists.find((p) => p.autoFolder && p.folderPath === folderPath)
    if (existing) {
      existing.trackKeys = trackKeys
      existing.name = name // picks up a folder rename automatically too
    } else {
      playlists.push({ id: crypto.randomUUID(), name, autoFolder: true, folderPath, trackKeys })
    }
  }

  writeJson(PLAYLISTS_PATH, playlists)
  return playlists
}

// Same idea as walkVideoFiles, for the ad slideshow's image folder - no
// caching/conversion needed for a still image, so this just returns
// paths, not the richer {size, mtimeMs, key} shape videos need.
function walkImageFiles(dir, results = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkImageFiles(full, results)
    } else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push({ path: full, filename: entry.name })
    }
  }
  return results
}

// Removes any cached thumbnail/converted-video file that no longer
// corresponds to a video the last scan actually found - the leftovers
// from the mtime-keying bug described above, plus any ordinary case of
// a source file being renamed/deleted. Only runs when the scan actually
// found files: an empty result (e.g. the media folder is temporarily
// unreachable - drive unplugged, network share down) must never be
// read as "everything's gone, delete every cache file" - the source
// videos are never touched either way, so the only cost of a wrongful
// prune would be one extra re-conversion later, but there's no reason
// to risk it needlessly.
function pruneOrphanedCacheFiles(validKeys) {
  let removed = 0
  for (const dir of [THUMBNAILS_DIR, CONVERTED_DIR]) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const key = name.replace(/\.[^.]+$/, '').replace(/\.tmp$/, '')
      if (!validKeys.has(key)) {
        try { fs.rmSync(path.join(dir, name), { force: true }); removed += 1 } catch { /* best effort */ }
      }
    }
  }
  return removed
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

// --- Live media-folder watching ---
//
// Without this, a new folder/file dropped into the media folder while
// the app is already open sits invisible until someone clicks Rescan
// Folder (or restarts the app) - both scan-on-demand, neither notices
// on their own. This tells Control to quietly re-run that exact same
// scan the moment something changes on disk.
//
// fs.watch's `recursive: true` only actually works on Windows and macOS
// (Node throws synchronously on Linux) - which covers the real target
// here (the venue PC is Windows), so that's the primary path. Where it's
// unavailable, a plain interval poll is a perfectly good fallback: a
// little slower to notice a change, but it still works, and it's far
// simpler than hand-rolling recursive watching by tracking one fs.watch
// per subfolder.
let mediaWatcher = null
let mediaPollTimer = null
let mediaRescanDebounce = null

function stopWatchingMediaFolder() {
  if (mediaWatcher) { try { mediaWatcher.close() } catch { /* already gone */ } mediaWatcher = null }
  if (mediaPollTimer) { clearInterval(mediaPollTimer); mediaPollTimer = null }
  if (mediaRescanDebounce) { clearTimeout(mediaRescanDebounce); mediaRescanDebounce = null }
}

// Debounced - a real copy operation (or this app's own Sort/Move actions)
// fires many filesystem events in quick succession, and there's no
// reason to tell Control to rescan more than once per burst of activity.
// Short enough that the native watcher (Windows/macOS) still feels
// near-instant - this delay, not the watcher itself, is the only real
// lag between "file lands on disk" and "library updates" on those
// platforms, so it's the one knob worth keeping small.
function notifyMediaFolderChanged() {
  if (mediaRescanDebounce) clearTimeout(mediaRescanDebounce)
  mediaRescanDebounce = setTimeout(() => {
    if (controlWindow) controlWindow.webContents.send('media-folder:changed')
  }, 400)
}

function startWatchingMediaFolder(mediaFolder) {
  stopWatchingMediaFolder()
  if (!mediaFolder) return
  try {
    mediaWatcher = fs.watch(mediaFolder, { recursive: true }, () => notifyMediaFolderChanged())
    // A watched drive/network share disappearing (unplugged, share down)
    // surfaces here as an 'error', not a thrown exception - not fatal,
    // and not this app's job to recover from mid-flight; the next
    // successful scan (manual or once the watcher is restarted) picks
    // back up normally, same as every other media-folder-unreachable
    // case already handled elsewhere (see pruneOrphanedCacheFiles).
    mediaWatcher.on('error', () => {})
  } catch {
    // recursive watching isn't supported on this platform (Linux) -
    // fall back to a plain poll. This only ever runs on the Linux
    // build - the real target (the venue PC) is Windows, which always
    // takes the instant native-watch path above.
    mediaWatcher = null
    mediaPollTimer = setInterval(() => notifyMediaFolderChanged(), 3000)
  }
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
  startWatchingMediaFolder(folder)
  return folder
})

ipcMain.handle('media-folder:list', () => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  if (!settings.mediaFolder) return { files: [], prunedCount: 0, playlists: readJson(PLAYLISTS_PATH, []) }
  const files = walkVideoFiles(settings.mediaFolder, settings.mediaFolder)
  // Both of these are guarded on a non-empty scan for the same reason -
  // a media folder that's temporarily unreachable (drive unplugged,
  // network share down) must never be read as "everything's gone" and
  // wipe every folder-playlist along with the cache.
  const prunedCount = files.length > 0 ? pruneOrphanedCacheFiles(new Set(files.map((r) => r.key))) : 0
  const playlists = files.length > 0 ? syncFolderPlaylists(files) : readJson(PLAYLISTS_PATH, [])
  return { files, prunedCount, playlists }
})

// Shared by every action below that moves/renames a real media file -
// doing so changes its key (md5 of path+size, see fileKey above), so
// anything that referenced the old key needs to follow it to the new one:
// its cached thumbnail/converted copy, its metadata guess, every
// playlist, and the queue. Each store is read and written fresh rather
// than threaded through callers, since this only ever runs a handful of
// times per action, never once per file in a hot loop.
function remapFileKey(oldKey, newKey) {
  for (const [dir, ext] of [[THUMBNAILS_DIR, '.jpg'], [CONVERTED_DIR, '.mp4']]) {
    const oldPath = path.join(dir, `${oldKey}${ext}`)
    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, path.join(dir, `${newKey}${ext}`))
  }

  const metadata = readJson(METADATA_PATH, {})
  if (metadata[oldKey]) {
    metadata[newKey] = metadata[oldKey]
    delete metadata[oldKey]
    writeJson(METADATA_PATH, metadata)
  }

  const playlists = readJson(PLAYLISTS_PATH, [])
  let playlistsChanged = false
  for (const p of playlists) {
    const idx = p.trackKeys.indexOf(oldKey)
    if (idx >= 0) { p.trackKeys[idx] = newKey; playlistsChanged = true }
  }
  if (playlistsChanged) writeJson(PLAYLISTS_PATH, playlists)

  const queue = readJson(QUEUE_PATH, { tracks: [], currentIndex: 0 })
  if (queue.tracks.includes(oldKey)) {
    queue.tracks = queue.tracks.map((k) => (k === oldKey ? newKey : k))
    writeJson(QUEUE_PATH, queue)
  }
}

// Moves one real file into `destDir` (creating it if needed), handling a
// filename collision with a "(2)"-style suffix rather than overwriting
// anything, then follows its key to the new location via remapFileKey.
function moveFileTo(sourcePath, size, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  let destName = path.basename(sourcePath)
  let destPath = path.join(destDir, destName)
  if (fs.existsSync(destPath) && path.resolve(destPath) !== path.resolve(sourcePath)) {
    const ext = path.extname(destName)
    const base = path.basename(destName, ext)
    let n = 2
    while (fs.existsSync(destPath)) {
      destName = `${base} (${n})${ext}`
      destPath = path.join(destDir, destName)
      n += 1
    }
  }
  const oldKey = fileKey(sourcePath, size)
  fs.renameSync(sourcePath, destPath)
  const newKey = fileKey(destPath, size)
  remapFileKey(oldKey, newKey)
  return newKey
}

// Physically relocates files into decade subfolders (e.g. "1980s") based
// on the iTunes-lookup metadata Control already cached for them - the one
// place in the app that moves a real source file rather than only ever
// reading it (contrast library:delete-file, which removes one; every
// other library action never touches a source file at all). Kept
// deliberately conservative on both axes that matter for something this
// hard to undo automatically:
//   - Only ever considers files still sitting loose in the media folder's
//     root (file.folder === '') - anything you've already organized into
//     a folder yourself, under any name, is left completely alone.
//   - Only moves a 'high'-confidence or manually-corrected match - a
//     fuzzy/low-confidence guess is left in place rather than risk
//     mis-filing it somewhere you'd have to go hunting for it.
ipcMain.handle('library:sort-unsorted-by-decade', () => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  const mediaFolder = settings.mediaFolder ? path.resolve(settings.mediaFolder) : ''
  if (!mediaFolder) return { moved: 0, skipped: 0, movedKeys: {}, files: [], playlists: readJson(PLAYLISTS_PATH, []), queue: readJson(QUEUE_PATH, { tracks: [], currentIndex: 0 }) }

  const files = walkVideoFiles(mediaFolder, mediaFolder)
  const metadata = readJson(METADATA_PATH, {})
  const movedKeys = {} // oldKey -> newKey, so Control can update just the tracks that actually moved
  let moved = 0
  let skipped = 0

  for (const file of files) {
    if (file.folder) continue // already organized into some folder - not this feature's business
    const meta = metadata[file.key]
    const confident = meta && meta.decade && meta.decade !== 'Unknown' && (meta.confidence === 'high' || meta.confidence === 'manual')
    if (!confident) { skipped += 1; continue }
    movedKeys[file.key] = moveFileTo(file.path, file.size, path.join(mediaFolder, meta.decade))
    moved += 1
  }

  // Re-scan for the real, final state (new folders now exist on disk) and
  // let the existing folder-playlist sync pick up the newly-created decade
  // folders exactly like any other folder a person made by hand.
  const rescannedFiles = walkVideoFiles(mediaFolder, mediaFolder)
  const playlists = rescannedFiles.length > 0 ? syncFolderPlaylists(rescannedFiles) : readJson(PLAYLISTS_PATH, [])
  const prunedCount = rescannedFiles.length > 0 ? pruneOrphanedCacheFiles(new Set(rescannedFiles.map((r) => r.key))) : 0
  const queue = readJson(QUEUE_PATH, { tracks: [], currentIndex: 0 })

  return { moved, skipped, movedKeys, files: rescannedFiles, playlists, queue, prunedCount }
})

// The interactive, one-track equivalent of organizing files in File
// Explorer - triggered from the Library's own "+ Playlist" picker on a
// single tile rather than requiring a trip out to the filesystem.
// `folderPath` is either an existing folder-playlist's folder or a
// brand-new name typed on the spot; either way, moving the real file is
// what makes it "join" that playlist, consistent with folders being the
// source of truth for these playlists everywhere else in the app.
// Refuses to resolve outside the media folder - defence in depth, since
// the UI only ever offers an existing folder name or a freshly-typed one,
// but this is the one place a bad name could do real damage on disk.
ipcMain.handle('library:move-file-to-folder', (_event, sourcePath, folderPath) => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  const mediaFolder = settings.mediaFolder ? path.resolve(settings.mediaFolder) : ''
  const resolvedSource = path.resolve(sourcePath)
  if (!mediaFolder || (resolvedSource !== mediaFolder && !resolvedSource.startsWith(mediaFolder + path.sep))) {
    throw new Error('Refusing to move a file outside the configured media folder.')
  }
  const destDir = path.resolve(path.join(mediaFolder, folderPath))
  if (destDir !== mediaFolder && !destDir.startsWith(mediaFolder + path.sep)) {
    throw new Error('Refusing to move a file to a folder outside the media folder.')
  }

  const stat = fs.statSync(resolvedSource)
  const newKey = moveFileTo(resolvedSource, stat.size, destDir)

  const rescannedFiles = walkVideoFiles(mediaFolder, mediaFolder)
  const playlists = rescannedFiles.length > 0 ? syncFolderPlaylists(rescannedFiles) : readJson(PLAYLISTS_PATH, [])
  const prunedCount = rescannedFiles.length > 0 ? pruneOrphanedCacheFiles(new Set(rescannedFiles.map((r) => r.key))) : 0
  const queue = readJson(QUEUE_PATH, { tracks: [], currentIndex: 0 })

  return { newKey, files: rescannedFiles, playlists, queue, prunedCount }
})

ipcMain.handle('ads-folder:choose', async () => {
  const result = await dialog.showOpenDialog(controlWindow, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  const folder = result.filePaths[0]
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}), adsFolder: folder }
  writeJson(SETTINGS_PATH, settings)
  if (displayWindow) displayWindow.webContents.send('settings:updated', settings)
  return folder
})

ipcMain.handle('ads-folder:list', () => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  const files = []
  if (settings.adsFolder) files.push(...walkImageFiles(settings.adsFolder))
  if (fs.existsSync(WEB_ADS_DIR)) files.push(...walkImageFiles(WEB_ADS_DIR))
  // Gated on the setting (not just folder existence) so turning
  // barSessionAdsEnabled off immediately stops these showing, rather
  // than waiting for the next sync pass to clean the folder out.
  if (settings.barSessionAdsEnabled && fs.existsSync(BAR_SESSION_ADS_DIR)) files.push(...walkImageFiles(BAR_SESSION_ADS_DIR))
  return { files }
})

// --- Web-uploaded ads (see syncWebAds above) ---

ipcMain.handle('web-ads:get-upload-url', () => JUKEBOX_AD_UPLOAD_PAGE)

ipcMain.handle('web-ads:sync', () => syncWebAds())

// --- Auto-generated bar-session ads (see syncBarSessionAds above) ---

ipcMain.handle('bar-session-ads:sync-now', () => syncBarSessionAds())

// Separate from the sync above (which just reconciles the local cache) -
// this is what Settings' own managed list renders, straight from the
// source of truth rather than whatever this app last happened to
// download, so a very recent upload/delete from elsewhere shows up here
// immediately rather than waiting for the next sync pass.
ipcMain.handle('web-ads:list-remote', () => callJukeboxAdsFn({ action: 'list' }))

ipcMain.handle('web-ads:delete-remote', async (_event, passphrase, remotePath) => {
  const data = await callJukeboxAdsFn({ action: 'delete', passphrase, path: remotePath })
  // Removes the local cached copy immediately on success, and tells
  // Display right away - both rather than waiting for the next scheduled
  // sync pass to notice it's gone, since the whole point of deleting it
  // here is for it to stop showing up now, not up to
  // WEB_ADS_SYNC_INTERVAL_MS later.
  if (data.ok) {
    try { fs.rmSync(path.join(WEB_ADS_DIR, remotePath), { force: true }) } catch { /* next sync will catch it either way */ }
    if (displayWindow) {
      const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
      displayWindow.webContents.send('settings:updated', settings)
    }
  }
  return data
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

// Wipes every piece of the app's own state - playlists, queue, cached
// thumbnails/converted copies, metadata guesses, and the media folder
// selection itself - so the jukebox comes up exactly as it would on a
// fresh install. Never touches a single real video file on disk; the
// media folder is only ever read from, not written to.
ipcMain.handle('library:reset-all', () => {
  writeJson(PLAYLISTS_PATH, [])
  writeJson(QUEUE_PATH, { tracks: [], currentIndex: 0 })
  writeJson(METADATA_PATH, {})
  fs.rmSync(THUMBNAILS_DIR, { recursive: true, force: true })
  fs.rmSync(CONVERTED_DIR, { recursive: true, force: true })
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}), mediaFolder: '' }
  writeJson(SETTINGS_PATH, settings)
  stopWatchingMediaFolder()
  if (displayWindow) {
    displayWindow.webContents.send('settings:updated', settings)
    displayWindow.webContents.send('player:load-queue', { tracks: [], startIndex: 0 })
  }
  return settings
})

// Permanently deletes one real video file from the media drive - the one
// place in the app that ever does that (library:reset-all above only ever
// touches this app's own cache/settings, never a source file). Kept
// Deliberately narrow: refuses anything outside the currently configured
// media folder, so it can never be pointed at an arbitrary path.
function resolveInsideMediaFolder(filePath) {
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  const mediaFolder = settings.mediaFolder ? path.resolve(settings.mediaFolder) : ''
  const resolved = path.resolve(filePath)
  if (!mediaFolder || (resolved !== mediaFolder && !resolved.startsWith(mediaFolder + path.sep))) {
    return null
  }
  return resolved
}

// Cleans up every trace of a file that's gone (however it went) - its
// cached thumbnail/converted copy, its metadata guess, and any
// playlist/queue entry - so nothing is left dangling on a key that no
// longer resolves to a file. Shared by the manual delete and the
// automatic unplayable-file removal below, since both need identical
// bookkeeping once the actual file is gone.
function purgeDerivedState(key) {
  for (const dir of [THUMBNAILS_DIR, CONVERTED_DIR]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(key)) fs.rmSync(path.join(dir, name), { force: true })
      }
    } catch { /* cache dir may not exist yet */ }
  }

  const metadata = readJson(METADATA_PATH, {})
  delete metadata[key]
  writeJson(METADATA_PATH, metadata)

  const playlists = readJson(PLAYLISTS_PATH, []).map((p) => ({
    ...p,
    trackKeys: p.trackKeys.filter((k) => k !== key),
  }))
  writeJson(PLAYLISTS_PATH, playlists)

  const queue = readJson(QUEUE_PATH, { tracks: [], currentIndex: 0 })
  const removedBeforeCurrent = queue.tracks.slice(0, queue.currentIndex).filter((k) => k === key).length
  queue.tracks = queue.tracks.filter((k) => k !== key)
  queue.currentIndex = Math.max(0, queue.currentIndex - removedBeforeCurrent)
  writeJson(QUEUE_PATH, queue)

  return { playlists, queue }
}

ipcMain.handle('library:delete-file', (_event, key, filePath) => {
  const resolved = resolveInsideMediaFolder(filePath)
  if (!resolved) throw new Error('Refusing to delete a file outside the configured media folder.')
  fs.rmSync(resolved, { force: true })
  return purgeDerivedState(key)
})

// Used only when a file has just been confirmed unplayable - a
// conversion attempt failed outright, or "succeeded" but the result
// still can't produce a valid duration (see generateThumbAndDuration in
// control/app.js). Sam, 2026-09-12: "i dont want files hanging around
// the system if the system cant play them ... messy and embarrassing" -
// but this runs automatically with no human double-checking the
// specific file first, so it goes to the Recycle Bin rather than a
// permanent delete, in case it's ever wrong about a fixable file.
ipcMain.handle('library:trash-unplayable-file', async (_event, key, filePath) => {
  const resolved = resolveInsideMediaFolder(filePath)
  if (!resolved) throw new Error('Refusing to remove a file outside the configured media folder.')
  await shell.trashItem(resolved)
  return purgeDerivedState(key)
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

// No hard cap on file size/length - veryfast/crf 20 just takes longer
// for a bigger source. This IS capped on wall-clock time (see
// CONVERT_TIMEOUT_MS below) so a genuinely stuck ffmpeg process (a
// corrupted source, or a flaky network-share read) can't hang the
// button on "Converting…" forever with zero feedback.
const CONVERT_TIMEOUT_MS = 10 * 60 * 1000

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
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      ffmpeg.kill('SIGKILL')
      // SIGKILL doesn't release the OS file handle synchronously on
      // Windows - rmSync running right after can hit EBUSY while the
      // killed process is still tearing down. This is best-effort
      // cleanup of a temp file, not core logic, so a failure here must
      // never crash the app (it did exactly that live at the venue
      // before this fix - an uncaught EBUSY brought down the whole main
      // process). Worst case a stray .tmp.mp4 is left in CONVERTED_DIR,
      // harmless and overwritten by the next attempt at this same file.
      try { fs.rmSync(tempPath, { force: true }) } catch { /* still locked - ignore, not fatal */ }
      reject(new Error(`Conversion timed out after ${CONVERT_TIMEOUT_MS / 60000} minutes - the source may be corrupted or on a slow/unreachable network location.`))
    }, CONVERT_TIMEOUT_MS)

    ffmpeg.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    ffmpeg.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Could not start the converter: ${err.message}`))
    })
    ffmpeg.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) {
        // Renamed into place only on success - a failed/interrupted
        // conversion never leaves a half-written file at the real path
        // for a later run to mistake for a finished one. Even a clean
        // ffmpeg exit doesn't guarantee Windows has released the file
        // handle instantly (AV scanners commonly grab a newly-written
        // file for a moment) - reject with a clear message instead of
        // letting a transient EBUSY here crash the app.
        try {
          fs.renameSync(tempPath, outputPath)
          resolve(outputPath)
        } catch (err) {
          reject(new Error(`Conversion finished but the output file could not be saved: ${err.message}`))
        }
      } else {
        try { fs.rmSync(tempPath, { force: true }) } catch { /* still locked - ignore, not fatal */ }
        // Last few non-empty lines, not just the very last one - ffmpeg's
        // actual diagnostic ("Unsupported codec", "Invalid data found",
        // etc.) is often a couple of lines before its final output,
        // which was previously all that got shown.
        const lastLines = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-5).join(' | ')
        console.error(`[convert] ffmpeg failed (exit ${code}) for ${sourcePath}\n${stderrTail}`)
        reject(new Error(`Conversion failed (exit code ${code}): ${lastLines || 'no ffmpeg output captured'}`))
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

const PLAYER_COMMANDS = ['load-queue', 'update-queue', 'play', 'pause', 'toggle-play-pause', 'skip', 'previous', 'set-crossfade-duration', 'set-volume']
for (const command of PLAYER_COMMANDS) {
  ipcMain.on(`player:${command}`, (_event, payload) => {
    if (displayWindow) displayWindow.webContents.send(`player:${command}`, payload)
  })
}
ipcMain.on('player:state', (_event, state) => {
  if (controlWindow) controlWindow.webContents.send('player:state', state)
})

// Same reopen logic as the tray's "Show on TV" item, exposed as a
// regular button in Control itself - the tray's right-click menu is
// easy to never discover at all.
ipcMain.handle('display:reopen', () => {
  reopenDisplayWindow()
  return true
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

// The Display window's own close handler already turns an accidental
// close into a hide rather than a real destroy (see createDisplayWindow)
// - so normally .show() is all this needs. Recreating it from scratch
// when it genuinely is gone (a crash, or any other edge case) means
// this can never be a dead end that only a full app restart gets out of
// - Sam, 2026-09-12: "when the 2nd screen window is accidently closed
// there is no way of re-opening the tv window other than shutting down
// the system".
function reopenDisplayWindow() {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.show()
    displayWindow.focus()
  } else {
    createDisplayWindow()
  }
}

function refreshTrayMenu() {
  if (!tray) return
  const items = [
    { label: 'Open Control Panel', click: () => { controlWindow.show(); controlWindow.focus() } },
    { label: 'Show on TV', click: () => reopenDisplayWindow() },
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

// Lets Settings show live status text for "Check for Updates" - checking,
// found/not found, downloading, ready, or an error - rather than the
// button just silently doing something in the background.
function sendUpdateStatus(status) {
  if (controlWindow) controlWindow.webContents.send('update:status', status)
}

// Shown the moment a new version has actually finished downloading and
// is ready to install - a native OS dialog (not a page-level one), since
// this is a whole-app decision that can happen at any time, not just
// while looking at a particular screen. "Update Now" restarts right
// away (quitAndInstall); "Later" just dismisses - either way the update
// still installs automatically the next time the app quits regardless
// (autoInstallOnAppQuit), same as the tray's existing "Restart to
// Update" item, which stays available either way.
let updatePromptShowing = false
async function promptToInstallUpdate(version) {
  if (updatePromptShowing) return // a recheck landing mid-prompt shouldn't stack a second one
  updatePromptShowing = true
  const result = await dialog.showMessageBox(controlWindow, {
    type: 'info',
    title: 'Update available',
    message: `MSLSC Jukebox ${version} is ready to install.`,
    detail: 'Update now (the app restarts - only takes a moment), or later, when it\'ll install automatically the next time the app closes.',
    buttons: ['Update Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  })
  updatePromptShowing = false
  if (result.response === 0) autoUpdater.quitAndInstall()
}

function setupAutoUpdate() {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  if (process.env.JUKEBOX_DEBUG) autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'not-available', version: app.getVersion() }))
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true
    refreshTrayMenu()
    sendUpdateStatus({ state: 'downloaded', version: info.version })
    promptToInstallUpdate(info.version)
  })
  autoUpdater.on('error', (err) => {
    if (process.env.JUKEBOX_DEBUG) console.log('AUTO-UPDATE ERROR', err)
    sendUpdateStatus({ state: 'error', message: err.message })
  })

  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)
}

ipcMain.handle('update:check', () => {
  if (!app.isPackaged) return { state: 'dev-mode' }
  autoUpdater.checkForUpdates()
  return { state: 'checking' }
})

ipcMain.handle('app:get-version', () => app.getVersion())

// Runs a sync pass immediately, then again every
// WEB_ADS_SYNC_INTERVAL_MS for as long as the app is open. Display only
// ever re-reads the ad-image list on its own at startup or when a
// setting actually changes (see onSettingsUpdated) - reusing that same
// 'settings:updated' broadcast here (only when something actually
// changed) is what makes a fresh web upload show up in the slideshow on
// its own, without anyone touching a setting.
function startSyncingWebAds() {
  const runSync = async () => {
    const result = await syncWebAds()
    if (controlWindow) controlWindow.webContents.send('web-ads:synced', result)
    if (result.ok && (result.downloaded > 0 || result.removed > 0) && displayWindow) {
      const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
      displayWindow.webContents.send('settings:updated', settings)
    }
  }
  runSync()
  setInterval(runSync, WEB_ADS_SYNC_INTERVAL_MS)
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createControlWindow()
  createDisplayWindow()
  createTray()
  setupAutoUpdate()
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH, {}) }
  startWatchingMediaFolder(settings.mediaFolder)
  startSyncingWebAds()
  startSyncingBarSessionAds()
})

app.on('before-quit', () => {
  isQuitting = true
  stopWatchingMediaFolder()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
