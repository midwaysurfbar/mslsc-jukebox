// Test helpers: a throwaway data folder + media folder per test.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStore } = require('../lib/store')
const { createLibrary } = require('../lib/library')

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jukebox-${name}-`))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Writes `files` ({ 'relative/path.mp4': 'contents' }) under a new media
// folder and returns a store + library pointed at it.
function setup(t, files = {}, options = {}) {
  const userData = tempDir(t, 'data')
  const media = tempDir(t, 'media')
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(media, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  const store = createStore(userData)
  store.writeJson(store.paths.settings, { mediaFolder: media })
  const trashed = []
  const library = createLibrary(store, { trashItem: async (p) => { trashed.push(p); fs.rmSync(p) }, ...options })
  t.after(() => store.flushTrackInfo())
  return { store, library, media, userData, trashed }
}

module.exports = { tempDir, setup }
