// Artist / genre / decade tags: a best-effort iTunes lookup (cached for
// good, never needed for playback) plus tags typed by hand, which always
// win. `fetchImpl` is injectable so the tests never go to the internet.
const { guessArtistTitle } = require('../shared/names')
const { requireFileKey } = require('./library')

function createMetadata({ store, library, fetchImpl = (...args) => fetch(...args) }) {
  const { paths, writeJson } = store

  async function lookup(key, filename) {
    requireFileKey(key)
    const cache = store.getMetadata()
    if (cache[key]) return cache[key]

    const { artist, title } = guessArtistTitle(filename)
    const term = artist ? `${artist} ${title}` : title
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=musicVideo&limit=1`
      const response = await fetchImpl(url)
      const data = await response.json()
      const hit = data.results && data.results[0]
      const entry = hit
        ? {
            artist: hit.artistName || artist || 'Unknown',
            genre: hit.primaryGenreName || 'Unknown',
            decade: hit.releaseDate ? `${Math.floor(new Date(hit.releaseDate).getFullYear() / 10) * 10}s` : 'Unknown',
            confidence: artist ? 'high' : 'low',
          }
        : { artist: artist || 'Unknown', genre: 'Unknown', decade: 'Unknown', confidence: 'none' }
      // Re-read just before writing: the lookup can take a while, and a tag
      // saved by hand (or another lookup) in the meantime must not be lost.
      const latest = store.getMetadata()
      if (latest[key]) return latest[key]
      latest[key] = entry
      writeJson(paths.metadata, latest)
      return entry
    } catch {
      // Offline or unreachable - left uncached so it's retried next time.
      return { artist: artist || 'Unknown', genre: 'Unknown', decade: 'Unknown', confidence: 'none', offline: true }
    }
  }

  // A hand-typed tag, then the artist playlists re-synced straight away -
  // tagging exists so the band shows up in Playlists now, not "eventually".
  async function setManual(key, entry) {
    requireFileKey(key)
    const cache = store.getMetadata()
    cache[key] = { ...entry, confidence: 'manual' }
    writeJson(paths.metadata, cache)
    const mediaFolder = store.getSettings().mediaFolder
    const playlists = mediaFolder
      ? library.syncArtistPlaylists(await library.scanMediaFolder(mediaFolder))
      : store.getPlaylists()
    return { entry: cache[key], playlists }
  }

  return { lookup, setManual, getCache: () => store.getMetadata() }
}

module.exports = { createMetadata }
