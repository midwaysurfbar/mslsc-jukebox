const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createMetadata } = require('../lib/metadata')
const { createWebAds } = require('../lib/web-ads')
const { setup } = require('./helpers')

const KEY_A = 'a'.repeat(32)
const KEY_B = 'b'.repeat(32)
const json = (body) => ({ ok: true, json: async () => body, arrayBuffer: async () => new ArrayBuffer(3) })

test('iTunes lookup: confident with an artist in the filename, cached', async (t) => {
  const { store, library } = setup(t)
  let calls = 0
  const metadata = createMetadata({ store, library, fetchImpl: async () => { calls += 1; return json({ results: [{ artistName: 'Queen', primaryGenreName: 'Rock', releaseDate: '1984-01-01' }] }) } })
  const entry = await metadata.lookup(KEY_A, 'Queen - Radio Ga Ga.mp4')
  assert.deepEqual(entry, { artist: 'Queen', genre: 'Rock', decade: '1980s', confidence: 'high' })
  await metadata.lookup(KEY_A, 'Queen - Radio Ga Ga.mp4')
  assert.equal(calls, 1, 'second lookup comes from the cache')
  const low = await metadata.lookup(KEY_B, 'Radio Ga Ga.mp4')
  assert.equal(low.confidence, 'low')
})

test('offline lookups are not cached, so they retry later', async (t) => {
  const { store, library } = setup(t)
  const metadata = createMetadata({ store, library, fetchImpl: async () => { throw new Error('offline') } })
  const entry = await metadata.lookup(KEY_A, 'Toto - Africa.mp4')
  assert.equal(entry.offline, true)
  assert.equal(entry.artist, 'Toto')
  assert.deepEqual(store.getMetadata(), {})
})

test('a tag typed by hand during a lookup is never lost', async (t) => {
  const { store, library } = setup(t)
  let release
  const gate = new Promise((r) => { release = r })
  const metadata = createMetadata({ store, library, fetchImpl: async () => { await gate; return json({ results: [] }) } })
  const pending = metadata.lookup(KEY_A, 'Toto - Africa.mp4')
  await metadata.setManual(KEY_B, { artist: 'Hand Tagged', genre: 'Rock', decade: '1980s' })
  release()
  await pending
  const cache = store.getMetadata()
  assert.equal(cache[KEY_B].artist, 'Hand Tagged')
  assert.equal(cache[KEY_B].confidence, 'manual')
  assert.ok(cache[KEY_A])
})

test('a hand tag of the SAME song during its lookup wins', async (t) => {
  const { store, library } = setup(t)
  let release
  const gate = new Promise((r) => { release = r })
  const metadata = createMetadata({ store, library, fetchImpl: async () => { await gate; return json({ results: [{ artistName: 'Wrong Guess' }] }) } })
  const pending = metadata.lookup(KEY_A, 'Toto - Africa.mp4')
  await metadata.setManual(KEY_A, { artist: 'Toto', genre: 'Rock', decade: '1980s' })
  release()
  assert.equal((await pending).artist, 'Toto')
  assert.equal(store.getMetadata()[KEY_A].artist, 'Toto')
})

test('ad sync downloads new ads, removes deleted ones, ignores unsafe names', async (t) => {
  const { store } = setup(t)
  fs.mkdirSync(store.paths.webAds, { recursive: true })
  fs.writeFileSync(path.join(store.paths.webAds, 'old-ad.jpg'), 'x')
  const fetched = []
  const fetchImpl = async (url, options) => {
    if (options) {
      return json({ ok: true, files: [
        { path: '1700000000-quiz.jpg', url: 'https://ads/quiz', jukeboxSeconds: 8, jukeboxSizePct: 90 },
        { path: '../../escape.jpg', url: 'https://ads/escape' },
        { path: 'sub/dir.jpg', url: 'https://ads/sub' },
      ] })
    }
    fetched.push(url)
    return json({})
  }
  const ads = createWebAds({ store, fetchImpl })
  const [first, second] = await Promise.all([ads.sync(), ads.sync()])
  assert.equal(first, second, 'two syncs at once share one pass')
  assert.deepEqual(first, { ok: true, downloaded: 1, removed: 1, total: 1 })
  assert.deepEqual(fetched, ['https://ads/quiz'])
  assert.deepEqual(fs.readdirSync(store.paths.webAds), ['1700000000-quiz.jpg'])
  assert.deepEqual(store.readJson(store.paths.webAdsMetadata, null), { '1700000000-quiz.jpg': { seconds: 8, sizePct: 90 } })
})

test('ad sync failing (offline) keeps the ads already downloaded', async (t) => {
  const { store } = setup(t)
  fs.mkdirSync(store.paths.webAds, { recursive: true })
  fs.writeFileSync(path.join(store.paths.webAds, 'keep.jpg'), 'x')
  const ads = createWebAds({ store, fetchImpl: async () => { throw new Error('offline') } })
  assert.equal((await ads.sync()).ok, false)
  assert.deepEqual(fs.readdirSync(store.paths.webAds), ['keep.jpg'])
})
