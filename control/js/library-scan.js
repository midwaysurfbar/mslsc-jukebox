// Control window - Library: scanning the media folder, probing new videos (duration, thumbnail), tag lookups, sorting into decade folders.
// Plain scripts loaded in order by index.html; they share one global scope.

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

// A track only needs opening in a <video> if it's never been measured, it's
// playable but somehow still has no thumbnail, or it's marked as not
// playing. That last one is re-checked on every start (Sam, 2026-10-06):
// a network blip or a slow first look after converting could leave a
// perfectly good video stuck as "Unsupported" for good - 1,086 of them on
// the venue PC, all of which turned out to play fine.
function needsProbe(track) {
  return !track.infoCached || track.error || !track.thumbPath
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

// The Library page on a laptop changed something (lib/library-manager.js):
// renamed or moved songs get a new key, deleted ones are gone, and a
// removed duplicate's place goes to the copy that was kept. The queue
// follows straight away (this window owns it), then a normal rescan picks
// up the files, names and playlists.
jukebox.onLibraryChangedElsewhere(({ pairs = {}, removed = [], playlistsOnly = false }) => {
  const gone = new Set(removed)
  if (Object.keys(pairs).length || gone.size) {
    const removedBefore = queue.tracks.slice(0, queue.currentIndex).filter((k) => gone.has(k)).length
    queue.tracks = queue.tracks.map((k) => pairs[k] || k).filter((k) => !gone.has(k))
    queue.currentIndex = Math.max(0, queue.currentIndex - removedBefore) // same rule as purgeDerivedState
    jukebox.saveQueue(queue)
  }
  runLibraryOp(async () => {
    if (playlistsOnly) {
      playlists = await jukebox.getPlaylists()
      renderPlaylists()
      renderLibrary()
      return
    }
    await rescanLibrary()
    renderQueue()
    sendQueueToDisplay()
  })
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
