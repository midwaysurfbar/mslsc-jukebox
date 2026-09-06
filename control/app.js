// --- State ---
let library = []            // [{path, filename, size, mtimeMs, key, duration, thumbPath}]
let metadataCache = {}      // key -> {artist, genre, decade, confidence}
let playlists = []          // [{id, name, trackKeys: []}]
let queue = { tracks: [], currentIndex: 0 }
let settings = { mediaFolder: '', crossfadeSeconds: 3, volume: 1, adsEnabled: false, adsFolder: '', adsEverySongs: 4, adsSecondsPerImage: 6 }
let searchQuery = ''
let groupBy = ''

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

function trackByKey(key) { return library.find((t) => t.key === key) }
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

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
  })
})

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
  document.getElementById('ads-folder').value = settings.adsFolder || ''
  document.getElementById('ads-every-slider').value = settings.adsEverySongs
  document.getElementById('ads-every-value').textContent = settings.adsEverySongs
  document.getElementById('ads-every-plural').textContent = settings.adsEverySongs === 1 ? '' : 's'
  document.getElementById('ads-seconds-slider').value = settings.adsSecondsPerImage
  document.getElementById('ads-seconds-value').textContent = settings.adsSecondsPerImage
}

document.getElementById('choose-folder-btn').addEventListener('click', async () => {
  const folder = await jukebox.chooseMediaFolder()
  if (folder) { await loadSettings(); await runLibraryOp(rescanLibrary) }
})

document.getElementById('ads-enabled-toggle').addEventListener('change', async (e) => {
  settings.adsEnabled = e.target.checked
  await jukebox.saveSettings(settings)
})
document.getElementById('choose-ads-folder-btn').addEventListener('click', async () => {
  const folder = await jukebox.chooseAdsFolder()
  if (folder) await loadSettings()
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
    const video = document.createElement('video')

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      video.remove()
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
      track.duration = video.duration
      track.error = false
      track.needsConversion = false
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
  // Thumbnails/duration are generated a few at a time, not all at once,
  // so a big batch of new files doesn't freeze the UI - re-render as each
  // batch lands.
  const BATCH = 4
  for (let i = 0; i < newOnes.length; i += BATCH) {
    await Promise.all(newOnes.slice(i, i + BATCH).map(generateThumbAndDuration))
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
jukebox.onMediaFolderChanged(() => runLibraryOp(rescanLibrary))

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
  for (const track of newOnes) await generateThumbAndDuration(track)
  if (newOnes.length) renderLibrary()
}))

document.getElementById('library-search').addEventListener('input', (e) => { searchQuery = e.target.value.toLowerCase(); renderLibrary() })
document.getElementById('library-group-by').addEventListener('change', (e) => { groupBy = e.target.value; renderLibrary() })

// One picker, two different things happening underneath depending on
// what's chosen - a manual playlist just gets the track key appended
// (playlists.json), but a folder-synced one can only ever be "joined" by
// actually moving the file into its folder (folders are the source of
// truth for those, everywhere else in the app too) - same for the
// "New folder…" option, which creates one on the spot. moveTrackToFolder
// handles both of the folder cases; addTrackToPlaylist the manual one.
function playlistPickerHtml(track) {
  const manualOptions = playlists.filter((p) => !p.autoFolder)
    .map((p) => `<option value="playlist:${p.id}">${p.name}</option>`).join('')
  const folderOptions = playlists.filter((p) => p.autoFolder)
    .map((p) => `<option value="folder:${p.folderPath}">📁 ${p.name}</option>`).join('')
  return `
    <select data-track-picker="${track.key}">
      <option value="">+ Playlist</option>
      ${manualOptions}
      ${folderOptions}
      <option value="new-folder">📁 New folder…</option>
    </select>`
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
      </div>
      <div class="track-actions">
        <button class="danger" data-delete-file="${track.key}" title="Permanently delete this file from the drive">🗑 Delete</button>
      </div>
    </div>`
}

function renderLibrary() {
  const grid = document.getElementById('library-grid')
  let items = library.filter((t) => t.filename.toLowerCase().includes(searchQuery))

  if (groupBy) {
    const groups = new Map()
    for (const track of items) {
      const meta = metadataCache[track.key]
      const label = (meta && meta[groupBy] && meta[groupBy] !== 'Unknown') ? meta[groupBy] : 'Unknown'
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(track)
    }
    const sortedLabels = [...groups.keys()].sort((a, b) => (a === 'Unknown' ? 1 : b === 'Unknown' ? -1 : a.localeCompare(b)))
    grid.innerHTML = sortedLabels.map((label) => `<div class="library-group">${label}</div>` + groups.get(label).map(renderTrackTile).join('')).join('')
  } else {
    items = [...items].sort((a, b) => a.filename.localeCompare(b.filename))
    grid.innerHTML = items.map(renderTrackTile).join('')
  }

  grid.querySelectorAll('[data-play-now]').forEach((el) => el.addEventListener('click', () => playNow(el.dataset.playNow)))
  grid.querySelectorAll('[data-add-queue]').forEach((el) => el.addEventListener('click', () => addToQueue(el.dataset.addQueue)))
  grid.querySelectorAll('[data-track-picker]').forEach((el) => el.addEventListener('change', async (e) => {
    const trackKey = el.dataset.trackPicker
    const value = e.target.value
    e.target.value = ''
    if (!value) return
    if (value.startsWith('playlist:')) addTrackToPlaylist(value.slice('playlist:'.length), trackKey)
    else if (value.startsWith('folder:')) runLibraryOp(() => moveTrackToFolder(trackKey, value.slice('folder:'.length)))
    else if (value === 'new-folder') {
      const name = await askForFolderName()
      if (name) runLibraryOp(() => moveTrackToFolder(trackKey, name))
    }
  }))
  grid.querySelectorAll('[data-convert]').forEach((el) => el.addEventListener('click', () => convertTrack(el.dataset.convert)))
  grid.querySelectorAll('[data-delete-file]').forEach((el) => el.addEventListener('click', () => runLibraryOp(() => deleteFile(el.dataset.deleteFile))))
}

// Permanently removes one file from the actual media drive - not just
// this library list. Confirms first since, unlike Reset Library, this
// really can't be undone (no re-scan brings it back), then cleans the
// track out of local state using exactly what main returned, so playlists
// and the queue can never drift from what's now on disk.
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
    playlists = result.playlists
    queue = result.queue
    library = library.filter((t) => t.key !== key)
    delete metadataCache[key]
    document.getElementById('library-status').textContent = `Deleted "${track.filename}" from the drive.`
    renderLibrary()
    renderPlaylists()
    renderQueue()
    jukebox.playerUpdateQueue(queue.tracks.map(trackByKey).filter(Boolean).map(toDisplayTrack))
  } catch (err) {
    document.getElementById('library-status').textContent = `Could not delete "${track.filename}": ${err.message}`
  }
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
    for (const t of newOnes) await generateThumbAndDuration(t)
    if (newOnes.length) renderLibrary()
  } catch (err) {
    document.getElementById('library-status').textContent = `Could not move "${track.filename}": ${err.message}`
  }
}

// Re-encodes one track to plain H.264/AAC MP4 via the bundled ffmpeg,
// then re-runs the same duration/thumbnail pass a freshly-scanned file
// gets - generateThumbAndDuration already prefers a converted copy the
// moment one exists, so this is the only place that needs to know
// conversion happened at all.
async function convertTrack(key) {
  const track = trackByKey(key)
  if (!track || track.converting) return
  track.converting = true
  renderLibrary()
  try {
    track.convertedPath = await jukebox.convertFile(key, track.path)
    track.needsConversion = false
  } catch (err) {
    document.getElementById('library-status').textContent = `Could not convert "${track.filename}": ${err.message}`
  }
  track.converting = false
  await generateThumbAndDuration(track)
  renderLibrary()
}

document.getElementById('convert-all-btn').addEventListener('click', async () => {
  const status = document.getElementById('library-status')
  const toConvert = library.filter((t) => t.needsConversion && !t.converting)
  for (let i = 0; i < toConvert.length; i++) {
    status.textContent = `Converting ${i + 1}/${toConvert.length}: "${toConvert[i].filename}"…`
    await convertTrack(toConvert[i].key)
  }
  status.textContent = toConvert.length ? '' : 'Nothing needs converting right now.'
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

function renderQueue() {
  const list = document.getElementById('queue-list')
  list.innerHTML = queue.tracks.map((key, i) => {
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
  }).join('') || '<p class="eyebrow">Queue is empty — add tracks from the Library.</p>'

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
    container.className = 'playlist-detail'
    container.innerHTML = `
      <button class="secondary" id="playlist-back-btn">← Back to Playlists</button>
      <div class="playlist-card">
        <div class="playlist-header">
          <strong>${p.name}${p.autoFolder ? ' <span class="auto-tag">📁 synced from folder</span>' : ''}</strong>
          <div class="button-row">
            <button class="primary" data-playlist-play="${p.id}">▶ Play Now</button>
            <button class="secondary" data-playlist-append="${p.id}">+ Add to Queue</button>
            ${p.autoFolder ? '' : `<button class="danger" data-playlist-delete="${p.id}">Delete</button>`}
          </div>
        </div>
        <div class="playlist-tracks">
          ${p.trackKeys.map((key) => {
            const t = trackByKey(key)
            if (!t) return ''
            // Membership on a folder-synced playlist is recalculated from
            // disk on every rescan - no manual remove button, since moving
            // the file out of the folder is the actual "remove" action.
            return `<div class="playlist-track-row"><span>${t.filename}</span>${p.autoFolder ? '' : `<button class="danger" data-playlist-remove-track="${p.id}::${key}">✕</button>`}</div>`
          }).join('') || `<p class="eyebrow">${p.autoFolder ? 'No files currently in this folder.' : 'No tracks yet - add some from the Library.'}</p>`}
        </div>
      </div>`
    document.getElementById('playlist-back-btn').addEventListener('click', () => { openPlaylistId = null; renderPlaylists() })
    wirePlaylistActionButtons(container)
    return
  }

  container.className = 'playlist-tiles'
  container.innerHTML = playlists.map((p) => `
    <div class="playlist-tile" data-open-playlist="${p.id}">
      <strong>${p.name}${p.autoFolder ? ' <span class="auto-tag">📁</span>' : ''}</strong>
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
  const pct = state.duration ? (state.timeElapsed / state.duration) * 100 : 0
  document.getElementById('np-progress-bar').style.width = `${pct}%`
  if (state.status === 'error' && state.errorTrack) {
    document.getElementById('library-status').textContent = `"${state.errorTrack.filename}" could not be played — ${state.errorReason || 'unsupported format'} — skipped.`
  }
  // Keep the queue view's now-playing highlight and currentIndex in sync.
  if (typeof state.currentIndex === 'number' && state.currentIndex !== queue.currentIndex) {
    queue.currentIndex = state.currentIndex
    jukebox.saveQueue(queue)
  }
  renderQueue()
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

async function init() {
  await loadSettings()
  playlists = await jukebox.getPlaylists()
  queue = await jukebox.getQueue()
  renderPlaylists()
  renderQueue()
  if (settings.mediaFolder) await runLibraryOp(rescanLibrary)
  document.getElementById('app-version').textContent = await jukebox.getAppVersion()
}
init()
