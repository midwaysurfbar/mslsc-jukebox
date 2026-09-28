// The video library: scanning the media folder, the per-file key every
// other store hangs off, auto-synced playlists, the cache folders, and the
// few actions that touch real files (move, delete, recycle). No Electron in
// here - main.js injects the one OS call it needs (trashItem) - so it runs
// under plain Node in the tests.
//
// Scanning is ASYNC (code review 2026-09-29). The main process also relays
// every play/skip/volume command between Control and the TV, and a
// synchronous walk of ~2,500 files over a network share used to hold all of
// that up for as long as it took. Everything after a walk (playlist sync,
// cache prune) is still one synchronous step, so two scans can't interleave
// their read-modify-write of playlists.json.
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const { guessArtistTitle } = require('../shared/names')

// .avi/.wmv almost always carry a codec Chromium can't decode natively
// (Xvid/DivX/WMV3/VC-1) - they show up flagged "Needs conversion".
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.wmv'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])

// Deliberately NOT keyed on mtime - copying files onto the PC (USB stick,
// archive, sync tool) commonly resets modified-time for byte-identical
// content, which used to mint a new key for the same video and orphan its
// converted copy. Path + size is a much more stable identity.
function fileKey(filePath, size) {
  return crypto.createHash('md5').update(`${filePath}:${size}`).digest('hex')
}

// Cache keys are always an md5 hex string. Every handler that builds a file
// path from a key checks it first, so a bad key can never point a write or
// delete outside the cache folders.
function isFileKey(key) {
  return typeof key === 'string' && /^[a-f0-9]{32}$/.test(key)
}
function requireFileKey(key) {
  if (!isFileKey(key)) throw new Error('Invalid track key.')
  return key
}

function isNetworkPath(p) {
  return /^(\\\\|\/\/)/.test(p)
}

// Dot-prefixed entries are hidden Unix/macOS convention, never a real video
// - most commonly .AppleDouble folders of 0-byte same-named sidecars left by
// copying via a Mac, which otherwise look like a broken second copy of
// every video (the real "every video shows doubled" bug, v0.3.5).
//
// `root` is threaded through unchanged so each file records its subfolder
// relative to the media folder ("80's", "80's/Rock", or "" for the root) -
// that's what turns "make a folder" into "get a playlist".
async function walkVideoFiles(dir, root, results = []) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkVideoFiles(full, root, results)
    } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      let stat
      try {
        stat = await fsp.stat(full)
      } catch {
        continue // vanished between the listing and now (being moved) - the next scan sees where it went
      }
      const folder = path.relative(root, dir).split(path.sep).join('/')
      results.push({ path: full, filename: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, key: fileKey(full, stat.size), folder })
    }
  }
  return results
}

// Same idea for the ad slideshow's images - just paths, nothing to cache.
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
    if (entry.isDirectory()) walkImageFiles(full, results)
    else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push({ path: full, filename: entry.name })
  }
  return results
}

function createLibrary(store, { trashItem = async () => { throw new Error('Recycle Bin unavailable.') }, onScanned = () => {} } = {}) {
  const { paths, readJson, writeJson } = store

  // The most recent full scan, kept so the song picker's list can be built
  // from it instead of walking the whole folder again. Every whole-library
  // scan goes through here, so it's never older than the last thing this
  // app did to the folder.
  let lastScan = null // { folder, files }
  async function scanMediaFolder(mediaFolder) {
    const files = await walkVideoFiles(mediaFolder, mediaFolder)
    lastScan = { folder: mediaFolder, files: files.map((f) => ({ ...f })) }
    onScanned()
    return files
  }

  function mediaFolderOrEmpty() {
    const folder = store.getSettings().mediaFolder
    return folder ? path.resolve(folder) : ''
  }

  // Refuses anything outside the configured media folder, so no action can
  // ever be pointed at an arbitrary path.
  function resolveInsideMediaFolder(filePath) {
    const mediaFolder = mediaFolderOrEmpty()
    const resolved = path.resolve(filePath)
    if (!mediaFolder || (resolved !== mediaFolder && !resolved.startsWith(mediaFolder + path.sep))) return null
    return resolved
  }

  // --- Auto-synced playlists ---
  // One playlist per subfolder (autoFolder/folderPath) - dragging videos
  // into a folder IS the "add to playlist" step. A folder that's deleted,
  // emptied or renamed loses its playlist; a manual playlist is never
  // touched. Root-level files get none (no folder name to draw one from).
  function syncFolderPlaylists(files) {
    const byFolder = new Map()
    for (const file of files) {
      if (!file.folder) continue
      if (!byFolder.has(file.folder)) byFolder.set(file.folder, [])
      byFolder.get(file.folder).push(file.key)
    }
    let playlists = store.getPlaylists().filter((p) => !p.autoFolder || byFolder.has(p.folderPath))
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
    writeJson(paths.playlists, playlists)
    return playlists
  }

  // One playlist per artist tag (autoArtist/artistValue) - Sam, 2026-09-13:
  // "sort music videos by band ... not move the videos but tag them". Only a
  // confident tag counts: an iTunes 'high' match or one typed by hand.
  function syncArtistPlaylists(files) {
    const metadata = store.getMetadata()
    const byArtist = new Map()
    for (const file of files) {
      const meta = metadata[file.key]
      const confident = meta && meta.artist && meta.artist !== 'Unknown' && (meta.confidence === 'high' || meta.confidence === 'manual')
      if (!confident) continue
      if (!byArtist.has(meta.artist)) byArtist.set(meta.artist, [])
      byArtist.get(meta.artist).push(file.key)
    }
    let playlists = store.getPlaylists().filter((p) => !p.autoArtist || byArtist.has(p.artistValue))
    for (const [artistValue, trackKeys] of byArtist) {
      const existing = playlists.find((p) => p.autoArtist && p.artistValue === artistValue)
      if (existing) existing.trackKeys = trackKeys
      else playlists.push({ id: crypto.randomUUID(), name: artistValue, autoArtist: true, artistValue, trackKeys })
    }
    writeJson(paths.playlists, playlists)
    return playlists
  }

  // Skipped entirely when the scan found nothing: an unreachable media
  // folder (drive unplugged, share down) must never be read as "every
  // folder is gone" and wipe every folder-playlist.
  function syncAllAutoPlaylists(files) {
    if (!files.length) return store.getPlaylists()
    syncFolderPlaylists(files)
    return syncArtistPlaylists(files)
  }

  // --- Cache folders (thumbnails, converted copies) ---
  // Removes cache files that no longer match a video the last scan found.
  // Only ever called after a non-empty scan (see syncAllAutoPlaylists).
  function pruneOrphanedCacheFiles(validKeys) {
    let removed = 0
    for (const dir of [paths.thumbnails, paths.converted]) {
      let entries
      try { entries = fs.readdirSync(dir) } catch { continue }
      for (const name of entries) {
        const key = name.replace(/\.[^.]+$/, '').replace(/\.tmp$/, '')
        if (!validKeys.has(key)) {
          try { fs.rmSync(path.join(dir, name), { force: true }); removed += 1 } catch { /* best effort */ }
        }
      }
    }
    return removed
  }

  // Two directory listings instead of an existsSync per file.
  function listCacheKeys(dir, ext) {
    try {
      return new Set(fs.readdirSync(dir).filter((n) => n.endsWith(ext) && !n.endsWith(`.tmp${ext}`)).map((n) => n.slice(0, -ext.length)))
    } catch {
      return new Set()
    }
  }

  // Hands back everything already known about each file, so Control can
  // skip re-probing it.
  function attachKnownInfo(files) {
    const info = store.loadTrackInfo()
    const thumbKeys = listCacheKeys(paths.thumbnails, '.jpg')
    const convertedKeys = listCacheKeys(paths.converted, '.mp4')
    for (const file of files) {
      if (thumbKeys.has(file.key)) file.thumbPath = path.join(paths.thumbnails, `${file.key}.jpg`)
      if (convertedKeys.has(file.key)) file.convertedPath = path.join(paths.converted, `${file.key}.mp4`)
      const known = info[file.key]
      if (known) {
        file.duration = known.duration
        file.error = known.error
        file.needsConversion = known.needsConversion && !file.convertedPath
        file.infoCached = true
      }
    }
    return files
  }

  // The full listing Control asks for on every rescan.
  async function listLibrary() {
    const mediaFolder = store.getSettings().mediaFolder
    if (!mediaFolder) return { files: [], prunedCount: 0, playlists: store.getPlaylists() }
    const files = await scanMediaFolder(mediaFolder)
    const prunedCount = files.length > 0 ? pruneOrphanedCacheFiles(new Set(files.map((r) => r.key))) : 0
    const playlists = syncAllAutoPlaylists(files)
    attachKnownInfo(files)
    if (files.length > 0) {
      const info = store.loadTrackInfo()
      const validKeys = new Set(files.map((f) => f.key))
      let pruned = false
      for (const key of Object.keys(info)) {
        if (!validKeys.has(key)) { delete info[key]; pruned = true }
      }
      if (pruned) store.scheduleTrackInfoWrite()
    }
    return { files, prunedCount, playlists }
  }

  // After an action that changed the folder: the fresh listing, playlists,
  // cache prune and queue, in the shape Control reconciles from.
  async function rescanAfterChange(mediaFolder) {
    const files = attachKnownInfo(await scanMediaFolder(mediaFolder))
    const playlists = syncAllAutoPlaylists(files)
    const prunedCount = files.length > 0 ? pruneOrphanedCacheFiles(new Set(files.map((r) => r.key))) : 0
    return { files, playlists, prunedCount, queue: store.getQueue() }
  }

  // --- Following a file to its new key ---
  // Moving/renaming a real file changes its key (path+size), so everything
  // that referenced the old key follows it: cached thumbnail/converted copy,
  // remembered duration, tags, every playlist, and the queue. Takes a batch
  // so re-linking a whole library reads and writes each store once.
  function remapFileKeys(pairs) {
    if (!pairs.size) return
    for (const [oldKey, newKey] of pairs) {
      for (const [dir, ext] of [[paths.thumbnails, '.jpg'], [paths.converted, '.mp4']]) {
        const oldPath = path.join(dir, `${oldKey}${ext}`)
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, path.join(dir, `${newKey}${ext}`))
      }
    }

    const info = store.loadTrackInfo()
    let infoChanged = false
    for (const [oldKey, newKey] of pairs) {
      if (info[oldKey]) { info[newKey] = info[oldKey]; delete info[oldKey]; infoChanged = true }
    }
    if (infoChanged) store.scheduleTrackInfoWrite()

    const metadata = store.getMetadata()
    let metadataChanged = false
    for (const [oldKey, newKey] of pairs) {
      if (metadata[oldKey]) { metadata[newKey] = metadata[oldKey]; delete metadata[oldKey]; metadataChanged = true }
    }
    if (metadataChanged) writeJson(paths.metadata, metadata)

    const playlists = store.getPlaylists()
    let playlistsChanged = false
    for (const p of playlists) {
      p.trackKeys = p.trackKeys.map((k) => {
        if (!pairs.has(k)) return k
        playlistsChanged = true
        return pairs.get(k)
      })
    }
    if (playlistsChanged) writeJson(paths.playlists, playlists)

    const queue = store.getQueue()
    if (queue.tracks.some((k) => pairs.has(k))) {
      queue.tracks = queue.tracks.map((k) => pairs.get(k) || k)
      writeJson(paths.queue, queue)
    }
  }

  // A file's key comes from its full path, so pointing the Jukebox at the
  // same videos in a new place (Sam, 2026-09-25: the drive moving from a
  // network share into this PC) would make every video look brand new. Any
  // file at the same relative path with the same size is the same video.
  async function relinkMovedLibrary(previousFolder, newFolder) {
    if (!previousFolder || path.resolve(previousFolder) === path.resolve(newFolder)) return 0
    const pairs = new Map()
    for (const file of await walkVideoFiles(newFolder, newFolder)) {
      const oldKey = fileKey(path.join(previousFolder, path.relative(newFolder, file.path)), file.size)
      if (oldKey !== file.key) pairs.set(oldKey, file.key)
    }
    remapFileKeys(pairs)
    return pairs.size
  }

  // Moves one real file into destDir, never overwriting: a name clash gets
  // a "(2)"-style suffix. Returns the file's new key.
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
    remapFileKeys(new Map([[oldKey, newKey]]))
    return newKey
  }

  // Physically sorts files still loose in the media folder's root into
  // decade folders ("1980s") - only a confident ('high' or hand-typed) match
  // moves, and anything already in any folder is left alone.
  async function sortUnsortedByDecade() {
    const mediaFolder = mediaFolderOrEmpty()
    if (!mediaFolder) return { moved: 0, skipped: 0, movedKeys: {}, files: [], playlists: store.getPlaylists(), queue: store.getQueue() }
    const files = await walkVideoFiles(mediaFolder, mediaFolder)
    const metadata = store.getMetadata()
    const movedKeys = {}
    let moved = 0
    let skipped = 0
    for (const file of files) {
      if (file.folder) continue
      const meta = metadata[file.key]
      const confident = meta && meta.decade && meta.decade !== 'Unknown' && (meta.confidence === 'high' || meta.confidence === 'manual')
      if (!confident) { skipped += 1; continue }
      movedKeys[file.key] = moveFileTo(file.path, file.size, path.join(mediaFolder, meta.decade))
      moved += 1
    }
    return { moved, skipped, movedKeys, ...(await rescanAfterChange(mediaFolder)) }
  }

  // One track into an existing folder-playlist's folder, or a new one typed
  // on the spot - moving the file is what makes it "join". Both ends must
  // resolve inside the media folder.
  async function moveFileToFolder(sourcePath, folderPath) {
    const mediaFolder = mediaFolderOrEmpty()
    const resolvedSource = resolveInsideMediaFolder(sourcePath)
    if (!resolvedSource) throw new Error('Refusing to move a file outside the configured media folder.')
    const destDir = path.resolve(path.join(mediaFolder, String(folderPath)))
    if (destDir !== mediaFolder && !destDir.startsWith(mediaFolder + path.sep)) {
      throw new Error('Refusing to move a file to a folder outside the media folder.')
    }
    const stat = fs.statSync(resolvedSource)
    const newKey = moveFileTo(resolvedSource, stat.size, destDir)
    return { newKey, ...(await rescanAfterChange(mediaFolder)) }
  }

  // Cleans up every trace of a file that's gone - cache, tags, remembered
  // info, playlists and queue.
  function purgeDerivedState(key) {
    for (const dir of [paths.thumbnails, paths.converted]) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(key)) fs.rmSync(path.join(dir, name), { force: true })
        }
      } catch { /* cache dir may not exist yet */ }
    }

    const metadata = store.getMetadata()
    delete metadata[key]
    writeJson(paths.metadata, metadata)

    const info = store.loadTrackInfo()
    if (info[key]) { delete info[key]; store.scheduleTrackInfoWrite() }

    const playlists = store.getPlaylists().map((p) => ({ ...p, trackKeys: p.trackKeys.filter((k) => k !== key) }))
    writeJson(paths.playlists, playlists)

    const queue = store.getQueue()
    const removedBeforeCurrent = queue.tracks.slice(0, queue.currentIndex).filter((k) => k === key).length
    queue.tracks = queue.tracks.filter((k) => k !== key)
    queue.currentIndex = Math.max(0, queue.currentIndex - removedBeforeCurrent)
    writeJson(paths.queue, queue)

    return { playlists, queue }
  }

  // Permanently deletes one real file - only from a staff click, after a
  // confirm in Control.
  function deleteFile(key, filePath) {
    requireFileKey(key)
    const resolved = resolveInsideMediaFolder(filePath)
    if (!resolved) throw new Error('Refusing to delete a file outside the configured media folder.')
    fs.rmSync(resolved, { force: true })
    return purgeDerivedState(key)
  }

  // Runs automatically when a file is confirmed unplayable (Sam, 2026-09-12:
  // "i dont want files hanging around the system if the system cant play
  // them"), so it goes to the Recycle Bin - recoverable if ever wrong.
  async function trashUnplayableFile(key, filePath) {
    requireFileKey(key)
    const resolved = resolveInsideMediaFolder(filePath)
    if (!resolved) throw new Error('Refusing to remove a file outside the configured media folder.')
    await trashItem(resolved)
    return purgeDerivedState(key)
  }

  // Wipes the app's own state (never a real video) - as on a fresh install.
  function resetAll() {
    writeJson(paths.playlists, [])
    writeJson(paths.queue, { tracks: [], currentIndex: 0 })
    writeJson(paths.metadata, {})
    store.resetTrackInfo()
    fs.rmSync(paths.thumbnails, { recursive: true, force: true })
    fs.rmSync(paths.converted, { recursive: true, force: true })
    const settings = { ...store.getSettings(), mediaFolder: '' }
    writeJson(paths.settings, settings)
    return settings
  }

  // The song picker's list: every video Display can play, named the way
  // people know it - the tagged/looked-up artist, else "Artist - Title" from
  // the filename - with a decade from tags or a decade folder ("1980s").
  // Short keys keep the list small for ~2,500 songs.
  async function listRequestLibrary() {
    const mediaFolder = store.getSettings().mediaFolder
    if (!mediaFolder) return []
    const scanned = lastScan && path.resolve(lastScan.folder) === path.resolve(mediaFolder)
      ? lastScan.files.map((f) => ({ ...f }))
      : await walkVideoFiles(mediaFolder, mediaFolder)
    const files = attachKnownInfo(scanned)
    const metadata = store.getMetadata()
    const out = []
    for (const f of files) {
      if (f.error || f.needsConversion) continue
      const meta = metadata[f.key] || {}
      const guess = guessArtistTitle(f.filename)
      const artist = meta.artist && meta.artist !== 'Unknown' ? meta.artist : guess.artist
      const folderDecade = (f.folder.split('/')[0].match(/^(\d{4})s$/) || [])[1]
      const decade = meta.decade && meta.decade !== 'Unknown' ? meta.decade : folderDecade ? `${folderDecade}s` : ''
      out.push({ k: f.key, t: guess.title || f.filename, a: artist || '', d: decade, th: Boolean(f.thumbPath) })
    }
    out.sort((x, y) => x.t.localeCompare(y.t, undefined, { sensitivity: 'base' }))
    return out
  }

  return {
    scanMediaFolder,
    listLibrary,
    rescanAfterChange,
    syncFolderPlaylists,
    syncArtistPlaylists,
    syncAllAutoPlaylists,
    pruneOrphanedCacheFiles,
    attachKnownInfo,
    remapFileKeys,
    relinkMovedLibrary,
    moveFileTo,
    sortUnsortedByDecade,
    moveFileToFolder,
    purgeDerivedState,
    deleteFile,
    trashUnplayableFile,
    resetAll,
    resolveInsideMediaFolder,
    listRequestLibrary,
  }
}

module.exports = { createLibrary, walkVideoFiles, walkImageFiles, fileKey, isFileKey, requireFileKey, isNetworkPath, VIDEO_EXTENSIONS }
