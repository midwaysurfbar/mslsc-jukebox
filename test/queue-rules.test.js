const test = require('node:test')
const assert = require('node:assert/strict')
const { buildDisplayQueue, canMoveQueueItem, removeQueueItemAt, checkSongRequest } = require('../shared/queue-rules')

test('display queue keeps one entry per position, with a stand-in for a missing file', () => {
  const library = { a: { key: 'a', path: '/a.mp4' }, c: { key: 'c', path: '/c.mp4' } }
  const out = buildDisplayQueue(['a', 'gone', 'c'], (k) => library[k], (t) => ({ ...t, path: t.path.toUpperCase() }))
  assert.equal(out.length, 3)
  assert.equal(out[0].path, '/A.MP4')
  assert.deepEqual(out[1], { key: 'gone', filename: '(file no longer in the library)', path: '', missing: true })
  assert.equal(out[2].key, 'c') // still at position 2 - nothing shifted
})

test('the song on screen cannot be moved, and nothing can move into its place', () => {
  // queue of 5, song 1 playing
  assert.equal(canMoveQueueItem(1, -1, 5, 1, true), false) // playing song up
  assert.equal(canMoveQueueItem(1, 1, 5, 1, true), false) // playing song down
  assert.equal(canMoveQueueItem(2, -1, 5, 1, true), false) // next song up into its place
  assert.equal(canMoveQueueItem(2, 1, 5, 1, true), true)
  assert.equal(canMoveQueueItem(3, -1, 5, 1, true), true)
  assert.equal(canMoveQueueItem(4, 1, 5, 1, true), false) // off the end
  // nothing on screen: anything moves within bounds
  assert.equal(canMoveQueueItem(1, -1, 5, 1, false), true)
  assert.equal(canMoveQueueItem(0, -1, 5, 0, false), false)
})

test('removing the playing song restarts at its position; later songs just update', () => {
  const q = { tracks: ['a', 'b', 'c', 'd'], currentIndex: 1 }
  assert.deepEqual(removeQueueItemAt(q, 1, true), { queue: { tracks: ['a', 'c', 'd'], currentIndex: 1 }, display: 'restart' })
  assert.deepEqual(removeQueueItemAt(q, 3, true), { queue: { tracks: ['a', 'b', 'c'], currentIndex: 1 }, display: 'update' })
  // an already-played song: the current position follows its song
  assert.deepEqual(removeQueueItemAt(q, 0, true), { queue: { tracks: ['b', 'c', 'd'], currentIndex: 0 }, display: 'none' })
  // idle: removing the song at currentIndex isn't a restart
  assert.equal(removeQueueItemAt(q, 1, false).display, 'none')
  assert.deepEqual(q.tracks, ['a', 'b', 'c', 'd'], 'the input queue is not changed')
})

test('song request rules', () => {
  const base = { track: { key: 'x' }, key: 'x', waitingKeys: [], playingKey: null, lastStartedAt: undefined, now: 1_000_000_000, maxWaiting: 20, repeatMinutes: 10 }
  assert.deepEqual(checkSongRequest(base), { ok: true, position: 1 })
  assert.deepEqual(checkSongRequest({ ...base, waitingKeys: ['a', 'b'] }), { ok: true, position: 3 })
  assert.equal(checkSongRequest({ ...base, track: undefined }).reason, 'unavailable')
  assert.equal(checkSongRequest({ ...base, track: { needsConversion: true } }).reason, 'unavailable')
  assert.equal(checkSongRequest({ ...base, track: { error: true } }).reason, 'unavailable')
  assert.equal(checkSongRequest({ ...base, waitingKeys: Array.from({ length: 20 }, (_, i) => `k${i}`) }).reason, 'full')
  assert.equal(checkSongRequest({ ...base, waitingKeys: ['x'] }).reason, 'queued')
  assert.equal(checkSongRequest({ ...base, playingKey: 'x' }).reason, 'queued')
  // started 4 minutes ago: 6 minutes to wait
  assert.deepEqual(checkSongRequest({ ...base, lastStartedAt: base.now - 4 * 60000 }), { ok: false, reason: 'recent', minutes: 6 })
  // exactly 10 minutes ago: allowed again
  assert.equal(checkSongRequest({ ...base, lastStartedAt: base.now - 10 * 60000 }).ok, true)
  // full wins over everything else
  assert.equal(checkSongRequest({ ...base, waitingKeys: Array.from({ length: 25 }, () => 'x') }).reason, 'full')
})
