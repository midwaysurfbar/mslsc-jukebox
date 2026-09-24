// --- State ---
let library = []            // [{path, filename, size, mtimeMs, key, duration, thumbPath}]
let metadataCache = {}      // key -> {artist, genre, decade, confidence}
let playlists = []          // [{id, name, trackKeys: []}]
let queue = { tracks: [], currentIndex: 0 }
let settings = { mediaFolder: '', crossfadeSeconds: 3, volume: 1, adsEnabled: false, adsEverySongs: 4, adsSecondsPerImage: 6, introVideoEnabled: true }
let searchQuery = ''
let groupBy = ''
// Which group (artist/genre/decade label) the Library grid is narrowed
// to, when grouped - a quick "just show me this one" without leaving
// the tab. Cleared whenever groupBy itself changes.
let groupFilter = null

// Serializes every flow that reconciles a fresh main-process file listing
// into `library` (manual/auto rescan, delete, move-to-folder, decade-sort)
// so exactly one ever runs at a time. All of them freely read, reconcile,
// and reassign the same `library`/`playlists` state - and an explicit
// action (which itself touches the media folder) can trigger the live
// folder watch's own auto-rescan while it's still mid-flight. Letting two
// of these interleave is exactly how a just-moved/converted track can
// permanently lose its needsConversion/duration: whichever reconcile
// runs second sees a bare placeholder the other inserted moments earlier
// and mistakes it for "already known", skipping its thumbnail pass for
// good. Real, observed bug - not a theoretical one.
let libraryOpQueue = Promise.resolve()
function runLibraryOp(fn) {
  const run = libraryOpQueue.then(fn, fn)
  libraryOpQueue = run.catch(() => {})
  return run
}

// Real filenames (and this app's own userData folder - "MSLSC Jukebox")
// are full of spaces and other characters that are invalid in a bare
// file:// URL - each path segment needs percent-encoding, not the path
// as a whole (encodeURIComponent would also mangle the / or \ separators).
// A Windows path's drive letter (e.g. "C:") must stay literal in a
// file:// URL - encodeURIComponent turns ":" into "%3A", which produces
// a URL that can't resolve to any real file. Everything AFTER the
// drive letter still needs normal per-segment encoding (spaces, etc),
// same as a POSIX path.
function toFileUrl(filePath) {
  const winMatch = filePath.match(/^([A-Za-z]:)[\\/](.*)$/)
  if (winMatch) {
    const [, drive, rest] = winMatch
    const encoded = rest.split(/[\\/]/).map(encodeURIComponent).join('/')
    return `file:///${drive}/${encoded}`
  }
  return 'file://' + filePath.split('/').map(encodeURIComponent).join('/')
}

// Indexed by key, rebuilt only when `library` is reassigned (every flow
// that changes it replaces the array rather than mutating it). A plain
// library.find() here was a full scan per lookup - fine at 50 tracks, not
// at ~2,500 with the queue calling this once per row every second.
let libraryIndex = new Map()
let libraryIndexFor = null
function trackByKey(key) {
  if (libraryIndexFor !== library) {
    libraryIndex = new Map(library.map((t) => [t.key, t]))
    libraryIndexFor = library
  }
  return libraryIndex.get(key)
}
function fmtTime(seconds) {
  if (!seconds || !isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
function fmtBytes(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
}

// Electron doesn't implement window.prompt() at all (it throws "prompt()
// is not supported" - window.confirm/alert are fine, prompt specifically
// isn't), so getting a folder name from the person needs this instead of
// the browser-native dialog. Resolves the trimmed name, or null on
// Cancel/Escape/an empty submit.
function askForFolderName() {
  const modal = document.getElementById('new-folder-modal')
  const input = document.getElementById('new-folder-input')
  input.value = ''
  modal.hidden = false
  input.focus()
  return new Promise((resolve) => {
    const createBtn = document.getElementById('new-folder-create')
    const cancelBtn = document.getElementById('new-folder-cancel')
    function cleanup(value) {
      modal.hidden = true
      createBtn.removeEventListener('click', onCreate)
      cancelBtn.removeEventListener('click', onCancel)
      input.removeEventListener('keydown', onKeydown)
      resolve(value)
    }
    function onCreate() { cleanup(input.value.trim() || null) }
    function onCancel() { cleanup(null) }
    function onKeydown(e) {
      if (e.key === 'Enter') onCreate()
      if (e.key === 'Escape') onCancel()
    }
    createBtn.addEventListener('click', onCreate)
    cancelBtn.addEventListener('click', onCancel)
    input.addEventListener('keydown', onKeydown)
  })
}

// Same modal-dialog approach as askForFolderName above (window.prompt()
// isn't available at all in Electron) - pre-fills with whatever's
// already tagged (auto-looked-up or previously manual) so correcting a
// wrong guess doesn't mean retyping a right genre too. Resolves the
// trimmed {artist, genre} (genre '' is fine, artist '' is not - the
// Save button is disabled until something's typed) or null on Cancel.
function askForTags(existingMeta) {
  const modal = document.getElementById('edit-tags-modal')
  const artistInput = document.getElementById('edit-tags-artist')
  const genreInput = document.getElementById('edit-tags-genre')
  artistInput.value = (existingMeta && existingMeta.artist !== 'Unknown' && existingMeta.artist) || ''
  genreInput.value = (existingMeta && existingMeta.genre !== 'Unknown' && existingMeta.genre) || ''
  modal.hidden = false
  artistInput.focus()
  return new Promise((resolve) => {
    const saveBtn = document.getElementById('edit-tags-save')
    const cancelBtn = document.getElementById('edit-tags-cancel')
    function cleanup(value) {
      modal.hidden = true
      saveBtn.removeEventListener('click', onSave)
      cancelBtn.removeEventListener('click', onCancel)
      artistInput.removeEventListener('keydown', onKeydown)
      genreInput.removeEventListener('keydown', onKeydown)
      resolve(value)
    }
    function onSave() {
      const artist = artistInput.value.trim()
      if (!artist) { artistInput.focus(); return }
      cleanup({ artist, genre: genreInput.value.trim() || 'Unknown' })
    }
    function onCancel() { cleanup(null) }
    function onKeydown(e) {
      if (e.key === 'Enter') onSave()
      if (e.key === 'Escape') onCancel()
    }
    saveBtn.addEventListener('click', onSave)
    cancelBtn.addEventListener('click', onCancel)
    artistInput.addEventListener('keydown', onKeydown)
    genreInput.addEventListener('keydown', onKeydown)
  })
}

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
  })
})

document.getElementById('reopen-display-btn').addEventListener('click', () => jukebox.reopenDisplay())

// --- Settings ---
async function loadSettings() {
  settings = await jukebox.getSettings()
  document.getElementById('settings-folder').value = settings.mediaFolder || ''
  document.getElementById('crossfade-slider').value = settings.crossfadeSeconds
  document.getElementById('crossfade-value').textContent = settings.crossfadeSeconds
  document.getElementById('volume-slider').value = Math.round(settings.volume * 100)
  document.getElementById('volume-value').textContent = Math.round(settings.volume * 100)
  document.getElementById('library-folder-label').textContent = settings.mediaFolder
    ? `Folder: ${settings.mediaFolder}`
    : 'No media folder set — go to Settings.'

  document.getElementById('ads-enabled-toggle').checked = Boolean(settings.adsEnabled)
  document.getElementById('ads-every-slider').value = settings.adsEverySongs
  document.getElementById('ads-every-value').textContent = settings.adsEverySongs
  document.getElementById('ads-every-plural').textContent = settings.adsEverySongs === 1 ? '' : 's'
  document.getElementById('ads-seconds-slider').value = settings.adsSecondsPerImage
  document.getElementById('ads-seconds-value').textContent = settings.adsSecondsPerImage

  document.getElementById('intro-video-enabled-toggle').checked = Boolean(settings.introVideoEnabled)
}

document.getElementById('choose-folder-btn').addEventListener('click', async () => {
  const folder = await jukebox.chooseMediaFolder()
  if (folder) { await loadSettings(); await runLibraryOp(rescanLibrary) }
})

document.getElementById('ads-enabled-toggle').addEventListener('change', async (e) => {
  settings.adsEnabled = e.target.checked
  await jukebox.saveSettings(settings)
})
document.getElementById('ads-every-slider').addEventListener('input', async (e) => {
  const n = Number(e.target.value)
  document.getElementById('ads-every-value').textContent = n
  document.getElementById('ads-every-plural').textContent = n === 1 ? '' : 's'
  settings.adsEverySongs = n
  await jukebox.saveSettings(settings)
})
document.getElementById('ads-seconds-slider').addEventListener('input', async (e) => {
  const n = Number(e.target.value)
  document.getElementById('ads-seconds-value').textContent = n
  settings.adsSecondsPerImage = n
  await jukebox.saveSettings(settings)
})

document.getElementById('intro-video-enabled-toggle').addEventListener('change', async (e) => {
  settings.introVideoEnabled = e.target.checked
  await jukebox.saveSettings(settings)
})

document.getElementById('crossfade-slider').addEventListener('input', async (e) => {
  const seconds = Number(e.target.value)
  document.getElementById('crossfade-value').textContent = seconds
  settings.crossfadeSeconds = seconds
  await jukebox.saveSettings(settings)
  jukebox.playerSetCrossfadeDuration(seconds)
})
document.getElementById('volume-slider').addEventListener('input', async (e) => {
  const pct = Number(e.target.value)
  document.getElementById('volume-value').textContent = pct
  settings.volume = pct / 100
  await jukebox.saveSettings(settings)
  jukebox.playerSetVolume(settings.volume)
})

// --- Library: scan, thumbnails/duration, render ---

// The path actually handed to <video>/Display for playback - the
// converted copy once one exists, otherwise the original file as
// downloaded. Everything that plays or previews a track should go
// through this rather than reading track.path directly.
function playablePath(track) {
  return track.convertedPath || track.path
}

async function generateThumbAndDuration(track) {
  const convertedPath = await jukebox.getConvertedPath(track.key)
  if (convertedPath) track.convertedPath = convertedPath

  const existingThumb = await jukebox.getThumbnailPath(track.key)
  return new Promise((resolve) => {
    let settled = false
    let metadataLoaded = false
    // True once Chromium gave a real answer (metadata or a decode error).
    // Only then is the result remembered for next launch - a timeout is
    // usually a slow network read, not a verdict on the file, so that one
    // gets probed again next time rather than being stuck as "broken".
    let measured = false
    const video = document.createElement('video')

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      video.remove()
      if (measured) {
        track.infoCached = true
        jukebox.saveTrackInfo(track.key, { duration: track.duration, error: track.error, needsConversion: track.needsConversion })
      }
      resolve()
    }

    // Some files never cleanly fire EITHER loadedmetadata or error - a
    // truncated/corrupt file, an exotic codec Chromium can partially
    // probe but not finish, or (this app's real deployment: a network
    // share) a slow/flaky read that just never completes. Without a hard
    // timeout, one such file hangs its entire batch of 4 forever (the
    // BATCH loop in rescanLibrary uses Promise.all), silently starving
    // every track queued behind it - which is exactly the reported bug:
    // "Convert Unsupported" only ever sees library.filter(needsConversion),
    // and a track stuck behind a hung one never gets that flag set at
    // all, so it's not skipped so much as never even checked. If metadata
    // already loaded successfully and only the thumbnail-capture step is
    // stuck, this only gives up on the thumbnail - it doesn't wrongly
    // re-flag a perfectly playable file as needing conversion.
    const timeoutId = setTimeout(() => {
      if (!metadataLoaded) {
        track.duration = 0
        track.error = true
        track.needsConversion = !track.convertedPath
      }
      finish()
    }, 20000)

    video.preload = 'metadata'
    video.muted = true
    video.src = toFileUrl(playablePath(track))
    video.addEventListener('loadedmetadata', () => {
      metadataLoaded = true
      measured = true
      // loadedmetadata firing only means Chromium could read the
      // container's headers, not that the duration in them is real - a
      // malformed/missing moov atom (or similar) can report 0, NaN, or
      // Infinity here despite otherwise looking "loaded fine", which
      // used to sail through as a false success and just show "0:00" in
      // the library with no indication anything was wrong. Treated the
      // same as a hard decode error now - re-encoding through Convert
      // often fixes a bad duration atom, so it's still worth offering
      // that first rather than only concluding this file is unplayable.
      const validDuration = Number.isFinite(video.duration) && video.duration > 0
      track.duration = validDuration ? video.duration : 0
      track.error = !validDuration
      track.needsConversion = !validDuration && !track.convertedPath
      if (!validDuration) { finish(); return }
      if (existingThumb) { track.thumbPath = existingThumb; finish(); return }
      video.currentTime = Math.min(3, video.duration / 2 || 0)
    })
    video.addEventListener('seeked', async () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 320; canvas.height = 180
        canvas.getContext('2d').drawImage(video, 0, 0, 320, 180)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
        // Awaited deliberately - rescanLibrary() re-renders the grid right
        // after this track's promise resolves, so thumbPath has to be set
        // on the track object before resolve() fires, not sometime after.
        track.thumbPath = await jukebox.saveThumbnail(track.key, dataUrl)
      } catch { /* thumbnail is a nice-to-have, never block on it */ }
      finish()
    })
    video.addEventListener('error', () => {
      measured = true
      track.duration = 0
      track.error = true
      // Only offer conversion for the original file failing - if the
      // ALREADY-CONVERTED copy somehow fails too, converting it again
      // won't help, so don't offer to retry forever.
      track.needsConversion = !track.convertedPath
      finish()
    })
  })
}

// A track only needs opening in a <video> if it's never been measured, or
// it's playable but somehow still has no thumbnail.
function needsProbe(track) {
  return !track.infoCached || (!track.thumbPath && !track.error)
}

async function rescanLibrary() {
  document.getElementById('library-status').textContent = 'Scanning…'
  const { files, prunedCount, playlists: syncedPlaylists } = await jukebox.listVideos()
  metadataCache = await jukebox.getMetadataCache()
  // Reconciling by key (rather than wholesale replacing `library`) means
  // a track that hasn't actually changed keeps its already-generated
  // thumbnail/duration, and only genuinely new files do the <video>+
  // <canvas> thumbnail pass below - important now that a rescan can also
  // fire automatically from the live folder watch (see main.onMediaFolderChanged
  // below), not just a manual click, so it needs to stay cheap even when
  // it runs often on an otherwise-unchanged library.
  const newOnes = reconcileLibrary(files)
  // Folder-based playlists (see syncFolderPlaylists in main.js) are
  // recalculated on every scan - a file already sitting in a subfolder
  // gets swept into that playlist right here, not just newly-added ones.
  playlists = syncedPlaylists
  // A rescan also clears out any cached thumbnail/converted-video file
  // that no longer matches a real video (see pruneOrphanedCacheFiles in
  // main.js) - worth a mention when it actually does something, since
  // that's exactly the "shows as unconverted even though it's already
  // been converted" symptom fixing itself.
  document.getElementById('library-status').textContent = !files.length
    ? 'No video files found in the media folder.'
    : prunedCount
      ? `Cleaned up ${prunedCount} stale cache file${prunedCount === 1 ? '' : 's'} from earlier scans.`
      : ''
  renderLibrary()
  renderPlaylists()
  // Only files never measured before (main hands back what it remembers -
  // see track-info in main.js), or a playable one still missing its
  // thumbnail, actually get opened. Everything else is ready as-is.
  const toProbe = newOnes.filter(needsProbe)
  // Thumbnails/duration are generated a few at a time, not all at once,
  // so a big batch of new files doesn't freeze the UI. The grid is
  // redrawn at most about once a second while this runs, not after every
  // batch - on a first-ever scan of ~2,500 files that was ~600 full
  // redraws back to back.
  const BATCH = 4
  let lastRender = Date.now()
  for (let i = 0; i < toProbe.length; i += BATCH) {
    document.getElementById('library-status').textContent = `Reading new videos ${Math.min(i + BATCH, toProbe.length)}/${toProbe.length}…`
    await Promise.all(toProbe.slice(i, i + BATCH).map(generateThumbAndDuration))
    if (Date.now() - lastRender > 1000) { renderLibrary(); lastRender = Date.now() }
  }
  if (toProbe.length) {
    document.getElementById('library-status').textContent = ''
    renderLibrary()
  }
}

document.getElementById('rescan-btn').addEventListener('click', () => runLibraryOp(rescanLibrary))

// The live folder watch (main.js) tells us whenever something changes
// under the media folder - a new folder, added/removed/moved files, all
// of it - so a rescan can happen on its own, without anyone needing to
// click Rescan Folder or restart the app. Goes through the same
// runLibraryOp queue as every other library-mutating flow, since this
// can otherwise fire while an explicit action (which also touches the
// media folder) is still mid-flight.
// At most one of these waits in the queue at a time - a long job that
// touches the media folder file after file (Tidy Up Converted Videos)
// would otherwise stack up one rescan per file behind it.
let folderRescanQueued = false
jukebox.onMediaFolderChanged(() => {
  if (folderRescanQueued) return
  folderRescanQueued = true
  runLibraryOp(() => { folderRescanQueued = false; return rescanLibrary() })
})

// Reconciles a fresh main-process file listing (from a move/sort action,
// not a full Rescan) with the client's existing `library` array, which
// carries client-only UI state - duration, thumbPath, convertedPath,
// error/needsConversion - that main never knows about. A track whose key
// didn't change keeps all of that state untouched; anything with a
// brand-new key just got moved/renamed, so its identity changed - those
// come back from this function so the caller can regenerate just their
// thumbnail/duration, rather than either leaving them blank forever or
// wastefully re-processing the whole library.
function reconcileLibrary(freshFiles) {
  const byKey = new Map(library.map((t) => [t.key, t]))
  library = freshFiles.map((f) => byKey.get(f.key) || f)
  return library.filter((t) => !byKey.has(t.key))
}

document.getElementById('enrich-btn').addEventListener('click', async () => {
  const status = document.getElementById('library-status')
  for (let i = 0; i < library.length; i++) {
    const track = library[i]
    status.textContent = `Enriching ${i + 1}/${library.length}…`
    metadataCache[track.key] = await jukebox.lookupMetadata(track.key, track.filename)
  }
  status.textContent = ''
  renderLibrary()
})

// Physically sorts whatever's still loose in the media folder's root into
// decade subfolders (1980s, 1990s, ...) based on the same iTunes lookup
// "Enrich Library" already uses - files already sitting in any folder are
// never touched. Enriches first (in this renderer, same as Enrich Library)
// so the move step in main has real metadata to decide from, rather than
// treating an un-enriched track as "no confident match, leave it".
document.getElementById('sort-decade-btn').addEventListener('click', () => runLibraryOp(async () => {
  const status = document.getElementById('library-status')
  const unsorted = library.filter((t) => !t.folder)
  if (!unsorted.length) { status.textContent = 'Nothing to sort - every file is already in a folder.'; return }

  const sure = confirm(
    `This physically moves files into folders like "1980s"/"1990s" based on a best-guess lookup - it does not just organize the library view.\n\n` +
    `Only files not already in ANY folder are considered (${unsorted.length} of ${library.length}), and only a confident match is moved - ` +
    `anything uncertain is left exactly where it is.\n\n` +
    'Moved files cannot be automatically put back - continue?'
  )
  if (!sure) return

  for (let i = 0; i < unsorted.length; i++) {
    const track = unsorted[i]
    if (metadataCache[track.key]) continue
    status.textContent = `Checking ${i + 1}/${unsorted.length} for a decade match…`
    metadataCache[track.key] = await jukebox.lookupMetadata(track.key, track.filename)
  }

  status.textContent = 'Moving matched files…'
  const result = await jukebox.sortUnsortedByDecade()
  const newOnes = reconcileLibrary(result.files)
  playlists = result.playlists
  queue = result.queue
  status.textContent = result.moved
    ? `Moved ${result.moved} file${result.moved === 1 ? '' : 's'} into decade folders. ${result.skipped} had no confident match and were left in place.`
    : `No confident decade matches among the ${result.skipped} unsorted file${result.skipped === 1 ? '' : 's'} - nothing moved.`
  renderLibrary()
  renderPlaylists()
  renderQueue()
  // Only the moved tracks actually need a fresh thumbnail/duration pass -
  // everything else already has one and reconcileLibrary preserved it.
  const toProbe = newOnes.filter(needsProbe)
  for (const track of toProbe) await generateThumbAndDuration(track)
  if (toProbe.length) renderLibrary()
}))

// Waits for a short pause in typing before redrawing, rather than
// redrawing the whole grid on every single keystroke.
let searchDebounce = null
document.getElementById('library-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce)
  const value = e.target.value.toLowerCase()
  searchDebounce = setTimeout(() => { searchQuery = value; renderLibrary({ reset: true }) }, 200)
})
document.getElementById('library-group-by').addEventListener('change', (e) => { groupBy = e.target.value; groupFilter = null; renderLibrary({ reset: true }) })

// One picker, two different things happening underneath depending on
// what's chosen - a manual playlist just gets the track key appended
// (playlists.json), but a folder-synced one can only ever be "joined" by
// actually moving the file into its folder (folders are the source of
// truth for those, everywhere else in the app too) - same for the
// "New folder…" option, which creates one on the spot. moveTrackToFolder
// handles both of the folder cases; addTrackToPlaylist the manual one.
function playlistPickerHtml(track) {
  // Built once per renderLibrary() pass (see buildPickerContext below),
  // not once per tile - with ~2,500 tiles and ~170 playlists, redoing
  // these lookups per tile was a big part of every redraw.
  const ctx = pickerContext

  // Which option (if any) reflects where this track already lives -
  // shown as the picker's own current selection instead of always
  // resetting to "+ Playlist", so e.g. Sort Unsorted by Decade actually
  // moving a track into "1980s" shows "1980s" here afterwards, and a
  // still-unsorted one keeps showing "+ Playlist" - Sam, 2026-09-17:
  // wants to be able to tell which files haven't been sorted yet just by
  // scanning this column. Checked in this order because a track only
  // ever has one folder and one artist tag, but could sit in several
  // manual playlists at once - a single dropdown can only show one of
  // those as "current", so manual is last and just takes whichever
  // matches first.
  const meta = metadataCache[track.key]
  const folderMatch = track.folder && ctx.folderByPath.get(track.folder)
  const artistMatch = meta && ctx.artistByValue.get(meta.artist)
  const manualMatch = ctx.manualByTrack.get(track.key)
  let currentValue = ''
  let currentLabel = '+ Playlist'
  if (folderMatch) { currentValue = `folder:${folderMatch.folderPath}`; currentLabel = `📁 ${folderMatch.name}` }
  else if (artistMatch) { currentValue = `artist:${artistMatch.artistValue}`; currentLabel = `🎤 ${artistMatch.name}` }
  else if (manualMatch) { currentValue = `playlist:${manualMatch.id}`; currentLabel = manualMatch.name }

  // Only the current selection is rendered up front - the full list of
  // every playlist is filled in the moment the picker is clicked or
  // focused (fillPicker below). Rendering all ~170 options into every
  // one of ~2,500 tiles was ~430,000 <option>s on one page.
  return `
    <select data-track-picker="${track.key}" data-current="${currentValue}">
      <option value="${currentValue}" selected>${currentLabel}</option>
    </select>`
}

function buildPickerContext() {
  const manualPlaylists = playlists.filter((p) => !p.autoFolder && !p.autoArtist)
  const folderPlaylists = playlists.filter((p) => p.autoFolder)
  const artistPlaylists = playlists.filter((p) => p.autoArtist)
  const manualByTrack = new Map()
  for (const p of manualPlaylists) {
    for (const key of p.trackKeys) if (!manualByTrack.has(key)) manualByTrack.set(key, p)
  }
  const option = (value, label) => `<option value="${value}">${label}</option>`
  // "Joining" an existing artist playlist here is just a quicker way to
  // tag this track as that same artist (setManualMetadata under the
  // hood, same as the 🏷 Tag button) - no retyping a band name that's
  // already on record for another video.
  const optionsHtml =
    option('', '+ Playlist') +
    manualPlaylists.map((p) => option(`playlist:${p.id}`, p.name)).join('') +
    folderPlaylists.map((p) => option(`folder:${p.folderPath}`, `📁 ${p.name}`)).join('') +
    artistPlaylists.map((p) => option(`artist:${p.artistValue}`, `🎤 ${p.name}`)).join('') +
    option('new-folder', '📁 New folder…')
  return {
    folderByPath: new Map(folderPlaylists.map((p) => [p.folderPath, p])),
    artistByValue: new Map(artistPlaylists.map((p) => [p.artistValue, p])),
    manualByTrack,
    optionsHtml,
  }
}
let pickerContext = buildPickerContext()

function fillPicker(select) {
  if (select.dataset.filled) return
  select.dataset.filled = '1'
  select.innerHTML = pickerContext.optionsHtml
  select.value = select.dataset.current
}

function renderTrackTile(track) {
  const meta = metadataCache[track.key]
  const thumbStyle = track.thumbPath ? `background-image:url('${toFileUrl(track.thumbPath)}')` : ''
  const thumbLabel = track.converting ? '⏳ Converting…' : track.thumbPath ? '' : (track.needsConversion ? '⚠ Needs conversion' : (track.error ? '⚠ Unsupported' : '🎬'))
  return `
    <div class="track-tile">
      <div class="track-thumb" style="${thumbStyle}">${thumbLabel}</div>
      <div class="track-info">
        <strong title="${track.filename}">${track.filename}</strong>
        <div class="track-meta">${fmtTime(track.duration)} · ${fmtBytes(track.size)}${meta && meta.artist !== 'Unknown' ? ` · ${meta.artist}` : ''}${track.convertedPath ? ' · converted' : ''}</div>
      </div>
      <div class="track-actions">
        ${track.needsConversion
          ? `<button class="primary" data-convert="${track.key}" ${track.converting ? 'disabled' : ''}>${track.converting ? 'Converting…' : 'Convert'}</button>`
          : `<button class="secondary" data-play-now="${track.key}">▶ Play</button><button class="secondary" data-add-queue="${track.key}">+ Queue</button>`}
      </div>
      <div class="track-actions">
        ${playlistPickerHtml(track)}
        <button class="secondary" data-edit-tags="${track.key}" title="Tag the band/singer (and genre) - doesn't move or rename the file">🏷 Tag</button>
      </div>
      <div class="track-actions">
        <button class="danger" data-delete-file="${track.key}" title="Permanently delete this file from the drive">🗑 Delete</button>
      </div>
    </div>`
}

// The grid is drawn a page at a time - the first LIBRARY_PAGE entries
// straight away, then another page each time the bottom comes into view.
// Drawing all ~2,500 tiles in one go (and again on every search
// keystroke, tag, or move) is what made the Library feel slow.
const LIBRARY_PAGE = 120
let libraryEntries = []      // [{html: () => string}] - headers and tiles, in display order
let libraryShown = 0
const libraryGrid = document.getElementById('library-grid')
const librarySentinel = document.createElement('div')
librarySentinel.className = 'library-sentinel'
const librarySentinelObserver = new IntersectionObserver((observed) => {
  if (observed.some((o) => o.isIntersecting)) showMoreLibrary()
}, { rootMargin: '600px' })

function showMoreLibrary() {
  if (libraryShown >= libraryEntries.length) return
  const next = libraryEntries.slice(libraryShown, libraryShown + LIBRARY_PAGE)
  libraryShown += next.length
  librarySentinel.remove()
  libraryGrid.insertAdjacentHTML('beforeend', next.map((e) => e.html()).join(''))
  if (libraryShown < libraryEntries.length) libraryGrid.appendChild(librarySentinel)
}

// The observer only fires when the bottom marker *changes* between off-
// and on-screen - if a freshly added page is short enough that the marker
// is still in view, nothing new would fire. This tops up in that case.
// Skipped while the Library tab is hidden (every size reads as 0 then,
// which would otherwise look like "in view" and load everything).
function topUpLibrary() {
  requestAnimationFrame(() => {
    if (!librarySentinel.isConnected || libraryGrid.offsetParent === null) return
    if (librarySentinel.getBoundingClientRect().top < window.innerHeight + 600) {
      showMoreLibrary()
      topUpLibrary()
    }
  })
}

// `reset` (a new search, grouping, or group filter) starts back at the
// first page. Anything else - a tag, a move, a thumbnail landing - keeps
// however many tiles were already showing, so the list doesn't jump
// back to the top under whoever's scrolling it.
function renderLibrary({ reset = false } = {}) {
  const keepShown = reset ? 0 : libraryShown
  pickerContext = buildPickerContext()
  let items = searchQuery ? library.filter((t) => t.filename.toLowerCase().includes(searchQuery)) : library
  const entries = []
  const tile = (track) => ({ html: () => renderTrackTile(track) })

  if (groupBy) {
    const groups = new Map()
    for (const track of items) {
      const meta = metadataCache[track.key]
      const label = (meta && meta[groupBy] && meta[groupBy] !== 'Unknown') ? meta[groupBy] : 'Unknown'
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(track)
    }
    // A group that's disappeared since (its last track got re-tagged,
    // deleted, or the search box now excludes it) can't stay "selected".
    if (groupFilter && !groups.has(groupFilter)) groupFilter = null

    if (groupFilter) {
      entries.push({ html: () => `<button class="secondary" data-clear-group-filter>← Show every ${groupBy}</button>` })
      entries.push({ html: () => `<div class="library-group">${groupFilter}</div>` })
      entries.push(...groups.get(groupFilter).map(tile))
    } else {
      const sortedLabels = [...groups.keys()].sort((a, b) => (a === 'Unknown' ? 1 : b === 'Unknown' ? -1 : a.localeCompare(b)))
      // Clicking a group header narrows the grid to just that group - the
      // whole point of tagging a video (Sam, 2026-09-13: "sort the music
      // videos by that") is being able to jump straight to one band's
      // videos, not just see them clustered on an otherwise-long page.
      for (const label of sortedLabels) {
        const count = groups.get(label).length
        entries.push({ html: () => `<div class="library-group" data-group-filter="${label}" title="Show only ${label}">${label} <span class="group-count">${count}</span></div>` })
        entries.push(...groups.get(label).map(tile))
      }
    }
  } else {
    items = [...items].sort((a, b) => a.filename.localeCompare(b.filename))
    entries.push(...items.map(tile))
  }

  libraryEntries = entries
  libraryShown = 0
  librarySentinel.remove()
  libraryGrid.innerHTML = ''
  const firstBatch = Math.max(LIBRARY_PAGE, keepShown)
  libraryShown = Math.min(firstBatch, entries.length)
  libraryGrid.innerHTML = entries.slice(0, libraryShown).map((e) => e.html()).join('')
  if (libraryShown < entries.length) libraryGrid.appendChild(librarySentinel)
  topUpLibrary()
}

librarySentinelObserver.observe(librarySentinel)

// One set of listeners on the grid itself, instead of ~7 per tile
// re-attached on every redraw.
libraryGrid.addEventListener('click', (e) => {
  const el = e.target.closest('[data-play-now],[data-add-queue],[data-convert],[data-delete-file],[data-edit-tags],[data-group-filter],[data-clear-group-filter]')
  if (!el || !libraryGrid.contains(el)) return
  if (el.dataset.playNow) playNow(el.dataset.playNow)
  else if (el.dataset.addQueue) addToQueue(el.dataset.addQueue)
  else if (el.dataset.convert) convertTrack(el.dataset.convert)
  else if (el.dataset.deleteFile) runLibraryOp(() => deleteFile(el.dataset.deleteFile))
  else if (el.dataset.editTags) editTags(el.dataset.editTags)
  else if (el.dataset.groupFilter !== undefined) { groupFilter = el.dataset.groupFilter; renderLibrary({ reset: true }) }
  else if (el.hasAttribute('data-clear-group-filter')) { groupFilter = null; renderLibrary({ reset: true }) }
})
for (const type of ['mousedown', 'focusin']) {
  libraryGrid.addEventListener(type, (e) => {
    const select = e.target.closest('[data-track-picker]')
    if (select) fillPicker(select)
  })
}
libraryGrid.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-track-picker]')
  if (!el) return
  const trackKey = el.dataset.trackPicker
  const value = el.value
  el.value = el.dataset.current
  if (!value || value === el.dataset.current) return
  if (value.startsWith('playlist:')) moveTrackToManualPlaylist(trackKey, value.slice('playlist:'.length))
  else if (value.startsWith('folder:')) runLibraryOp(() => moveTrackToFolder(trackKey, value.slice('folder:'.length)))
  else if (value.startsWith('artist:')) assignArtist(trackKey, value.slice('artist:'.length))
  else if (value === 'new-folder') {
    const name = await askForFolderName()
    if (name) runLibraryOp(() => moveTrackToFolder(trackKey, name))
  }
})

// Shared by both deleteFile (manual) and convertTrack's auto-remove
// path below - keeps local state from ever drifting from what main
// actually did to playlists.json/queue.json, using exactly what it
// returned rather than re-deriving it here.
function removeTrackFromState(key, result) {
  playlists = result.playlists
  queue = result.queue
  library = library.filter((t) => t.key !== key)
  delete metadataCache[key]
  renderLibrary()
  renderPlaylists()
  renderQueue()
  jukebox.playerUpdateQueue(queue.tracks.map(trackByKey).filter(Boolean).map(toDisplayTrack))
}

// Permanently removes one file from the actual media drive - not just
// this library list. Confirms first since, unlike Reset Library, this
// really can't be undone (no re-scan brings it back).
async function deleteFile(key) {
  const track = trackByKey(key)
  if (!track) return
  const sure = confirm(
    `Permanently delete "${track.filename}" from the drive?\n\n` +
    'This deletes the actual video file, not just this library entry, and cannot be undone. ' +
    'It will also be removed from any playlists and the queue.'
  )
  if (!sure) return

  try {
    const result = await jukebox.deleteFile(key, track.path)
    removeTrackFromState(key, result)
    document.getElementById('library-status').textContent = `Deleted "${track.filename}" from the drive.`
  } catch (err) {
    document.getElementById('library-status').textContent = `Could not delete "${track.filename}": ${err.message}`
  }
}

// Tags a track's band/singer (and optionally genre) without moving or
// renaming the file - Sam, 2026-09-13: "have a band/singer tab/playlist
// and sort music videos by that ... not move the videos but tag them."
// A confident tag (this always counts as one, being manual) immediately
// gets its own auto-synced playlist in Playlists (see syncArtistPlaylists
// in main.js) - main returns the freshly-resynced list so it shows up
// there right away, not just after the next rescan.
async function editTags(key) {
  const track = trackByKey(key)
  if (!track) return
  const tags = await askForTags(metadataCache[key])
  if (!tags) return
  const decade = (metadataCache[key] && metadataCache[key].decade) || 'Unknown'
  const result = await jukebox.setManualMetadata(key, { artist: tags.artist, genre: tags.genre, decade })
  metadataCache[key] = result.entry
  playlists = result.playlists
  document.getElementById('library-status').textContent = `Tagged "${track.filename}" as ${tags.artist}.`
  renderLibrary()
  renderPlaylists()
}

// "Joining" an existing artist playlist straight from the picker
// (playlistPickerHtml above) - same tagging call as editTags, just with
// the artist already known so there's nothing to type. Genre/decade
// carry over unchanged if this track already had any.
async function assignArtist(key, artistValue) {
  const track = trackByKey(key)
  if (!track) return
  const existing = metadataCache[key]
  const result = await jukebox.setManualMetadata(key, {
    artist: artistValue,
    genre: (existing && existing.genre) || 'Unknown',
    decade: (existing && existing.decade) || 'Unknown',
  })
  metadataCache[key] = result.entry
  playlists = result.playlists
  document.getElementById('library-status').textContent = `Tagged "${track.filename}" as ${artistValue}.`
  renderLibrary()
  renderPlaylists()
}

// Moves one file into an existing folder-playlist's folder, or a brand
// new one - the only way to "add" a track to one of these, since their
// membership always comes from where the file actually is. reconcileLibrary
// preserves every other track's thumbnail/duration; only this one track
// (new key, since its path changed) gets its thumbnail regenerated - cheap,
// since remapFileKey already carried its cached thumbnail/converted copy
// over to the new key, so generateThumbAndDuration finds them immediately.
async function moveTrackToFolder(key, folderPath) {
  const track = trackByKey(key)
  if (!track) return
  const sure = confirm(
    `Move "${track.filename}" into the "${folderPath}" folder on the drive?\n\n` +
    'This physically relocates the file - that\'s what makes it join that playlist.'
  )
  if (!sure) return

  try {
    const result = await jukebox.moveFileToFolder(track.path, folderPath)
    const newOnes = reconcileLibrary(result.files)
    playlists = result.playlists
    queue = result.queue
    metadataCache = await jukebox.getMetadataCache()
    document.getElementById('library-status').textContent = `Moved "${track.filename}" into "${folderPath}".`
    renderLibrary()
    renderPlaylists()
    renderQueue()
    const toProbe = newOnes.filter(needsProbe)
    for (const t of toProbe) await generateThumbAndDuration(t)
    if (toProbe.length) renderLibrary()
  } catch (err) {
    document.getElementById('library-status').textContent = `Could not move "${track.filename}": ${err.message}`
  }
}

// Re-encodes one track to plain H.264/AAC MP4 via the bundled ffmpeg,
// then re-runs the same duration/thumbnail pass a freshly-scanned file
// gets - generateThumbAndDuration already prefers a converted copy the
// moment one exists, so this is the only place that needs to know
// conversion happened at all.
//
// A file that still can't be played after this - ffmpeg itself failed,
// or it "succeeded" but the result still reports an invalid duration
// (see the loadedmetadata handler above) - is automatically sent to the
// Recycle Bin rather than left sitting in the library looking broken
// (Sam, 2026-09-12: "i dont want files hanging around the system if the
// system cant play them ... messy and embarrassing"). Recycle Bin, not
// a permanent delete, since this runs with no human double-checking the
// specific file first - a false positive should still be recoverable.
//
// Returns 'ok', 'removed', or 'failed' (removal itself also failed) so
// a caller converting several tracks in a row (see convert-all-btn
// below) can build an accurate summary instead of only ever seeing the
// last thing written to library-status.
async function convertTrack(key) {
  const track = trackByKey(key)
  if (!track || track.converting) return 'ok'
  track.converting = true
  renderLibrary()
  let failureReason = ''
  try {
    track.convertedPath = await jukebox.convertFile(key, track.path)
    track.needsConversion = false
  } catch (err) {
    failureReason = err.message
  }
  track.converting = false
  await generateThumbAndDuration(track)

  const stillBroken = Boolean(failureReason) || track.error
  if (!stillBroken) {
    renderLibrary()
    await runLibraryOp(() => replaceOriginalWithConverted(key))
    return 'ok'
  }

  const reason = failureReason || 'the converted file still could not be played correctly'
  try {
    const result = await jukebox.trashUnplayableFile(key, track.path)
    removeTrackFromState(key, result)
    document.getElementById('library-status').textContent = `Removed "${track.filename}" (sent to Recycle Bin) - could not be made playable: ${reason}`
    return 'removed'
  } catch (removeErr) {
    document.getElementById('library-status').textContent = `Could not convert "${track.filename}": ${reason}. Also failed to remove it: ${removeErr.message}`
    renderLibrary()
    return 'failed'
  }
}

// Puts a converted copy in the original's place on the media drive and
// sends the original to the Recycle Bin (see convert:replace-original in
// main.js - it checks both are the same length first, and does nothing at
// all on a network folder). The file's key changes with it, so this
// re-syncs everything that referenced the old one, including whatever
// Display already has queued up, since the old converted path it was
// given no longer exists. Returns 'replaced', 'kept' or 'failed'.
async function replaceOriginalWithConverted(key) {
  const track = trackByKey(key)
  if (!track || !track.convertedPath) return 'kept'
  let result
  try {
    result = await jukebox.replaceOriginal(key, track.path)
  } catch (err) {
    document.getElementById('library-status').textContent = `Converted "${track.filename}" but kept the original: ${err.message}`
    return 'failed'
  }
  if (!result.replaced) return 'kept'
  const newOnes = reconcileLibrary(result.files)
  playlists = result.playlists
  queue = result.queue
  metadataCache = await jukebox.getMetadataCache()
  renderLibrary()
  renderPlaylists()
  renderQueue()
  jukebox.playerUpdateQueue(queue.tracks.map(trackByKey).filter(Boolean).map(toDisplayTrack))
  for (const t of newOnes.filter(needsProbe)) await generateThumbAndDuration(t)
  return 'replaced'
}

document.getElementById('replace-originals-btn').addEventListener('click', () => runLibraryOp(async () => {
  const status = document.getElementById('replace-originals-status')
  if (!(await jukebox.canReplaceOriginals())) {
    status.textContent = 'Only available once the videos are on this PC\'s own drive - the media folder is currently a network folder.'
    return
  }
  const toReplace = library.filter((t) => t.convertedPath).map((t) => t.key)
  if (!toReplace.length) { status.textContent = 'Nothing to tidy up - every video already has just one copy.'; return }
  const sure = confirm(
    `${toReplace.length} converted video${toReplace.length === 1 ? '' : 's'} still have two copies.\n\n` +
    'Each converted copy will be moved onto the media drive in place of its original, and the original sent to the Recycle Bin. ' +
    'Playlists, tags and the queue carry over. Anything that doesn\'t check out is left exactly as it is.\n\n' +
    'This can take a while - best done while the bar is closed. Continue?'
  )
  if (!sure) return
  let replaced = 0
  let kept = 0
  for (let i = 0; i < toReplace.length; i++) {
    status.textContent = `Tidying up ${i + 1}/${toReplace.length}…`
    const outcome = await replaceOriginalWithConverted(toReplace[i])
    if (outcome === 'replaced') replaced += 1
    else kept += 1
  }
  status.textContent = `Done - ${replaced} video${replaced === 1 ? '' : 's'} now have one copy.` +
    (kept ? ` ${kept} kept both copies (lengths didn't match, or the original couldn't be moved) - see the Library status line for the last one.` : '')
}))

document.getElementById('convert-all-btn').addEventListener('click', async () => {
  const status = document.getElementById('library-status')
  const toConvert = library.filter((t) => t.needsConversion && !t.converting)
  const removed = []
  const failed = []
  for (let i = 0; i < toConvert.length; i++) {
    status.textContent = `Converting ${i + 1}/${toConvert.length}: "${toConvert[i].filename}"…`
    const outcome = await convertTrack(toConvert[i].key)
    if (outcome === 'removed') removed.push(toConvert[i].filename)
    else if (outcome === 'failed') failed.push(toConvert[i].filename)
  }
  // Previously this always blanked the status line at the end (or the
  // next file's "Converting…" line stomped it mid-loop), so a failure
  // was shown for a fraction of a second and then erased - the button
  // looked like it ran with no visible sign anything had gone wrong,
  // even though the file was left flagged "Needs conversion". Now a
  // summary of what actually happened stays on screen.
  if (!toConvert.length) {
    status.textContent = 'Nothing needs converting right now.'
  } else {
    const okCount = toConvert.length - removed.length - failed.length
    const parts = [`Converted ${okCount} of ${toConvert.length}`]
    if (removed.length) parts.push(`${removed.length} removed as unplayable: ${removed.join(', ')}`)
    if (failed.length) parts.push(`${failed.length} still failing: ${failed.join(', ')}`)
    status.textContent = `${parts.join(' - ')}.`
  }
})

// --- Queue ---

async function saveAndSyncQueue() {
  await jukebox.saveQueue(queue)
  renderQueue()
}

// Display only ever needs a path to play - handing it the converted
// copy's path (when one exists) under the same track shape means it
// never has to know conversion is a thing at all.
function toDisplayTrack(track) {
  return { ...track, path: playablePath(track) }
}

async function playNow(key) {
  queue = { tracks: [key], currentIndex: 0 }
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: [toDisplayTrack(trackByKey(key))], startIndex: 0 })
}

async function addToQueue(key) {
  queue.tracks.push(key)
  await saveAndSyncQueue()
}

// Whole library, shuffled - excludes anything still needing conversion,
// same rule the individual track tiles already follow (no +Queue button
// shows for those either, since Display can't actually play them yet).
document.getElementById('add-all-queue-btn').addEventListener('click', async () => {
  const keys = library.filter((t) => !t.needsConversion).map((t) => t.key)
  if (!keys.length) return
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  queue.tracks.push(...keys)
  await saveAndSyncQueue()
})

document.getElementById('clear-queue-btn').addEventListener('click', async () => {
  queue = { tracks: [], currentIndex: 0 }
  await saveAndSyncQueue()
})

document.getElementById('reset-library-btn').addEventListener('click', async () => {
  const sure = confirm(
    'Clear every playlist, the queue, and cached thumbnails/conversions, and un-set the media folder?\n\n' +
    'Your actual video files are NOT deleted — you\'ll just need to choose the media folder again.\n\n' +
    'This cannot be undone.'
  )
  if (!sure) return

  settings = await jukebox.resetLibrary()
  library = []
  metadataCache = {}
  playlists = []
  queue = { tracks: [], currentIndex: 0 }
  document.getElementById('settings-folder').value = ''
  document.getElementById('library-folder-label').textContent = 'No media folder set — go to Settings.'
  document.getElementById('library-status').textContent = ''
  renderLibrary()
  renderPlaylists()
  renderQueue()
})

// Only this many upcoming rows are drawn - an "Add All to Queue" of the
// whole library would otherwise be ~2,500 rows rebuilt on every change.
const QUEUE_ROWS_SHOWN = 200
// What the queue list was last drawn from - the player reports its state
// every second, but the list only needs redrawing when one of these
// actually changes (see onPlayerState below).
let lastQueueSignature = ''
function queueSignature() {
  return [queue.tracks.length, queue.currentIndex, lastPlayerState && lastPlayerState.status, library.length].join('|')
}

function renderQueue() {
  lastQueueSignature = queueSignature()
  const list = document.getElementById('queue-list')
  // Already-played tracks drop off the visible list entirely (this is
  // display-only - queue.tracks/currentIndex themselves are untouched,
  // so Previous still works and the persisted queue.json stays a full
  // history+upcoming record). Once the queue reaches idle (finished, as
  // opposed to "hasn't started yet"), the last-played track drops off
  // too, since currentIndex never advances past it in that case.
  const finished = lastPlayerState && lastPlayerState.status === 'idle'
  const firstShown = queue.currentIndex + (finished ? 1 : 0)
  const lastShown = firstShown + QUEUE_ROWS_SHOWN
  const hiddenAfter = Math.max(0, queue.tracks.length - lastShown)
  list.innerHTML = queue.tracks.map((key, i) => {
    if (i < firstShown || i >= lastShown) return ''
    const track = trackByKey(key)
    if (!track) return ''
    const isNowPlaying = i === queue.currentIndex && lastPlayerState && lastPlayerState.status !== 'idle'
    return `
      <li class="queue-row ${isNowPlaying ? 'now-playing' : ''}">
        <span class="queue-index">${i + 1}</span>
        <span style="flex:1">${track.filename}</span>
        <span>${fmtTime(track.duration)}</span>
        <div class="button-row">
          <button class="secondary" data-move-up="${i}">↑</button>
          <button class="secondary" data-move-down="${i}">↓</button>
          <button class="secondary" data-play-from="${i}">▶</button>
          <button class="danger" data-remove-idx="${i}">✕</button>
        </div>
      </li>`
  }).join('') + (hiddenAfter ? `<p class="eyebrow">…and ${hiddenAfter} more after these.</p>` : '') || '<p class="eyebrow">Queue is empty — add tracks from the Library.</p>'

  list.querySelectorAll('[data-move-up]').forEach((el) => el.addEventListener('click', () => moveQueueItem(Number(el.dataset.moveUp), -1)))
  list.querySelectorAll('[data-move-down]').forEach((el) => el.addEventListener('click', () => moveQueueItem(Number(el.dataset.moveDown), 1)))
  list.querySelectorAll('[data-remove-idx]').forEach((el) => el.addEventListener('click', () => removeQueueItem(Number(el.dataset.removeIdx))))
  list.querySelectorAll('[data-play-from]').forEach((el) => el.addEventListener('click', () => playQueueFrom(Number(el.dataset.playFrom))))
}

async function moveQueueItem(index, direction) {
  const target = index + direction
  if (target < 0 || target >= queue.tracks.length) return
  const [item] = queue.tracks.splice(index, 1)
  queue.tracks.splice(target, 0, item)
  await saveAndSyncQueue()
}
async function removeQueueItem(index) {
  queue.tracks.splice(index, 1)
  await saveAndSyncQueue()
}
async function playQueueFrom(index) {
  queue.currentIndex = index
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: queue.tracks.map(trackByKey).filter(Boolean).map(toDisplayTrack), startIndex: index })
}

// --- Playlists ---

document.getElementById('create-playlist-btn').addEventListener('click', async () => {
  const nameInput = document.getElementById('new-playlist-name')
  const name = nameInput.value.trim()
  if (!name) return
  const playlist = { id: crypto.randomUUID(), name, trackKeys: [] }
  playlists = await jukebox.savePlaylist(playlist)
  nameInput.value = ''
  renderPlaylists()
  renderLibrary() // picker dropdowns need the new playlist option
})

async function addTrackToPlaylist(playlistId, trackKey) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist || playlist.trackKeys.includes(trackKey)) return
  playlist.trackKeys.push(trackKey)
  playlists = await jukebox.savePlaylist(playlist)
  renderPlaylists()
}

async function removeTrackFromPlaylist(playlistId, trackKey) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist) return
  playlist.trackKeys = playlist.trackKeys.filter((k) => k !== trackKey)
  playlists = await jukebox.savePlaylist(playlist)
  renderPlaylists()
}

// The Library grid's own picker (playlistPickerHtml above) now shows a
// track's current manual playlist as its selection, same as it already
// does for a folder or an artist tag - so picking a *different* one
// there needs to actually move it, not just pile on a second
// membership the way addTrackToPlaylist alone would (a track can still
// end up in several manual playlists some other way, e.g. via the
// Playlists tab's own "add track" controls - this only replaces
// whichever one this exact picker was just showing as current).
// Also covers a real gap the plain add-only version had: nothing here
// used to re-render the Library grid itself, so the picker wouldn't
// show the new selection until some other action happened to redraw it.
async function moveTrackToManualPlaylist(trackKey, newPlaylistId) {
  const currentManual = playlists.find(
    (p) => !p.autoFolder && !p.autoArtist && p.trackKeys.includes(trackKey),
  )
  if (currentManual && currentManual.id !== newPlaylistId) {
    await removeTrackFromPlaylist(currentManual.id, trackKey)
  }
  await addTrackToPlaylist(newPlaylistId, trackKey)
  renderLibrary()
}

async function playPlaylistNow(playlistId) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist || playlist.trackKeys.length === 0) return
  queue = { tracks: [...playlist.trackKeys], currentIndex: 0 }
  await saveAndSyncQueue()
  jukebox.playerLoadQueue({ tracks: queue.tracks.map(trackByKey).filter(Boolean).map(toDisplayTrack), startIndex: 0 })
}
async function appendPlaylistToQueue(playlistId) {
  const playlist = playlists.find((p) => p.id === playlistId)
  if (!playlist) return
  queue.tracks.push(...playlist.trackKeys)
  await saveAndSyncQueue()
}
async function deletePlaylist(id) {
  playlists = await jukebox.deletePlaylist(id)
  if (openPlaylistId === id) openPlaylistId = null
  renderPlaylists()
  renderLibrary()
}

// null = showing the tile grid; a playlist id = that one playlist's
// track list is open. Two-level nav rather than every card permanently
// showing its full track list, which stopped scaling once folder-synced
// playlists (auto-created per subfolder) meant there could be a lot more
// of these than the handful of manually-built ones this screen was
// originally designed around.
let openPlaylistId = null

function wirePlaylistActionButtons(container) {
  container.querySelectorAll('[data-playlist-play]').forEach((el) => el.addEventListener('click', () => playPlaylistNow(el.dataset.playlistPlay)))
  container.querySelectorAll('[data-playlist-append]').forEach((el) => el.addEventListener('click', () => appendPlaylistToQueue(el.dataset.playlistAppend)))
  container.querySelectorAll('[data-playlist-delete]').forEach((el) => el.addEventListener('click', () => deletePlaylist(el.dataset.playlistDelete)))
  container.querySelectorAll('[data-playlist-remove-track]').forEach((el) => el.addEventListener('click', () => {
    const [playlistId, trackKey] = el.dataset.playlistRemoveTrack.split('::')
    removeTrackFromPlaylist(playlistId, trackKey)
  }))
}

function renderPlaylists() {
  const container = document.getElementById('playlists-list')
  const openPlaylist = openPlaylistId && playlists.find((p) => p.id === openPlaylistId)

  if (openPlaylist) {
    const p = openPlaylist
    const isAuto = p.autoFolder || p.autoArtist
    const autoLabel = p.autoFolder ? '📁 synced from folder' : p.autoArtist ? '🎤 synced from tag' : ''
    container.className = 'playlist-detail'
    container.innerHTML = `
      <button class="secondary" id="playlist-back-btn">← Back to Playlists</button>
      <div class="playlist-card">
        <div class="playlist-header">
          <strong>${p.name}${autoLabel ? ` <span class="auto-tag">${autoLabel}</span>` : ''}</strong>
          <div class="button-row">
            <button class="primary" data-playlist-play="${p.id}">▶ Play Now</button>
            <button class="secondary" data-playlist-append="${p.id}">+ Add to Queue</button>
            ${isAuto ? '' : `<button class="danger" data-playlist-delete="${p.id}">Delete</button>`}
          </div>
        </div>
        <div class="playlist-tracks">
          ${p.trackKeys.map((key) => {
            const t = trackByKey(key)
            if (!t) return ''
            // Membership on an auto-synced playlist (folder or artist tag)
            // is recalculated on its own - no manual remove button, since
            // moving the file (or re-tagging it) is the actual "remove".
            return `<div class="playlist-track-row"><span>${t.filename}</span>${isAuto ? '' : `<button class="danger" data-playlist-remove-track="${p.id}::${key}">✕</button>`}</div>`
          }).join('') || `<p class="eyebrow">${p.autoFolder ? 'No files currently in this folder.' : p.autoArtist ? 'No tracks tagged with this artist yet.' : 'No tracks yet - add some from the Library.'}</p>`}
        </div>
      </div>`
    document.getElementById('playlist-back-btn').addEventListener('click', () => { openPlaylistId = null; renderPlaylists() })
    wirePlaylistActionButtons(container)
    return
  }

  container.className = 'playlist-tiles'
  container.innerHTML = playlists.map((p) => `
    <div class="playlist-tile" data-open-playlist="${p.id}">
      <strong>${p.name}${p.autoFolder ? ' <span class="auto-tag">📁</span>' : p.autoArtist ? ' <span class="auto-tag">🎤</span>' : ''}</strong>
      <div class="track-meta">${p.trackKeys.length} track${p.trackKeys.length === 1 ? '' : 's'}</div>
      <div class="track-actions">
        <button class="primary" data-playlist-play="${p.id}">▶ Play</button>
        <button class="secondary" data-playlist-append="${p.id}">+ Queue</button>
      </div>
    </div>`).join('') || '<p class="eyebrow">No playlists yet.</p>'

  // Opening a playlist is a click anywhere on its tile EXCEPT the two
  // action buttons, which do their own thing (play/queue) without also
  // opening the tile - checking e.target here rather than stopping
  // propagation on the buttons themselves, so their own listeners (wired
  // below, same as everywhere else) don't need to know this exists.
  container.querySelectorAll('[data-open-playlist]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return
    openPlaylistId = el.dataset.openPlaylist
    renderPlaylists()
  }))
  wirePlaylistActionButtons(container)
}

// --- Now playing bar ---

let lastPlayerState = null
document.getElementById('np-previous').addEventListener('click', () => jukebox.playerPrevious())
document.getElementById('np-toggle').addEventListener('click', () => jukebox.playerTogglePlayPause())
document.getElementById('np-skip').addEventListener('click', () => jukebox.playerSkip())
document.getElementById('np-shuffle').addEventListener('click', shuffleUpcoming)

// --- Seek bar ---
//
// `isSeeking` is true for the whole time the mouse/touch is down on the
// slider - the once-a-second player-state updates below must not touch
// the slider's own value while it's true, or they'd yank the handle
// back to the real playhead mid-drag. The actual seek command only goes
// out on 'change' (fires once, on release) - not 'input' (fires
// continuously while dragging) - so scrubbing doesn't spam Display with
// a seek per pixel moved.
const npSeek = document.getElementById('np-seek')
let isSeeking = false

function paintSeekFill(pct) {
  npSeek.style.background = `linear-gradient(to right, #4fb3c4 ${pct}%, #ffffff2a ${pct}%)`
}

npSeek.addEventListener('pointerdown', () => { isSeeking = true })
// A plain click with no actual drag doesn't necessarily fire 'change'
// (browsers only fire it when the value genuinely moved) - resetting
// isSeeking here on 'pointerup' unconditionally, rather than inside the
// 'change' handler, means the slider can never get stuck ignoring
// player-state updates after a click that happened not to move it.
npSeek.addEventListener('pointerup', () => { isSeeking = false })
npSeek.addEventListener('input', () => paintSeekFill(Number(npSeek.value) / 10))
npSeek.addEventListener('change', () => {
  const duration = lastPlayerState?.duration || 0
  if (duration > 0) jukebox.playerSeek((Number(npSeek.value) / 1000) * duration)
})

// Randomises everything still to come, leaving whatever's currently
// playing (and anything already played before it) exactly where it is -
// pressing Shuffle should never interrupt what's on screen right now.
// Pushed to Display via playerUpdateQueue rather than playerLoadQueue,
// which would restart the current track from 0.
async function shuffleUpcoming() {
  const nowPlaying = lastPlayerState && lastPlayerState.status !== 'idle'
  const from = nowPlaying ? queue.currentIndex + 1 : 0
  if (queue.tracks.length - from < 2) return // nothing left to shuffle

  const upcoming = queue.tracks.slice(from)
  for (let i = upcoming.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]]
  }
  queue.tracks = [...queue.tracks.slice(0, from), ...upcoming]
  await saveAndSyncQueue()
  jukebox.playerUpdateQueue(queue.tracks.map(trackByKey).filter(Boolean).map(toDisplayTrack))
}

jukebox.onPlayerState((state) => {
  lastPlayerState = state
  document.getElementById('np-title').textContent = state.currentTrack ? state.currentTrack.filename : 'Nothing playing'
  document.getElementById('np-time').textContent = fmtTime(state.timeElapsed)
  document.getElementById('np-duration').textContent = fmtTime(state.duration)
  if (!isSeeking) {
    const pct = state.duration ? (state.timeElapsed / state.duration) * 100 : 0
    npSeek.value = pct * 10
    paintSeekFill(pct)
  }
  if (state.status === 'error' && state.errorTrack) {
    document.getElementById('library-status').textContent = `"${state.errorTrack.filename}" could not be played — ${state.errorReason || 'unsupported format'} — skipped.`
  }
  // Keep the queue view's now-playing highlight and currentIndex in sync.
  if (typeof state.currentIndex === 'number' && state.currentIndex !== queue.currentIndex) {
    queue.currentIndex = state.currentIndex
    jukebox.saveQueue(queue)
  }
  if (queueSignature() !== lastQueueSignature) renderQueue()
})

// --- Software update (Settings tab) ---

document.getElementById('check-update-btn').addEventListener('click', async () => {
  const status = document.getElementById('update-status')
  const result = await jukebox.checkForUpdates()
  // Anything else (checking/available/not-available/downloaded/error) is
  // reported by the onUpdateStatus listener below as electron-updater's
  // real events come in - this button just kicks a check off.
  if (result.state === 'dev-mode') status.textContent = 'Auto-update only runs in the installed app, not this dev copy.'
})

jukebox.onUpdateStatus((status) => {
  const el = document.getElementById('update-status')
  if (status.state === 'checking') el.textContent = 'Checking for updates…'
  else if (status.state === 'available') el.textContent = `Update ${status.version} found - downloading…`
  else if (status.state === 'not-available') el.textContent = `You're on the latest version (${status.version}).`
  else if (status.state === 'downloaded') el.textContent = `Update ${status.version} downloaded - a popup will offer to install it.`
  else if (status.state === 'error') el.textContent = `Could not check for updates: ${status.message}`
})

// --- Init ---

// Hands the queue that survived from before the app was last closed back
// to Display, which otherwise starts fully idle/empty even though this
// window's own Queue tab still shows it - the persisted list only really
// "reappears" once Display is actually resumed on it. Full tracks array
// (not just what's left unplayed) so Previous still reaches back into
// whatever already played before the restart, same as any other resume.
function resumeQueueOnDisplay() {
  if (!queue.tracks.length || queue.currentIndex >= queue.tracks.length) return
  const tracks = queue.tracks.map(trackByKey).filter(Boolean).map(toDisplayTrack)
  if (!tracks.length) return
  jukebox.playerLoadQueue({ tracks, startIndex: queue.currentIndex })
}

async function init() {
  await loadSettings()
  playlists = await jukebox.getPlaylists()
  queue = await jukebox.getQueue()
  renderPlaylists()
  renderQueue()
  if (settings.mediaFolder) await runLibraryOp(rescanLibrary)
  // rescanLibrary doesn't itself re-render the queue, so the earlier
  // renderQueue() above ran against an empty library - re-render now
  // that trackByKey can actually resolve the persisted queue's tracks.
  renderQueue()
  resumeQueueOnDisplay()
  document.getElementById('app-version').textContent = await jukebox.getAppVersion()
}
init()
