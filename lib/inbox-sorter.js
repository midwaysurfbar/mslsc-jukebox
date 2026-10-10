// "New Suggestions" inbox (Sam, 2026-10-10). Music videos downloaded on the
// laptops arrive here over Syncthing. Once a video has fully arrived, it's
// looked up (same decade lookup as Sort Unsorted by Decade) and moved into
// its decade folder - "1980s" etc. - or, with no confident match, into the
// main Music Videos folder where Sort Unsorted by Decade can try again later.
// Either way the inbox ends up empty.
//
// The decade (Sam, 2026-10-11) comes from the Library Manager's song
// look-up - the earliest release of that song by that singer/band - when
// lookupDecade is given (main.js does). A music video's own iTunes date is
// often a re-release years later (The Chain landed in 1990s that way). Moving keeps everything that points at
// the song (tags, playlists, queue) - see library.moveFileTo.
const fs = require('node:fs')
const path = require('node:path')
const { fileKey, VIDEO_EXTENSIONS } = require('./library')
const { guessArtistTitle } = require('../shared/names')

const INBOX_NAME = 'New Suggestions'
const STABLE_MS = 20 * 1000 // size unchanged this long = finished arriving

function createInboxSorter({ store, library, metadata, lookupDecade = null, onMoved = () => {}, now = () => Date.now() }) {
  const seen = new Map() // full path -> { size, since }
  let running = false

  async function run() {
    if (running) return 0
    running = true
    let moved = 0
    const songs = [] // { title, artist } of everything moved - ticks off matching suggestions
    try {
      const mediaFolder = store.getSettings().mediaFolder
      if (!mediaFolder) return 0
      const inbox = path.join(mediaFolder, INBOX_NAME)
      let names
      try { names = fs.readdirSync(inbox, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) } catch { return 0 }
      for (const name of names) {
        if (name.startsWith('.') || !VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue
        // Syncthing writes ".syncthing.<name>.tmp" until a file is complete
        if (names.some((n) => n.startsWith(`.syncthing.${name}`))) continue
        const full = path.join(inbox, name)
        let size
        try { size = fs.statSync(full).size } catch { continue }
        const prev = seen.get(full)
        if (!prev || prev.size !== size) { seen.set(full, { size, since: now() }); continue }
        if (now() - prev.since < STABLE_MS) continue

        const key = fileKey(full, size)
        const meta = await metadata.lookup(key, name)
        if (meta.offline) continue // no internet - try again on the next pass
        let decade = meta.decade && meta.decade !== 'Unknown' && (meta.confidence === 'high' || meta.confidence === 'manual') ? meta.decade : ''
        if (lookupDecade) {
          const { artist, title } = guessArtistTitle(name)
          if (!artist) decade = '' // a title on its own too often matches the wrong song
          else {
            try { decade = (await lookupDecade(artist, title)).decade || '' } catch { continue } // offline or busy - next pass
          }
          // the tag says the same decade as the folder it's going into
          const all = store.getMetadata()
          if (decade || (all[key] && all[key].decade)) {
            all[key] = { artist: artist || 'Unknown', genre: 'Unknown', confidence: 'none', ...(all[key] || {}), decade: decade || 'Unknown' }
            store.writeJson(store.paths.metadata, all)
          }
        }
        try {
          library.moveFileTo(full, size, decade ? path.join(mediaFolder, decade) : mediaFolder)
          moved += 1
          const guess = guessArtistTitle(name)
          songs.push({ title: guess.title, artist: meta.artist && meta.artist !== 'Unknown' ? meta.artist : guess.artist })
        } catch (err) {
          console.error('[inbox] could not move', name, err.message)
        }
        seen.delete(full)
      }
    } finally {
      running = false
    }
    if (moved) onMoved(moved, songs)
    return moved
  }

  return { run, INBOX_NAME }
}

module.exports = { createInboxSorter, INBOX_NAME }
