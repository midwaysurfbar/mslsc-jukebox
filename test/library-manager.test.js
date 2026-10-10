// The Library Manager (lib/library-manager.js): rename / move / delete with
// undo, duplicates, playlists and the decade sort - against a real temp
// media folder.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setup } = require('./helpers')
const { fileKey } = require('../lib/library')
const { createLibraryManager, HOLD_DIR } = require('../lib/library-manager')

function make(t, files, { durations = {}, playing = null, fetchImpl, at } = {}) {
  const env = setup(t, files)
  const changes = []
  let clock = at || Date.parse('2026-10-11T10:00:00Z')
  const info = env.store.loadTrackInfo()
  for (const [rel, seconds] of Object.entries(durations)) {
    const full = path.join(env.media, rel)
    info[fileKey(full, fs.statSync(full).size)] = { duration: seconds, error: false, needsConversion: false }
  }
  const manager = createLibraryManager({
    store: env.store,
    library: env.library,
    playingKey: () => (typeof playing === 'function' ? playing() : playing),
    onChanged: (c) => changes.push(c),
    fetchImpl,
    now: () => clock,
    lookupGapMs: 0,
  })
  const keyOf = (rel) => fileKey(path.join(env.media, rel), fs.statSync(path.join(env.media, rel)).size)
  return { ...env, manager, changes, keyOf, tick: (ms) => { clock += ms } }
}

test('renaming a song gives it an "Artist - Title" name, keeps its playlist and queue places, and can be undone', async (t) => {
  const { manager, store, media, keyOf, changes } = make(t, { 'Sunny.mp4': 'aaaa', 'Other.mp4': 'bb' })
  const oldKey = keyOf('Sunny.mp4')
  store.writeJson(store.paths.playlists, [{ id: 'p1', name: 'Mine', trackKeys: [keyOf('Other.mp4'), oldKey] }])
  store.writeJson(store.paths.queue, { tracks: [oldKey], currentIndex: 0 })

  const r = await manager.edit({ key: oldKey, artist: 'Boney M.', title: 'Sunny' }, 'Laptop 1')
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(path.join(media, 'Boney M. - Sunny.mp4')))
  assert.ok(!fs.existsSync(path.join(media, 'Sunny.mp4')))
  const newKey = keyOf('Boney M. - Sunny.mp4')
  assert.equal(r.key, newKey)
  assert.deepEqual(store.getPlaylists().find((p) => p.id === 'p1').trackKeys[1], newKey)
  assert.deepEqual(store.getQueue().tracks, [newKey])
  assert.deepEqual(changes.at(-1).pairs, { [oldKey]: newKey })
  const meta = store.getMetadata()[newKey]
  assert.equal(meta.artist, 'Boney M.')
  assert.equal(meta.title, 'Sunny')
  assert.equal(meta.confidence, 'manual')

  // the picker shows the new name
  const picker = await (async () => { await manager.list(); return require('../lib/library').describeFile({ filename: 'Boney M. - Sunny.mp4', folder: '' }, meta) })()
  assert.deepEqual(picker, { title: 'Sunny', artist: 'Boney M.', decade: '' })

  const h = manager.history()
  assert.equal(h[0].by, 'Laptop 1')
  assert.equal(h[0].canUndo, true)
  await manager.undo(h[0].id, 'Laptop 1')
  assert.ok(fs.existsSync(path.join(media, 'Sunny.mp4')))
  assert.equal(store.getPlaylists().find((p) => p.id === 'p1').trackKeys[1], oldKey)
  assert.equal(store.getMetadata()[oldKey], undefined)
  assert.equal(manager.history()[0].canUndo, false)
})

test('moving a song into a decade folder sets its decade, and a name clash never overwrites', async (t) => {
  const { manager, store, media, keyOf } = make(t, { 'Stay.mp4': 'one', '1980s/Stay.mp4': 'two!' })
  store.writeJson(store.paths.metadata, { [keyOf('Stay.mp4')]: { artist: 'X', genre: 'Pop', decade: '2000s', confidence: 'low' } })
  const r = await manager.edit({ key: keyOf('Stay.mp4'), artist: '', title: 'Stay', folder: '1980s' })
  assert.ok(fs.existsSync(path.join(media, '1980s', 'Stay (2).mp4')))
  assert.ok(fs.existsSync(path.join(media, '1980s', 'Stay.mp4')))
  assert.equal(store.getMetadata()[r.key].decade, '1980s')
  assert.equal(store.getMetadata()[r.key].genre, 'Pop')
  const row = (await manager.list()).find((x) => x.k === r.key)
  assert.equal(row.d, '1980s')
  assert.equal(row.t, 'Stay')
})

test('deleting a song puts it in the holding folder; undo brings it back with its tags and playlist place', async (t) => {
  const { manager, store, media, keyOf, changes } = make(t, { 'A.mp4': 'aa', 'B.mp4': 'bbb', 'C.mp4': 'c' })
  const [a, b, c] = ['A.mp4', 'B.mp4', 'C.mp4'].map(keyOf)
  store.writeJson(store.paths.playlists, [{ id: 'p', name: 'Mine', trackKeys: [a, b, c] }])
  store.writeJson(store.paths.metadata, { [b]: { artist: 'Band', genre: 'Rock', decade: '1990s', confidence: 'manual', title: 'B' } })

  const r = await manager.removeSongs([b], 'Laptop 2')
  assert.equal(r.removed, 1)
  assert.ok(!fs.existsSync(path.join(media, 'B.mp4')))
  const held = fs.readdirSync(path.join(media, HOLD_DIR))
  assert.equal(held.length, 1)
  assert.match(held[0], /^2026-10-11 [0-9a-f]{6} B\.mp4$/)
  assert.deepEqual(store.getPlaylists()[0].trackKeys, [a, c])
  assert.deepEqual(changes.at(-1).removed, [b])
  assert.equal((await manager.list()).length, 2) // the holding folder isn't part of the library

  await manager.undo(manager.history()[0].id)
  assert.ok(fs.existsSync(path.join(media, 'B.mp4')))
  assert.deepEqual(store.getPlaylists()[0].trackKeys, [a, b, c])
  assert.equal(store.getMetadata()[b].artist, 'Band')
})

test('the song that is playing right now cannot be deleted', async (t) => {
  const env = make(t, { 'A.mp4': 'aa' }, { playing: () => env.keyOf('A.mp4') })
  await assert.rejects(env.manager.removeSongs([env.keyOf('A.mp4')]), /playing right now/)
  assert.ok(fs.existsSync(path.join(env.media, 'A.mp4')))
})

test('deleted songs are deleted for good after 30 days, and can no longer be undone', async (t) => {
  const env = make(t, { 'A.mp4': 'aa' })
  await env.manager.removeSongs([env.keyOf('A.mp4')])
  env.tick(29 * 86400000)
  assert.equal(env.manager.purgeExpired(), 0)
  env.tick(2 * 86400000)
  assert.equal(env.manager.purgeExpired(), 1)
  assert.equal(fs.readdirSync(path.join(env.media, HOLD_DIR)).length, 0)
  assert.equal(env.manager.history()[0].canUndo, false)
  await assert.rejects(env.manager.undo(env.manager.history()[0].id), /30 days/)
})

test('duplicates: copies of one song are grouped; other singers and live versions are not', async (t) => {
  const files = {
    'Love Shack.mp4': 'x'.repeat(50),
    'Favourites/The B-52\'s - Love Shack (Official Music Video).mp4': 'y'.repeat(80),
    '1980s/The B-52\'s - Love Shack (Official Music Video).mp4': 'y'.repeat(80),
    'Bee Gees - Alone.mp4': 'b'.repeat(10),
    'Heart - Alone.mp4': 'h'.repeat(10),
    'Dire Straits - Sultans Of Swing.mp4': 's'.repeat(10),
    'Dire Straits - Sultans Of Swing (Alchemy Live).mp4': 'l'.repeat(10),
  }
  const { manager, library } = make(t, files, {
    durations: {
      'Love Shack.mp4': 258,
      'Favourites/The B-52\'s - Love Shack (Official Music Video).mp4': 259,
      '1980s/The B-52\'s - Love Shack (Official Music Video).mp4': 259,
      'Bee Gees - Alone.mp4': 260,
      'Heart - Alone.mp4': 218,
      'Dire Straits - Sultans Of Swing.mp4': 266,
      'Dire Straits - Sultans Of Swing (Alchemy Live).mp4': 647,
    },
  })
  await library.listLibrary() // the folder playlists
  const d = await manager.duplicates()
  assert.equal(d.groups.length, 1)
  const g = d.groups[0]
  assert.equal(g.items.length, 3)
  assert.equal(g.how, 'likely')
  // keeps a copy with the band's name in it, in the decade folder
  assert.equal(g.items.find((i) => i.k === g.keep).folder, '1980s')
  assert.deepEqual(d.copyFolders.map((f) => f.name), ['Favourites'])
})

test('removing a duplicate puts the kept copy in its place in playlists and the queue', async (t) => {
  const { manager, store, keyOf, changes } = make(t, { 'Fav/Song.mp4': 'same', 'Song.mp4': 'same', 'Z.mp4': 'z' }, { durations: { 'Fav/Song.mp4': 200, 'Song.mp4': 200 } })
  const fav = keyOf('Fav/Song.mp4')
  const loose = keyOf('Song.mp4')
  store.writeJson(store.paths.playlists, [{ id: 'p', name: 'Party', trackKeys: [keyOf('Z.mp4'), fav] }])
  const g = (await manager.duplicates()).groups[0]
  assert.equal(g.how, 'exact')
  const remove = g.items.map((i) => i.k).filter((k) => k !== g.keep)
  await manager.resolveDuplicate({ keep: g.keep, remove })
  const party = store.getPlaylists().find((p) => p.id === 'p')
  assert.deepEqual(party.trackKeys, [keyOf('Z.mp4'), g.keep])
  assert.deepEqual(changes.at(-1).pairs, { [remove[0]]: g.keep })
  assert.equal((await manager.duplicates()).groups.length, 0)
  // undo puts the copy back in its old playlist place
  await manager.undo(manager.history()[0].id)
  const back = store.getPlaylists().find((p) => p.id === 'p').trackKeys
  assert.ok(back.includes(fav) || back.includes(loose))
})

test('the kept copy takes over the decade and singer of a removed copy when it has none', async (t) => {
  const { manager, store, keyOf } = make(t, { '1980s/Cutting Crew - Died In Your Arms.mp4': 'aa', 'Big/Died In Your Arms.mp4': 'bbbbbbbb' }, { durations: { '1980s/Cutting Crew - Died In Your Arms.mp4': 272, 'Big/Died In Your Arms.mp4': 271 } })
  const keep = keyOf('Big/Died In Your Arms.mp4')
  await manager.resolveDuplicate({ keep, remove: [keyOf('1980s/Cutting Crew - Died In Your Arms.mp4')] })
  const row = (await manager.list()).find((x) => x.k === keep)
  assert.equal(row.d, '1980s')
  assert.equal(row.a, 'Cutting Crew')
  assert.equal(store.getMetadata()[keep].confidence, 'high')
})

test('"Not a duplicate" hides a group for good', async (t) => {
  const { manager } = make(t, { 'Stay.mp4': 'a', 'Stay 1.mp4': 'bb' })
  const g = (await manager.duplicates()).groups[0]
  manager.ignoreDuplicate(g.items.map((i) => i.k))
  assert.equal((await manager.duplicates()).groups.length, 0)
})

test('a folder of copies becomes a normal playlist, and its folder playlist stays hidden after a rescan', async (t) => {
  const { manager, store, library, media, keyOf } = make(t, { 'Favourites/A.mp4': 'a', 'Favourites/B.mp4': 'b' })
  await library.listLibrary() // makes the folder playlist
  const folderPl = store.getPlaylists().find((p) => p.autoFolder)
  await manager.makeFoldersNormal([folderPl.id])
  let pls = store.getPlaylists()
  const mine = pls.find((p) => p.fromFolder === 'Favourites')
  assert.equal(mine.name, 'Favourites')
  assert.deepEqual(mine.trackKeys.sort(), [keyOf('Favourites/A.mp4'), keyOf('Favourites/B.mp4')].sort())
  await library.listLibrary()
  pls = store.getPlaylists()
  assert.equal(pls.find((p) => p.id === folderPl.id).hidden, true)
  // and moving a song out of the folder doesn't take it out of the playlist
  await manager.edit({ key: keyOf('Favourites/A.mp4'), artist: 'Abba', title: 'A', folder: '1970s' })
  const after = store.getPlaylists().find((p) => p.id === mine.id)
  assert.ok(after.trackKeys.includes(keyOf('1970s/Abba - A.mp4')))
  assert.ok(fs.existsSync(path.join(media, '1970s', 'Abba - A.mp4')))
})

test('playlists: make, fill, rename, delete, undo - and folder playlists can only be copied', async (t) => {
  const { manager, store, library, keyOf } = make(t, { 'A.mp4': 'a', 'B.mp4': 'b', '1980s/C.mp4': 'c' })
  await library.listLibrary()
  const made = await manager.playlistAction({ action: 'create', name: 'Friday', keys: [keyOf('A.mp4'), 'nonsense'] })
  await manager.playlistAction({ action: 'set-songs', id: made.id, keys: [keyOf('B.mp4'), keyOf('A.mp4')] })
  await manager.playlistAction({ action: 'rename', id: made.id, name: 'Friday Night' })
  let p = store.getPlaylists().find((x) => x.id === made.id)
  assert.equal(p.name, 'Friday Night')
  assert.deepEqual(p.trackKeys, [keyOf('B.mp4'), keyOf('A.mp4')])
  await manager.undo(manager.history()[0].id) // the rename
  assert.equal(store.getPlaylists().find((x) => x.id === made.id).name, 'Friday')

  const folder = store.getPlaylists().find((x) => x.autoFolder)
  await assert.rejects(manager.playlistAction({ action: 'rename', id: folder.id, name: 'X' }), /Copy it/)
  const copy = await manager.playlistAction({ action: 'copy', id: folder.id, name: 'Best of the 80s' })
  assert.deepEqual(store.getPlaylists().find((x) => x.id === copy.id).trackKeys, [keyOf('1980s/C.mp4')])

  await manager.playlistAction({ action: 'delete', id: made.id })
  assert.equal(store.getPlaylists().find((x) => x.id === made.id), undefined)
  await manager.undo(manager.history()[0].id)
  assert.ok(store.getPlaylists().find((x) => x.id === made.id))
})

test('decade lookup takes the earliest release of that song by that singer', async (t) => {
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({ results: [
      { artistName: 'Fleetwood Mac', trackName: 'The Chain (2004 Remaster)', releaseDate: '2004-03-01T00:00:00Z' },
      { artistName: 'Fleetwood Mac', trackName: 'The Chain', releaseDate: '1977-02-04T00:00:00Z' },
      { artistName: 'Someone Else', trackName: 'The Chain', releaseDate: '1960-01-01T00:00:00Z' },
    ] }),
  })
  const { manager } = make(t, {}, { fetchImpl })
  assert.equal((await manager.lookupDecade('Fleetwood Mac', 'The Chain')).decade, '1970s')
  assert.equal((await manager.lookupDecade('Fleetwood Mac', 'The Chain')).cached, true)
})

test('sort into decades: looks songs up, then moves them all at once (undoable); no singer = left alone', async (t) => {
  const years = { 'boney m': '1976-01-01', 'cutting crew': '1986-01-01' }
  const fetchImpl = async (url) => {
    const term = decodeURIComponent(url.match(/term=([^&]+)/)[1]).toLowerCase()
    const who = Object.keys(years).find((k) => term.startsWith(k))
    return { status: 200, json: async () => ({ results: who ? [{ artistName: who, trackName: term.slice(who.length + 1), releaseDate: years[who] }] : [] }) }
  }
  const { manager, media } = make(t, {
    'Old/Boney M. - Sunny.mp4': 'a',
    'Old/Cutting Crew - (I Just) Died In Your Arms.mp4': 'b',
    'Old/Mystery.mp4': 'c',
    'Loose.mp4': 'd',
  }, { fetchImpl })
  await manager.startSort(['Old'])
  for (let i = 0; i < 50 && manager.sortStatus().state === 'looking'; i++) await new Promise((r) => setTimeout(r, 10))
  const st = manager.sortStatus()
  assert.equal(st.state, 'ready')
  assert.equal(st.total, 3)
  assert.equal(st.ready, 2)
  assert.equal(st.noArtist, 1)
  assert.deepEqual(st.byDecade, { '1970s': 1, '1980s': 1 })
  const r = await manager.applySort()
  assert.equal(r.moved, 2)
  assert.ok(fs.existsSync(path.join(media, '1970s', 'Boney M. - Sunny.mp4')))
  assert.ok(fs.existsSync(path.join(media, '1980s', 'Cutting Crew - (I Just) Died In Your Arms.mp4')))
  assert.ok(fs.existsSync(path.join(media, 'Old', 'Mystery.mp4')))
  assert.ok(fs.existsSync(path.join(media, 'Loose.mp4')))
  await manager.undo(manager.history()[0].id)
  assert.ok(fs.existsSync(path.join(media, 'Old', 'Boney M. - Sunny.mp4')))
})
