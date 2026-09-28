const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createStore, readJson, writeJson } = require('../lib/store')
const { tempDir } = require('./helpers')

test('writeJson round-trips and leaves no temp file behind', (t) => {
  const dir = tempDir(t, 'store')
  const file = path.join(dir, 'nested', 'playlists.json')
  writeJson(file, [{ id: 1, name: 'Friday' }])
  writeJson(file, [{ id: 1, name: 'Friday' }, { id: 2, name: '80s' }])
  assert.deepEqual(readJson(file, null), [{ id: 1, name: 'Friday' }, { id: 2, name: '80s' }])
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['playlists.json'])
})

test('a torn or missing file reads as the fallback, never throws', (t) => {
  const dir = tempDir(t, 'store')
  const file = path.join(dir, 'queue.json')
  fs.writeFileSync(file, '{"tracks":["a","b"')
  assert.deepEqual(readJson(file, { tracks: [] }), { tracks: [] })
  assert.equal(readJson(path.join(dir, 'nope.json'), 'x'), 'x')
})

test('settings fill in defaults', (t) => {
  const store = createStore(tempDir(t, 'store'))
  assert.equal(store.getSettings().crossfadeSeconds, 3)
  store.writeJson(store.paths.settings, { volume: 0.5 })
  const s = store.getSettings()
  assert.equal(s.volume, 0.5)
  assert.equal(s.introVideoEnabled, true)
})

test('track info is written on flush', (t) => {
  const store = createStore(tempDir(t, 'store'))
  store.loadTrackInfo().abc = { duration: 200 }
  store.scheduleTrackInfoWrite()
  assert.equal(fs.existsSync(store.paths.trackInfo), false)
  store.flushTrackInfo()
  assert.deepEqual(readJson(store.paths.trackInfo, null), { abc: { duration: 200 } })
})
