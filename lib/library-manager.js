// Library Manager (Sam, 2026-10-11): tidy the music video library from a
// laptop - rename songs, move them into decade folders, delete songs, find
// and remove duplicate copies, manage playlists, and sort a folder into
// decades. The page lives at /library (../library/, served by requests.js)
// and only answers paired laptops on Tailscale.
//
// Every change happens here, in the Jukebox itself, using the same library
// functions as the Control window - so the song picker, the Remote and
// Control all see it straight away (onChanged tells Control which songs
// changed key or went, so the queue follows them).
//
// Safety rules (agreed with Sam):
//   * A deleted song goes to a hidden holding folder on the same drive
//     (".Jukebox Deleted" inside the media folder - the scan skips dot
//     folders) and is only really deleted after 30 days. Until then the
//     History tab can put it back exactly where it was, tags and playlist
//     places included.
//   * Every change is written to History with an Undo.
//   * The song that's playing right now can't be deleted.
//   * Removing a duplicate copy puts the kept copy in its place in every
//     playlist and in the queue, so no playlist loses a song.
//   * Folders that are really playlists made of copies (Favourites, Poppa's
//     Playlist...) can be turned into normal playlists first, so deleting
//     their copies doesn't empty them.
// No Electron in here - it runs under plain Node in the tests.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile: nodeExecFile } = require('node:child_process')
const { fileKey, isFileKey, describeFile } = require('./library')
const { guessArtistTitle } = require('../shared/names')

const HOLD_DIR = '.Jukebox Deleted'
const KEEP_DELETED_DAYS = 30
const HISTORY_MAX = 400
const DECADE_RE = /^(19|20)\d0s$/
const LOOKUP_GAP_MS = 3200 // iTunes allows about 20 searches a minute

// Words compared for "same song": lower case, no accents, no punctuation,
// no "the"/"a", "&" = "and", nothing in brackets.
function normWords(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim()
}
// "Daryl Hall & John Oates ft. X" -> "daryl hall and john oates"
function mainArtist(s) {
  return normWords(String(s || '').split(/\s+(?:ft|feat|featuring)\.?\s+|,\s*/i)[0])
}
function sameArtist(a, b) {
  if (!a || !b) return false
  return a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)))
}
// "Stay 1", "Dreams 2" - a second copy numbered by a download tool
function titleKey(title) {
  return normWords(String(title || '').replace(/\s+\d$/, ''))
}
// Anything a file name can't hold (or that would confuse the "Artist -
// Title" reading) becomes a space.
function cleanPart(s, max = 120) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, max).trim()
}
const lyricVideo = (name) => /lyric/i.test(name)

function createLibraryManager({
  store,
  library,
  ffmpegPath = '',
  playingKey = () => null,
  onChanged = () => {},
  fetchImpl = (...args) => fetch(...args),
  execFile = nodeExecFile,
  now = () => Date.now(),
  lookupGapMs = LOOKUP_GAP_MS,
}) {
  const { paths, readJson, writeJson } = store
  const STATE = {
    history: path.join(paths.userData, 'library-history.json'),
    ignored: path.join(paths.userData, 'library-duplicates-ignored.json'),
    quality: path.join(paths.userData, 'library-video-quality.json'),
    decades: path.join(paths.userData, 'library-decade-lookups.json'),
  }

  // ---------------------------------------------------------------- helpers
  function mediaFolder() {
    const folder = store.getSettings().mediaFolder
    if (!folder) throw new Error('The Jukebox has no media folder set.')
    return path.resolve(folder)
  }
  const holdDir = () => path.join(mediaFolder(), HOLD_DIR)
  const rel = (full) => path.relative(mediaFolder(), full).split(path.sep).join('/')
  const abs = (relPath) => {
    const root = mediaFolder()
    const full = path.resolve(root, String(relPath || ''))
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('That isn\'t inside the music folder.')
    return full
  }
  const isManual = (p) => !p.autoFolder && !p.autoArtist

  async function files() {
    return library.attachKnownInfo(await library.getScanFiles())
  }
  async function fileFor(key) {
    if (!isFileKey(key)) throw new Error('That song wasn\'t recognised.')
    const f = (await files()).find((x) => x.key === key)
    if (!f) throw new Error('That song has moved or gone - refresh the list and try again.')
    return f
  }
  function history() {
    const h = readJson(STATE.history, [])
    return Array.isArray(h) ? h : []
  }
  function record(entry, by) {
    const h = history()
    const item = { id: crypto.randomUUID(), at: now(), by: by || '', ...entry }
    h.unshift(item)
    writeJson(STATE.history, h.slice(0, HISTORY_MAX))
    return item
  }
  function setHistory(id, patch) {
    writeJson(STATE.history, history().map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }
  // After anything that moved or removed files: refresh the Jukebox's own
  // picture of the folder (and the folder/artist playlists), then tell
  // Control, the song picker and the Remote.
  async function changed({ pairs = {}, removed = [] } = {}) {
    await library.rescanAfterChange(mediaFolder())
    onChanged({ pairs, removed })
  }
  function playlistsChanged() {
    onChanged({ pairs: {}, removed: [], playlistsOnly: true })
  }
  // A file's new home, never on top of another file: "Name (2).mp4"...
  function freePath(dir, base, ext, self) {
    let candidate = path.join(dir, `${base}${ext}`)
    let n = 2
    while (fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(self || '')) {
      candidate = path.join(dir, `${base} (${n})${ext}`)
      n += 1
    }
    return candidate
  }
  function moveFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try {
      fs.renameSync(from, to)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      fs.copyFileSync(from, to)
      fs.rmSync(from)
    }
  }
  function folderChoice(folder, fallback) {
    if (folder === undefined || folder === null) return fallback
    const f = String(folder).split('/').map((p) => cleanPart(p, 80)).filter(Boolean).join('/')
    if (f.split('/').some((p) => p.startsWith('.') || p === '..')) throw new Error('That folder name can\'t be used.')
    return f
  }

  // ---------------------------------------------------------------- songs
  async function list() {
    const metadata = store.getMetadata()
    const playing = playingKey()
    const queued = new Set(store.getQueue().tracks || [])
    return (await files()).map((f) => {
      const meta = metadata[f.key] || {}
      const d = describeFile(f, meta)
      return {
        k: f.key,
        f: f.filename,
        folder: f.folder,
        t: d.title,
        a: d.artist,
        d: d.decade,
        sure: meta.confidence === 'manual' || meta.confidence === 'high' || Boolean(guessArtistTitle(f.filename).artist),
        named: meta.confidence === 'manual',
        dur: Math.round(f.duration || 0),
        size: f.size,
        th: Boolean(f.thumbPath),
        bad: Boolean(f.error || f.needsConversion),
        playing: f.key === playing,
        queued: queued.has(f.key),
      }
    }).sort((x, y) => x.t.localeCompare(y.t, undefined, { sensitivity: 'base' }) || x.a.localeCompare(y.a))
  }

  async function folders() {
    const root = mediaFolder()
    let names = []
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name) } catch { /* none */ }
    const decades = ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s']
    return { decades, folders: names.filter((n) => !DECADE_RE.test(n)).sort((a, b) => a.localeCompare(b)) }
  }

  // Rename a song ("Artist - Title.mp4") and/or move it to another folder.
  // The typed name is kept as the song's tag, so the picker shows exactly it.
  async function edit({ key, artist, title, folder }, by) {
    const f = await fileFor(key)
    const a = cleanPart(artist)
    let t = cleanPart(title)
    if (!t) throw new Error('Type the song\'s name.')
    if (!a) t = t.replace(/\s+-+\s+/g, ' – ') // a dash would read as "Artist - Title"
    const destFolder = folderChoice(folder, f.folder)
    const ext = path.extname(f.filename)
    const dir = abs(destFolder)
    const to = freePath(dir, a ? `${a} - ${t}` : t, ext, f.path)

    const metadata = store.getMetadata()
    const before = metadata[f.key] || null
    const folderDecade = (destFolder.split('/')[0].match(DECADE_RE) || [])[0]
    const entry = {
      artist: a || 'Unknown',
      title: t,
      genre: (before && before.genre) || 'Unknown',
      decade: folderDecade || (before && before.decade) || 'Unknown',
      confidence: 'manual',
    }
    const same = path.resolve(to) === path.resolve(f.path)
    if (same && before && before.confidence === 'manual' && before.artist === entry.artist && before.title === entry.title && before.decade === entry.decade) {
      return { ok: true, key: f.key, message: 'Nothing changed.' }
    }
    let newKey = f.key
    if (!same) {
      moveFile(f.path, to)
      newKey = fileKey(to, f.size)
      library.remapFileKeys(new Map([[f.key, newKey]]))
    }
    const latest = store.getMetadata()
    latest[newKey] = entry
    writeJson(paths.metadata, latest)

    const moved = destFolder !== f.folder
    const label = path.basename(to) === f.filename
      ? `Changed the details of "${t}"`
      : `Renamed "${f.filename}" to "${path.basename(to)}"${moved ? ` in ${destFolder || 'the main folder'}` : ''}`
    const h = record({ type: 'edit', label, undo: { from: rel(to), to: rel(f.path), size: f.size, metaBefore: before } }, by)
    await changed({ pairs: newKey !== f.key ? { [f.key]: newKey } : {} })
    return { ok: true, key: newKey, message: label, historyId: h.id }
  }

  // Moves songs to another folder (a decade, the main folder...) keeping
  // their names. A decade folder becomes their decade.
  async function move(keys, folder, by) {
    const dest = folderChoice(folder, null)
    if (dest === null) throw new Error('Choose where to move them.')
    const dir = abs(dest)
    const wantKeys = new Set((Array.isArray(keys) ? keys : []).filter(isFileKey))
    if (!wantKeys.size) throw new Error('Nothing chosen to move.')
    const playing = playingKey()
    const folderDecade = (dest.split('/')[0].match(DECADE_RE) || [])[0]
    const metadata = store.getMetadata()
    const moves = []
    const remap = new Map()
    let skipped = 0
    for (const f of await files()) {
      if (!wantKeys.has(f.key)) continue
      if (f.folder === dest || f.key === playing) { skipped += 1; continue }
      const ext = path.extname(f.filename)
      const to = freePath(dir, path.basename(f.filename, ext), ext)
      try { moveFile(f.path, to) } catch { skipped += 1; continue }
      remap.set(f.key, fileKey(to, f.size))
      moves.push({ from: rel(f.path), to: rel(to), size: f.size })
      if (folderDecade) metadata[f.key] = { artist: 'Unknown', genre: 'Unknown', confidence: 'none', ...(metadata[f.key] || {}), decade: folderDecade }
    }
    if (!moves.length) throw new Error(skipped ? 'Those songs are already there (or one is playing right now).' : 'Those songs have moved or gone - refresh and try again.')
    writeJson(paths.metadata, metadata)
    library.remapFileKeys(remap)
    const where = dest || 'the main folder'
    const h = record({ type: 'moves', label: moves.length === 1 ? `Moved "${path.basename(moves[0].from)}" to ${where}` : `Moved ${moves.length} songs to ${where}`, detail: moves.slice(0, 60).map((m) => path.basename(m.from)), undo: { moves } }, by)
    await changed({ pairs: Object.fromEntries(remap) })
    return { ok: true, moved: moves.length, skipped, message: `Moved ${moves.length} song${moves.length === 1 ? '' : 's'} to ${where}.`, historyId: h.id }
  }

  // ---------------------------------------------------------------- delete
  // Takes songs out of the library into the holding folder. keepKey (for a
  // duplicate) takes each one's place in playlists and the queue.
  function holdOne(f, keepKey, playlists, metadata, keepFile = null) {
    const stamp = new Date(now()).toISOString().slice(0, 10)
    const held = path.join(holdDir(), `${stamp} ${crypto.randomBytes(3).toString('hex')} ${f.filename}`)
    moveFile(f.path, held)
    const places = []
    for (const p of playlists) {
      if (!isManual(p)) continue
      const idx = p.trackKeys.indexOf(f.key)
      if (idx < 0) continue
      const hadKeep = Boolean(keepKey && p.trackKeys.includes(keepKey))
      places.push({ id: p.id, idx, hadKeep })
      if (keepKey && !hadKeep) p.trackKeys[idx] = keepKey
      else p.trackKeys.splice(idx, 1)
      // the same song twice in one playlist
      while (p.trackKeys.indexOf(f.key) >= 0) p.trackKeys.splice(p.trackKeys.indexOf(f.key), 1)
    }
    const meta = metadata[f.key] || null
    // the kept copy inherits a better name than its own...
    if (keepKey && meta && (meta.confidence === 'manual' || meta.confidence === 'high')) {
      const keepMeta = metadata[keepKey]
      if (!keepMeta || (keepMeta.confidence !== 'manual' && keepMeta.confidence !== 'high')) metadata[keepKey] = { ...meta }
    }
    // ...and the decade / singer it lacks, so the picker loses neither
    if (keepFile) {
      const gone = describeFile(f, meta || {})
      const kept = describeFile(keepFile, metadata[keepKey] || {})
      const base = { artist: 'Unknown', genre: 'Unknown', decade: 'Unknown', confidence: 'none', ...(metadata[keepKey] || {}) }
      let patch = null
      if (!kept.decade && gone.decade) patch = { ...(patch || base), decade: gone.decade }
      if (!kept.artist && gone.artist && base.confidence !== 'manual') patch = { ...(patch || base), artist: gone.artist, confidence: 'high' }
      if (patch) metadata[keepKey] = patch
    }
    return { from: rel(f.path), held: path.basename(held), size: f.size, key: f.key, meta, places, keep: keepKey || null }
  }

  // plan: [{ key, keep }] - keep (a duplicate's kept copy) or null
  async function holdSongs(plan, { by = '', label = '' } = {}) {
    const playing = playingKey()
    const all = await files()
    const byKey = new Map(all.map((f) => [f.key, f]))
    const items = []
    const skipped = []
    const playlists = store.getPlaylists()
    const metadata = store.getMetadata()
    const seen = new Set()
    for (const { key, keep } of plan) {
      if (!isFileKey(key) || key === keep || seen.has(key)) continue
      seen.add(key)
      const f = byKey.get(key)
      if (!f || (keep && !byKey.has(keep))) continue
      if (key === playing) { skipped.push(`"${describeFile(f, metadata[key]).title}" is playing right now`); continue }
      items.push(holdOne(f, keep || null, playlists, metadata, keep ? byKey.get(keep) : null))
    }
    if (!items.length) throw new Error(skipped[0] ? `${skipped[0]} - try again after it finishes.` : 'Those songs have moved or gone - refresh and try again.')
    writeJson(paths.playlists, playlists)
    writeJson(paths.metadata, metadata)
    for (const it of items) library.purgeDerivedState(it.key)
    const names = items.map((it) => path.basename(it.from))
    const entry = record({
      type: 'delete',
      label: label || (items.length === 1 ? `Deleted "${names[0]}"` : `Deleted ${items.length} songs`),
      detail: names.slice(0, 60),
      undo: { items },
    }, by)
    await changed({
      removed: items.filter((it) => !it.keep).map((it) => it.key),
      pairs: Object.fromEntries(items.filter((it) => it.keep).map((it) => [it.key, it.keep])),
    })
    return { ok: true, removed: items.length, skipped, historyId: entry.id }
  }

  async function removeSongs(keys, by) {
    const plan = (Array.isArray(keys) ? keys : []).map((key) => ({ key, keep: null }))
    if (!plan.length) throw new Error('Nothing chosen to delete.')
    const r = await holdSongs(plan, { by })
    return { ...r, message: r.removed === 1 ? 'Deleted - it can be put back from History for 30 days.' : `Deleted ${r.removed} songs - they can be put back from History for 30 days.` }
  }

  // ---------------------------------------------------------------- undo
  async function undo(id, by) {
    const entry = history().find((e) => e.id === id)
    if (!entry) throw new Error('That change isn\'t in the history any more.')
    if (entry.undone) throw new Error('That change has already been undone.')
    if (entry.expired) throw new Error('That song was deleted for good after 30 days, so it can\'t come back.')
    const u = entry.undo || {}
    const pairs = {}
    if (entry.type === 'edit') {
      const from = abs(u.from)
      const to = abs(u.to)
      if (!fs.existsSync(from)) throw new Error('That song has been moved or deleted since, so this can\'t be undone.')
      if (fs.existsSync(to) && path.resolve(to) !== path.resolve(from)) throw new Error('Another song now has its old name, so this can\'t be undone.')
      const size = fs.statSync(from).size
      const oldKey = fileKey(from, size)
      let newKey = oldKey
      if (path.resolve(to) !== path.resolve(from)) {
        moveFile(from, to)
        newKey = fileKey(to, size)
        library.remapFileKeys(new Map([[oldKey, newKey]]))
        pairs[oldKey] = newKey
      }
      const metadata = store.getMetadata()
      if (u.metaBefore) metadata[newKey] = u.metaBefore
      else delete metadata[newKey]
      writeJson(paths.metadata, metadata)
    } else if (entry.type === 'delete') {
      const metadata = store.getMetadata()
      const playlists = store.getPlaylists()
      let back = 0
      for (const it of u.items || []) {
        const held = path.join(holdDir(), it.held)
        const to = abs(it.from)
        if (!fs.existsSync(held) || fs.existsSync(to)) continue
        moveFile(held, to)
        back += 1
        const key = fileKey(to, it.size)
        if (it.meta) metadata[key] = it.meta
        for (const place of it.places || []) {
          const p = playlists.find((x) => x.id === place.id)
          if (!p || p.trackKeys.includes(key)) continue
          const at = Math.min(place.idx, p.trackKeys.length)
          if (it.keep && !place.hadKeep && p.trackKeys[place.idx] === it.keep) p.trackKeys[place.idx] = key
          else p.trackKeys.splice(at, 0, key)
        }
      }
      if (!back) throw new Error('Those songs couldn\'t be put back (another file is in their place, or they\'re gone).')
      writeJson(paths.metadata, metadata)
      writeJson(paths.playlists, playlists)
    } else if (entry.type === 'moves') {
      const moves = []
      for (const m of u.moves || []) {
        const from = abs(m.to)
        const to = abs(m.from)
        if (!fs.existsSync(from) || fs.existsSync(to)) continue
        moveFile(from, to)
        moves.push([fileKey(from, m.size), fileKey(to, m.size)])
      }
      library.remapFileKeys(new Map(moves))
      Object.assign(pairs, Object.fromEntries(moves))
    } else if (entry.type === 'playlist') {
      const playlists = store.getPlaylists()
      let next = playlists
      for (const before of u.restore || []) {
        const idx = next.findIndex((p) => p.id === before.id)
        if (idx >= 0) next[idx] = before
        else next.push(before)
      }
      next = next.filter((p) => !(u.remove || []).includes(p.id))
      writeJson(paths.playlists, next)
      setHistory(id, { undone: true, undoneAt: now(), undoneBy: by || '' })
      playlistsChanged()
      return { ok: true, message: `Undone: ${entry.label}` }
    } else {
      throw new Error('That change can\'t be undone.')
    }
    setHistory(id, { undone: true, undoneAt: now(), undoneBy: by || '' })
    await changed({ pairs })
    return { ok: true, message: `Undone: ${entry.label}` }
  }

  // Deleted songs older than 30 days are deleted for good.
  function purgeExpired() {
    let dir
    try { dir = holdDir() } catch { return 0 }
    const cutoff = now() - KEEP_DELETED_DAYS * 86400000
    let gone = 0
    let names = []
    try { names = fs.readdirSync(dir) } catch { return 0 }
    for (const name of names) {
      const day = Date.parse((name.match(/^(\d{4}-\d{2}-\d{2}) /) || [])[1] || '')
      if (!day || day > cutoff) continue
      try { fs.rmSync(path.join(dir, name), { force: true }); gone += 1 } catch { /* next time */ }
    }
    if (gone) {
      const h = history().map((e) => (e.type === 'delete' && !e.undone && e.at < cutoff ? { ...e, expired: true } : e))
      writeJson(STATE.history, h)
    }
    return gone
  }

  function historyList() {
    const cutoff = now() - KEEP_DELETED_DAYS * 86400000
    return history().map(({ undo: u, ...e }) => ({
      ...e,
      canUndo: !e.undone && !e.expired && !(e.type === 'delete' && e.at < cutoff),
    }))
  }

  // ---------------------------------------------------------------- playlists
  function playlistRows() {
    return store.getPlaylists().map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.autoFolder ? 'folder' : p.autoArtist ? 'artist' : 'mine',
      folder: p.folderPath || '',
      hidden: Boolean(p.hidden),
      keys: p.trackKeys,
    }))
  }
  function cleanName(name) {
    const n = cleanPart(name, 60)
    if (!n) throw new Error('Give the playlist a name.')
    return n
  }
  async function cleanKeys(keys) {
    const known = new Set((await files()).map((f) => f.key))
    const out = []
    for (const k of Array.isArray(keys) ? keys : []) if (known.has(k) && !out.includes(k)) out.push(k)
    return out
  }
  // One playlist action. Folder and artist playlists can't be changed here
  // (they follow the files) - copy one to make it editable.
  async function playlistAction(body, by) {
    const playlists = store.getPlaylists()
    const find = (id) => {
      const p = playlists.find((x) => x.id === id)
      if (!p) throw new Error('That playlist has gone - refresh and try again.')
      return p
    }
    const mine = (id) => {
      const p = find(id)
      if (!isManual(p)) throw new Error('Folder and artist playlists follow the songs\' folders and names. Copy it to your own playlist to change it.')
      return p
    }
    let label
    const undoInfo = { restore: [], remove: [] }
    let id = body.id
    if (body.action === 'create' || body.action === 'copy') {
      const from = body.action === 'copy' ? find(body.id) : null
      const p = { id: crypto.randomUUID(), name: cleanName(body.name || (from ? `${from.name} (copy)` : '')), trackKeys: from ? [...from.trackKeys] : await cleanKeys(body.keys) }
      playlists.push(p)
      id = p.id
      undoInfo.remove.push(p.id)
      label = from ? `Copied "${from.name}" to a new playlist "${p.name}"` : `Made a new playlist "${p.name}"`
    } else if (body.action === 'rename') {
      const p = mine(body.id)
      undoInfo.restore.push({ ...p, trackKeys: [...p.trackKeys] })
      const old = p.name
      p.name = cleanName(body.name)
      label = `Renamed playlist "${old}" to "${p.name}"`
    } else if (body.action === 'set-songs') {
      const p = mine(body.id)
      undoInfo.restore.push({ ...p, trackKeys: [...p.trackKeys] })
      const before = p.trackKeys.length
      p.trackKeys = await cleanKeys(body.keys)
      const diff = p.trackKeys.length - before
      label = diff > 0 ? `Added ${diff} song${diff === 1 ? '' : 's'} to "${p.name}"`
        : diff < 0 ? `Took ${-diff} song${diff === -1 ? '' : 's'} out of "${p.name}"`
        : `Changed the order of "${p.name}"`
    } else if (body.action === 'delete') {
      const p = mine(body.id)
      undoInfo.restore.push(p)
      playlists.splice(playlists.indexOf(p), 1)
      label = `Deleted playlist "${p.name}"`
    } else if (body.action === 'make-normal') {
      const made = makeNormal(playlists, [body.id])
      if (!made.length) throw new Error('That one is already a normal playlist.')
      undoInfo.restore.push(...made.map((m) => m.before))
      undoInfo.remove.push(...made.map((m) => m.newId))
      label = `Turned folder "${made[0].name}" into a normal playlist`
    } else {
      throw new Error('Unknown playlist action.')
    }
    writeJson(paths.playlists, playlists)
    const h = record({ type: 'playlist', label, undo: undoInfo }, by)
    playlistsChanged()
    return { ok: true, id, message: label, historyId: h.id }
  }

  // A folder of copies (Favourites...) becomes a normal playlist with the
  // same songs, and the folder's own playlist is hidden - so its copies can
  // be deleted without the playlist losing them. Mutates `playlists`.
  function makeNormal(playlists, ids) {
    const made = []
    for (const id of ids) {
      const p = playlists.find((x) => x.id === id && x.autoFolder && !x.hidden)
      if (!p) continue
      const before = { ...p, trackKeys: [...p.trackKeys] }
      const taken = new Set(playlists.filter(isManual).map((x) => x.name.toLowerCase()))
      let name = p.name
      if (taken.has(name.toLowerCase())) name = `${p.name} (playlist)`
      const copy = { id: crypto.randomUUID(), name, trackKeys: [...p.trackKeys], fromFolder: p.folderPath }
      playlists.push(copy)
      p.hidden = true
      made.push({ name: p.name, newId: copy.id, before })
    }
    return made
  }
  // ---------------------------------------------------------------- duplicates
  const qualityCache = () => readJson(STATE.quality, {})
  let probing = null // { done, total }
  function probeOne(file) {
    return new Promise((resolve) => {
      if (!ffmpegPath) return resolve(null)
      execFile(ffmpegPath, ['-hide_banner', '-i', file], { timeout: 15000 }, (_err, _out, stderr) => {
        const m = /Video:.*?\b(\d{2,5})x(\d{2,5})\b/.exec(String(stderr || ''))
        resolve(m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 0, h: 0 })
      })
    })
  }
  // Picture size of every copy in a duplicate group, a few at a time in the
  // background (about 1,500 files on the venue PC), remembered for good.
  async function probeAll(list) {
    if (probing || !ffmpegPath) return
    const cache = qualityCache()
    const todo = list.filter((f) => !cache[f.key])
    if (!todo.length) return
    probing = { done: 0, total: todo.length }
    try {
      for (let i = 0; i < todo.length; i += 2) {
        const batch = todo.slice(i, i + 2)
        const out = await Promise.all(batch.map((f) => probeOne(f.path)))
        const latest = qualityCache()
        batch.forEach((f, j) => { if (out[j]) latest[f.key] = out[j] })
        writeJson(STATE.quality, latest)
        probing.done = Math.min(todo.length, i + 2)
      }
    } finally {
      probing = null
    }
  }

  function score(item) {
    const bitrate = item.dur > 0 ? (item.size * 8) / item.dur / 1000 : 0 // kbit/s
    return (item.h || 0) * 10 + Math.min(bitrate, 8000) / 40 +
      (item.hasArtist ? 120 : 0) + (item.named ? 200 : 0) + (DECADE_RE.test(item.folder.split('/')[0]) ? 15 : 0) -
      (lyricVideo(item.f) ? 400 : 0) - (item.bad ? 5000 : 0)
  }
  function keepReason(keep, items) {
    const best = Math.max(...items.map((i) => i.h || 0))
    const others = items.filter((i) => i !== keep)
    if (keep.h && keep.h === best && others.some((i) => (i.h || 0) < keep.h)) return `Best picture (${keep.h}p)`
    if (others.every((i) => i.size === keep.size)) return keep.named ? 'Exact copies - keeping the one you named' : 'Exact copies - keeping the best-placed one'
    if (others.some((i) => lyricVideo(i.f)) && !lyricVideo(keep.f)) return 'The real video (the other is a lyric video)'
    if (others.every((i) => !i.hasArtist) && keep.hasArtist) return 'Has the singer or band in its name'
    return 'Best picture and sound'
  }

  // Copies of the same song: same title (ignoring brackets, "1"/"2",
  // punctuation), the same singer/band when both are known, and about the
  // same length (a live version or a remix is a different song).
  async function duplicates() {
    const all = await files()
    const metadata = store.getMetadata()
    const quality = qualityCache()
    const ignored = new Set(readJson(STATE.ignored, []))
    const playing = playingKey()
    const byTitle = new Map()
    for (const f of all) {
      const meta = metadata[f.key] || {}
      const d = describeFile(f, meta)
      const tk = titleKey(d.title)
      if (!tk) continue
      const item = {
        k: f.key, f: f.filename, folder: f.folder, t: d.title, a: d.artist, d: d.decade,
        dur: Math.round(f.duration || 0), size: f.size, th: Boolean(f.thumbPath),
        bad: Boolean(f.error || f.needsConversion),
        hasArtist: Boolean(guessArtistTitle(f.filename).artist),
        named: meta.confidence === 'manual',
        // a looked-up artist from a title-only search is only a guess
        artistKey: meta.confidence === 'low' || meta.confidence === 'none' ? mainArtist(guessArtistTitle(f.filename).artist) : mainArtist(d.artist),
        w: (quality[f.key] || {}).w || 0,
        h: (quality[f.key] || {}).h || 0,
        playing: f.key === playing,
        path: f.path,
      }
      if (!byTitle.has(tk)) byTitle.set(tk, [])
      byTitle.get(tk).push(item)
    }

    const groups = []
    for (const items of byTitle.values()) {
      if (items.length < 2) continue
      // one cluster per singer/band; a copy with no known singer joins the
      // cluster whose length matches it best
      const clusters = []
      for (const it of items.filter((i) => i.artistKey)) {
        const c = clusters.find((x) => sameArtist(x.artistKey, it.artistKey))
        if (c) c.items.push(it)
        else clusters.push({ artistKey: it.artistKey, items: [it] })
      }
      for (const it of items.filter((i) => !i.artistKey)) {
        const near = (c) => Math.min(...c.items.map((x) => (x.dur && it.dur ? Math.abs(x.dur - it.dur) : 999)))
        const best = clusters.slice().sort((a, b) => near(a) - near(b))[0]
        if (best && (near(best) <= 30 || clusters.length === 1)) best.items.push(it)
        else clusters.push({ artistKey: '', items: [it] })
      }
      for (const c of clusters) {
        // split a cluster where lengths are far apart (live / extended)
        const sorted = c.items.slice().sort((a, b) => (a.dur || 0) - (b.dur || 0))
        let run = []
        const runs = [run]
        for (const it of sorted) {
          const last = run[run.length - 1]
          if (last && last.dur && it.dur && it.dur - last.dur > 40) { run = []; runs.push(run) }
          run.push(it)
        }
        for (const r of runs) {
          if (r.length < 2) continue
          const sig = r.map((i) => i.k).sort().join(',')
          if (ignored.has(sig)) continue
          const exact = r.every((i) => i.size === r[0].size && Math.abs((i.dur || 0) - (r[0].dur || 0)) <= 1)
          const sameSinger = r.some((i) => i.artistKey)
          const durs = r.map((i) => i.dur).filter(Boolean)
          const closeLength = durs.length === r.length && Math.max(...durs) - Math.min(...durs) <= 12
          const keep = r.slice().sort((a, b) => score(b) - score(a))[0]
          groups.push({
            id: sig,
            title: keep.t,
            artist: (r.find((i) => i.a && i.artistKey) || keep).a,
            how: exact ? 'exact' : sameSinger && closeLength ? 'likely' : 'check',
            keep: keep.k,
            reason: keepReason(keep, r),
            items: r.sort((a, b) => (a.k === keep.k ? -1 : b.k === keep.k ? 1 : score(b) - score(a))).map(({ path: _p, artistKey: _a, ...rest }) => rest),
          })
        }
      }
    }
    const order = { exact: 0, likely: 1, check: 2 }
    groups.sort((a, b) => order[a.how] - order[b.how] || a.title.localeCompare(b.title))

    // folders that are playlists made of copies, still shown as folder playlists
    const inGroups = new Set(groups.flatMap((g) => g.items.map((i) => i.folder.split('/')[0])))
    const copyFolders = store.getPlaylists()
      .filter((p) => p.autoFolder && !p.hidden && !p.folderPath.includes('/') && !/\d0'?s\b/i.test(p.folderPath) && inGroups.has(p.folderPath))
      .map((p) => ({ id: p.id, name: p.name, n: p.trackKeys.length }))

    const needProbe = all.filter((f) => groups.some((g) => g.items.some((i) => i.k === f.key)))
    probeAll(needProbe).catch(() => {})
    return {
      groups,
      copyFolders,
      probing: probing ? { ...probing } : null,
      totals: { groups: groups.length, extra: groups.reduce((s, g) => s + g.items.length - 1, 0), exact: groups.filter((g) => g.how === 'exact').length },
    }
  }

  async function resolveDuplicate({ keep, remove }, by) {
    if (!isFileKey(keep)) throw new Error('Choose the copy to keep.')
    const f = await fileFor(keep)
    const plan = (Array.isArray(remove) ? remove : []).map((key) => ({ key, keep }))
    if (!plan.length) throw new Error('Nothing chosen to delete.')
    const title = describeFile(f, store.getMetadata()[keep]).title
    const r = await holdSongs(plan, { by, label: `Removed ${plan.length} extra cop${plan.length === 1 ? 'y' : 'ies'} of "${title}"` })
    return { ...r, message: `Kept the best copy of "${title}". The other${r.removed === 1 ? ' is' : 's are'} in History for 30 days.` }
  }

  // Every "exact copies" group at once, keeping the suggested copy of each.
  async function removeAllExact(by) {
    const { groups } = await duplicates()
    const exact = groups.filter((g) => g.how === 'exact' && !g.items.some((i) => i.playing))
    if (!exact.length) throw new Error('There are no exact copies left.')
    const plan = exact.flatMap((g) => g.items.filter((i) => i.k !== g.keep).map((i) => ({ key: i.k, keep: g.keep })))
    const r = await holdSongs(plan, { by, label: `Removed ${plan.length} exact copies of ${exact.length} songs` })
    return { ...r, message: `Removed ${r.removed} exact copies of ${exact.length} songs. They're in History for 30 days.` }
  }

  function ignoreDuplicate(keys) {
    const sig = (keys || []).filter(isFileKey).sort().join(',')
    if (!sig) throw new Error('Nothing to ignore.')
    const list = readJson(STATE.ignored, [])
    if (!list.includes(sig)) list.push(sig)
    writeJson(STATE.ignored, list)
    return { ok: true }
  }

  async function makeFoldersNormal(ids, by) {
    const playlists = store.getPlaylists()
    const made = makeNormal(playlists, ids || [])
    if (!made.length) return { ok: true, made: 0 }
    writeJson(paths.playlists, playlists)
    const h = record({
      type: 'playlist',
      label: `Turned ${made.map((m) => `"${m.name}"`).join(', ')} into normal playlist${made.length === 1 ? '' : 's'}`,
      undo: { restore: made.map((m) => m.before), remove: made.map((m) => m.newId) },
    }, by)
    playlistsChanged()
    return { ok: true, made: made.length, historyId: h.id, message: `${made.map((m) => m.name).join(', ')} ${made.length === 1 ? 'is now a normal playlist' : 'are now normal playlists'} - deleting their copies won't take songs out.` }
  }

  // ---------------------------------------------------------------- sort into decades
  // Looks up each song's original year (the earliest release of that song
  // by that singer/band on iTunes - a music video's own date is often a
  // re-release years later), then, when asked, moves them all at once into
  // decade folders. Songs with no singer/band in their name are left alone:
  // a title on its own matches the wrong song too often.
  let sortJob = null // { folders, state: 'looking'|'ready'|'stopped'|'moving'|'done', done, total, found:{key:decade}, skipped, error }
  const decadeCache = () => readJson(STATE.decades, {})

  async function lookupDecade(artist, title) {
    const ck = `${mainArtist(artist)}|${titleKey(title)}`
    const cache = decadeCache()
    if (cache[ck] !== undefined) return { decade: cache[ck], cached: true }
    const term = `${String(artist).split(/\s+(?:ft|feat|featuring)\.?\s+/i)[0]} ${title}`
    const res = await fetchImpl(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=25`, { signal: AbortSignal.timeout(15000) })
    if (res.status === 403 || res.status === 429) { const e = new Error('slow down'); e.slowDown = true; throw e }
    const data = await res.json()
    const wantArtist = mainArtist(artist)
    const wantTitle = titleKey(title)
    let year = 0
    for (const r of (data && data.results) || []) {
      if (!sameArtist(mainArtist(r.artistName), wantArtist)) continue
      const t = titleKey(r.trackName)
      if (!(t === wantTitle || (wantTitle.length >= 5 && (t.startsWith(wantTitle) || wantTitle.startsWith(t))))) continue
      const y = new Date(r.releaseDate).getFullYear()
      if (y > 1900 && (!year || y < year)) year = y
    }
    const decade = year ? `${Math.floor(year / 10) * 10}s` : ''
    const latest = decadeCache()
    latest[ck] = decade
    writeJson(STATE.decades, latest)
    return { decade, cached: false }
  }

  const wait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })

  async function startSort(folderList) {
    if (sortJob && (sortJob.state === 'looking' || sortJob.state === 'moving')) throw new Error('A sort is already running.')
    const chosen = (Array.isArray(folderList) ? folderList : []).map((f) => folderChoice(f, ''))
    if (!folderList || !folderList.length) throw new Error('Choose at least one folder to sort.')
    const all = await files()
    const metadata = store.getMetadata()
    const todo = all.filter((f) => {
      const top = f.folder.split('/')[0]
      return !DECADE_RE.test(top) && chosen.some((c) => (c === '' ? f.folder === '' : top === c))
    })
    sortJob = { folders: chosen, state: 'looking', done: 0, total: todo.length, found: {}, noArtist: 0, notFound: 0, error: '' }
    const job = sortJob
    ;(async () => {
      for (const f of todo) {
        if (job.state !== 'looking') return
        const meta = metadata[f.key] || {}
        const d = describeFile(f, meta)
        const trustedArtist = meta.confidence === 'manual' || meta.confidence === 'high' ? d.artist : guessArtistTitle(f.filename).artist
        if (meta.confidence === 'manual' && meta.decade && meta.decade !== 'Unknown') {
          job.found[f.key] = meta.decade
        } else if (!trustedArtist) {
          job.noArtist += 1
        } else {
          let tries = 0
          for (;;) {
            try {
              const r = await lookupDecade(trustedArtist, d.title)
              if (r.decade) job.found[f.key] = r.decade
              else job.notFound += 1
              if (!r.cached) { job.done += 1; await wait(lookupGapMs); job.done -= 1 }
              break
            } catch (err) {
              tries += 1
              if (tries >= 4) { job.notFound += 1; break }
              await wait(err.slowDown ? 60000 : 10000) // busy or offline - wait and try again
              if (job.state !== 'looking') return
            }
          }
        }
        job.done += 1
      }
      if (job.state === 'looking') job.state = 'ready'
    })().catch((err) => { job.state = 'stopped'; job.error = err.message })
    return sortStatus()
  }

  function sortStatus() {
    if (!sortJob) return { state: 'idle' }
    const byDecade = {}
    for (const d of Object.values(sortJob.found)) byDecade[d] = (byDecade[d] || 0) + 1
    const { found, ...rest } = sortJob
    return { ...rest, ready: Object.keys(found).length, byDecade }
  }
  function stopSort() {
    if (sortJob && sortJob.state === 'looking') sortJob.state = Object.keys(sortJob.found).length ? 'ready' : 'stopped'
    return sortStatus()
  }

  // Moves every song the lookup found into its decade folder, in one go.
  async function applySort(by) {
    if (!sortJob || !['ready', 'stopped'].includes(sortJob.state) || !Object.keys(sortJob.found).length) throw new Error('There\'s nothing found to move yet.')
    const job = sortJob
    job.state = 'moving'
    try {
      const root = mediaFolder()
      const all = await files()
      const byKey = new Map(all.map((f) => [f.key, f]))
      const playing = playingKey()
      const metadata = store.getMetadata()
      const moves = []
      const remap = new Map()
      for (const [key, decade] of Object.entries(job.found)) {
        const f = byKey.get(key)
        if (!f || key === playing || !DECADE_RE.test(decade)) continue
        const ext = path.extname(f.filename)
        const to = freePath(path.join(root, decade), path.basename(f.filename, ext), ext)
        try { moveFile(f.path, to) } catch { continue }
        const newKey = fileKey(to, f.size)
        remap.set(key, newKey)
        moves.push({ from: rel(f.path), to: rel(to), size: f.size })
        // the folder's decade wins over an older looked-up guess
        metadata[key] = { artist: 'Unknown', genre: 'Unknown', confidence: 'none', ...(metadata[key] || {}), decade }
      }
      writeJson(paths.metadata, metadata)
      library.remapFileKeys(remap)
      const h = record({ type: 'moves', label: `Sorted ${moves.length} songs into decade folders`, undo: { moves } }, by)
      job.state = 'done'
      job.moved = moves.length
      await changed({ pairs: Object.fromEntries(remap) })
      return { ok: true, moved: moves.length, message: `Moved ${moves.length} songs into decade folders.`, historyId: h.id }
    } catch (err) {
      job.state = 'ready'
      throw err
    }
  }

  return {
    list,
    folders,
    edit,
    move,
    removeSongs,
    undo,
    purgeExpired,
    history: historyList,
    playlists: playlistRows,
    playlistAction,
    duplicates,
    resolveDuplicate,
    removeAllExact,
    ignoreDuplicate,
    makeFoldersNormal,
    startSort,
    stopSort,
    sortStatus,
    applySort,
    lookupDecade,
    HOLD_DIR,
  }
}

module.exports = { createLibraryManager, normWords, titleKey, mainArtist, HOLD_DIR }
