const test = require('node:test')
const assert = require('node:assert/strict')
const { createYears, pickYear } = require('../lib/years')
const { describeFile } = require('../lib/library')
const { setup } = require('./helpers')
const key = (n) => (n === 'a.mp4' ? 'a'.repeat(32) : 'b'.repeat(32))

const row = (title, artist, first, score = 100) => ({ title, score, 'artist-credit': [{ name: artist }], 'first-release-date': first })

test('the earliest confident release is the song\'s year', () => {
  const rows = [row('Big In Japan', 'Alphaville', '1999-01-01'), row('Big In Japan', 'Alphaville', '1984-09-14'), row('Big In Japan', 'Tom Waits', '1981-01-01')]
  assert.equal(pickYear(rows, 'Alphaville', 'Big In Japan'), 1984)
})

test('wrong singer, wrong title or a weak match gives no year', () => {
  assert.equal(pickYear([row('Big In Japan', 'Tom Waits', '1981')], 'Alphaville', 'Big In Japan'), null)
  assert.equal(pickYear([row('Big In Japan (Remix)', 'Alphaville', '1999')], 'Alphaville', 'Big In Japan Live'), null)
  assert.equal(pickYear([row('Big In Japan', 'Alphaville', '1984', 50)], 'Alphaville', 'Big In Japan'), null)
  assert.equal(pickYear([row('Big In Japan', 'Alphaville', '1984')], '', 'Big In Japan'), null)
})

test('brackets, accents, "ft." and "Cover" do not stop a match', () => {
  assert.equal(pickYear([row('(Not Just) Knee Deep', 'Funkadelic', '1979')], 'Funkadelic', "'(Not Just) Knee Deep' (1979)"), 1979) // quotes and a bracketed year are ignored when matching
  assert.equal(pickYear([row('(Not Just) Knee Deep', 'Funkadelic', '1979')], 'Funkadelic', '(Not Just) Knee Deep'), 1979)
  assert.equal(pickYear([row('Big Girls Don\'t Cry', 'Fergie feat. Q-Tip', '2006')], 'Fergie ft. Q-Tip, GoonRock', "Big Girls Don't Cry"), 2006)
  assert.equal(pickYear([row('Aha!', 'Imogen Heap', '2005')], 'Imogen Heap Cover', 'Aha!'), 2005)
})

test('lookups are remembered, a failed one is retried later, and songs with no artist are skipped', async (t) => {
  const { store } = setup(t, {})
  const calls = []
  let fail = true
  const fetchImpl = async (url) => {
    calls.push(decodeURIComponent(url))
    if (fail) return { status: 500, ok: false }
    return { status: 200, ok: true, json: async () => ({ recordings: [row('Radio Ga Ga', 'Queen', '1984-01-23')] }) }
  }
  const years = createYears({ store, fetchImpl, gapMs: 0, retryMs: 0, busyMs: 0 })
  const songs = [{ k: key('a.mp4'), a: 'Queen', t: 'Radio Ga Ga' }, { k: key('b.mp4'), a: '', t: 'No Artist' }]
  // a failing service: nothing is remembered, the run just ends
  await years.run(async () => songs)
  assert.deepEqual(store.getYears(), {})
  fail = false
  const r = await years.run(async () => songs)
  assert.equal(r.checked, 1)
  assert.equal(store.getYears()[key('a.mp4')].y, 1984)
  // remembered: a second run asks nothing
  const before = calls.length
  await years.run(async () => songs)
  assert.equal(calls.length, before)
})

test('decade order: typed by hand, then a year in the filename, then MusicBrainz, then the iTunes tag, then the folder', () => {
  const file = (name, folder = '') => ({ filename: name, folder })
  const tag = { decade: '2010s', confidence: 'high' }
  assert.equal(describeFile(file('Funkadelic - Knee Deep.mp4'), tag, { y: 1979 }).decade, '1970s')            // MusicBrainz beats the video tag
  assert.equal(describeFile(file('Funkadelic - Knee Deep (1979).mp4'), tag, { y: 1985 }).decade, '1970s')     // the filename's year beats MusicBrainz
  assert.equal(describeFile(file('Funkadelic - Knee Deep (1979).mp4'), { decade: '1980s', confidence: 'manual' }, { y: 1979 }).decade, '1980s') // by hand wins
  assert.equal(describeFile(file('Funkadelic - Knee Deep.mp4'), tag, { y: null }).decade, '2010s')            // nothing found: the tag stays
  assert.equal(describeFile(file('Funkadelic - Knee Deep.mp4', '1980s/x')).decade, '1980s')                  // then the folder
})
