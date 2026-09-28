// Control window - Library: actions on one video - delete, tag, move to a folder, convert, and replacing an original with its converted copy.
// Plain scripts loaded in order by index.html; they share one global scope.

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
  jukebox.playerUpdateQueue(displayQueue())
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
  jukebox.playerUpdateQueue(displayQueue())
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
