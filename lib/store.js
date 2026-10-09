// Where the Jukebox keeps its own data (userData), and how it reads and
// writes it. No Electron here - main.js passes the folder in - so tests can
// point it at a temp folder.
const path = require('node:path')
const fs = require('node:fs')

const DEFAULT_SETTINGS = {
  mediaFolder: '',
  // Start with the TV window hidden (Sam, 2026-10-10) - staff bring it up
  // with "Show on TV" (Control, tray or the Remote). The Jukebox still runs
  // and plays sound while it's hidden.
  tvStartHidden: false,
  crossfadeSeconds: 3,
  volume: 1,
  // Ad slideshow between songs - off by default (the Ad Manager having
  // no ads targeted at this app either way means nothing to show even
  // if enabled).
  adsEnabled: false,
  adsEverySongs: 4,
  adsSecondsPerImage: 6,
  // Short muted bumper clip, played once after each song ends (and after
  // any ad break) before the next video starts - on by default since the
  // bundled clip needs no extra setup to work.
  introVideoEnabled: true,
}

const EMPTY_QUEUE = () => ({ tracks: [], currentIndex: 0 })

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

// Written to a temp file first and then renamed over the real one, so a
// power cut or crash mid-write can never leave a half-written file behind.
// A torn playlists.json used to read back as "no playlists" - and the next
// save would have made that permanent.
function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(value))
  try {
    fs.renameSync(tempPath, filePath)
  } catch {
    // Windows can briefly refuse the rename while something (an antivirus
    // scan, a backup tool) has the file open - fall back to a plain write.
    fs.writeFileSync(filePath, JSON.stringify(value))
    try { fs.rmSync(tempPath, { force: true }) } catch { /* harmless leftover */ }
  }
}

function createStore(userData) {
  const paths = {
    userData,
    settings: path.join(userData, 'settings.json'),
    playlists: path.join(userData, 'playlists.json'),
    queue: path.join(userData, 'queue.json'),
    metadata: path.join(userData, 'metadata.json'),
    thumbnails: path.join(userData, 'thumbnails'),
    converted: path.join(userData, 'converted'),
    // key -> {duration, error, needsConversion} as last measured by
    // Control's <video> probe (see track-info below).
    trackInfo: path.join(userData, 'track-info.json'),
    // Local cache of ads synced down from the Ad Manager (lib/web-ads.js) -
    // the sole source of ads for the slideshow - plus each ad's display
    // seconds/size, keyed on the same filename.
    webAds: path.join(userData, 'web-ads'),
    webAdsMetadata: path.join(userData, 'web-ads-metadata.json'),
  }

  const getSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(paths.settings, {}) })
  const getPlaylists = () => readJson(paths.playlists, [])
  const getQueue = () => readJson(paths.queue, EMPTY_QUEUE())
  const getMetadata = () => readJson(paths.metadata, {})

  // --- Remembered per-track info (duration / playable or not) ---
  // Control used to re-open EVERY video on every launch just to read its
  // duration - ~2,500 reads over the network share (Sam, 2026-09-25: "slow
  // and clunky"). Remembering the result means a launch only probes files
  // it has genuinely never seen. Held in memory and written on a short
  // debounce, since a first-ever scan saves one entry per file in quick
  // succession.
  let trackInfo = null
  let trackInfoWriteTimer = null
  function loadTrackInfo() {
    if (!trackInfo) trackInfo = readJson(paths.trackInfo, {})
    return trackInfo
  }
  function scheduleTrackInfoWrite() {
    if (trackInfoWriteTimer) clearTimeout(trackInfoWriteTimer)
    trackInfoWriteTimer = setTimeout(() => {
      trackInfoWriteTimer = null
      writeJson(paths.trackInfo, loadTrackInfo())
    }, 2000)
  }
  function flushTrackInfo() {
    if (!trackInfoWriteTimer) return
    clearTimeout(trackInfoWriteTimer)
    trackInfoWriteTimer = null
    writeJson(paths.trackInfo, loadTrackInfo())
  }
  function resetTrackInfo() {
    if (trackInfoWriteTimer) { clearTimeout(trackInfoWriteTimer); trackInfoWriteTimer = null }
    trackInfo = {}
    writeJson(paths.trackInfo, {})
  }

  return {
    paths,
    readJson,
    writeJson,
    getSettings,
    getPlaylists,
    getQueue,
    getMetadata,
    loadTrackInfo,
    scheduleTrackInfoWrite,
    flushTrackInfo,
    resetTrackInfo,
  }
}

module.exports = { createStore, readJson, writeJson, DEFAULT_SETTINGS, EMPTY_QUEUE }
