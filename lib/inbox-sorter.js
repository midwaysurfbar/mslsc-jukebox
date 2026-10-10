// "New Suggestions" inbox (Sam, 2026-10-10). Music videos downloaded on the
// laptops arrive here over Syncthing. Once a video has fully arrived, it's
// looked up (same decade lookup as Sort Unsorted by Decade) and moved into
// its decade folder - "1980s" etc. - or, with no confident match, into the
// main Music Videos folder where Sort Unsorted by Decade can try again later.
// Either way the inbox ends up empty. Moving keeps everything that points at
// the song (tags, playlists, queue) - see library.moveFileTo.
const fs = require('node:fs')
const path = require('node:path')
const { fileKey, VIDEO_EXTENSIONS } = require('./library')

const INBOX_NAME = 'New Suggestions'
const STABLE_MS = 20 * 1000 // size unchanged this long = finished arriving

function createInboxSorter({ store, library, metadata, onMoved = () => {}, now = () => Date.now() }) {
  const seen = new Map() // full path -> { size, since }
  let running = false

  async function run() {
    if (running) return 0
    running = true
    let moved = 0
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

        const meta = await metadata.lookup(fileKey(full, size), name)
        if (meta.offline) continue // no internet - try again on the next pass
        const confident = meta.decade && meta.decade !== 'Unknown' && (meta.confidence === 'high' || meta.confidence === 'manual')
        try {
          library.moveFileTo(full, size, confident ? path.join(mediaFolder, meta.decade) : mediaFolder)
          moved += 1
        } catch (err) {
          console.error('[inbox] could not move', name, err.message)
        }
        seen.delete(full)
      }
    } finally {
      running = false
    }
    if (moved) onMoved(moved)
    return moved
  }

  return { run, INBOX_NAME }
}

module.exports = { createInboxSorter, INBOX_NAME }
