const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { walkVideoFiles, fileKey, isFileKey, requireFileKey } = require('../lib/library')
const { setup } = require('./helpers')

const byName = (files) => Object.fromEntries(files.map((f) => [f.filename, f]))

test('scanning finds videos, records their folder, and skips hidden macOS copies', async (t) => {
  const { media } = setup(t, {
    'Toto - Africa.mp4': 'aa',
    '1980s/Queen - Radio Ga Ga.mkv': 'bbb',
    "80's/Rock/AC-DC - Thunderstruck.webm": 'c',
    '1980s/.AppleDouble/Queen - Radio Ga Ga.mkv': '',
    '1980s/._Queen - Radio Ga Ga.mkv': '',
    'notes.txt': 'not a video',
    'poster.jpg': 'not a video either',
  })
  const files = byName(await walkVideoFiles(media, media))
  assert.deepEqual(Object.keys(files).sort(), ['AC-DC - Thunderstruck.webm', 'Queen - Radio Ga Ga.mkv', 'Toto - Africa.mp4'])
  assert.equal(files['Toto - Africa.mp4'].folder, '')
  assert.equal(files['Queen - Radio Ga Ga.mkv'].folder, '1980s')
  assert.equal(files['AC-DC - Thunderstruck.webm'].folder, "80's/Rock")
  assert.equal(files['Queen - Radio Ga Ga.mkv'].size, 3)
  assert.ok(isFileKey(files['Toto - Africa.mp4'].key))
})

test('an unreachable media folder scans as empty instead of failing', async () => {
  assert.deepEqual(await walkVideoFiles('/definitely/not/here', '/definitely/not/here'), [])
})

test('file keys: path + size, and only md5 hex is accepted as a key', () => {
  assert.equal(fileKey('/a.mp4', 10), fileKey('/a.mp4', 10))
  assert.notEqual(fileKey('/a.mp4', 10), fileKey('/a.mp4', 11))
  assert.throws(() => requireFileKey('../../evil'), /Invalid track key/)
  assert.throws(() => requireFileKey(undefined), /Invalid track key/)
})

test('folder playlists follow the folders; manual playlists are never touched', async (t) => {
  const { store, library } = setup(t, { '1980s/a.mp4': 'a', '1980s/b.mp4': 'b', '1990s/c.mp4': 'c', 'root.mp4': 'r' })
  store.writeJson(store.paths.playlists, [{ id: 'm1', name: 'Friday night', trackKeys: ['x'] }])
  const { files, playlists } = await library.listLibrary()
  assert.equal(files.length, 4)
  const names = playlists.map((p) => p.name).sort()
  assert.deepEqual(names, ['1980s', '1990s', 'Friday night'])
  assert.equal(playlists.find((p) => p.name === '1980s').trackKeys.length, 2)
  assert.deepEqual(playlists.find((p) => p.id === 'm1').trackKeys, ['x'])
})

test('a scan that finds nothing (drive unplugged) keeps playlists and cache', async (t) => {
  const { store, library, media } = setup(t, { '1980s/a.mp4': 'a' })
  const first = await library.listLibrary()
  const key = first.files[0].key
  fs.mkdirSync(store.paths.thumbnails, { recursive: true })
  fs.writeFileSync(path.join(store.paths.thumbnails, `${key}.jpg`), 'thumb')
  fs.rmSync(media, { recursive: true, force: true }) // the drive goes away
  const second = await library.listLibrary()
  assert.equal(second.files.length, 0)
  assert.equal(second.prunedCount, 0)
  assert.equal(second.playlists.find((p) => p.name === '1980s').trackKeys[0], key)
  assert.ok(fs.existsSync(path.join(store.paths.thumbnails, `${key}.jpg`)))
})

test('stale cache files are pruned, current ones kept and attached', async (t) => {
  const { store, library } = setup(t, { 'a.mp4': 'a' })
  const { files } = await library.listLibrary()
  const key = files[0].key
  fs.mkdirSync(store.paths.thumbnails, { recursive: true })
  fs.writeFileSync(path.join(store.paths.thumbnails, `${key}.jpg`), 'keep')
  fs.writeFileSync(path.join(store.paths.thumbnails, `${'f'.repeat(32)}.jpg`), 'stale')
  store.loadTrackInfo()[key] = { duration: 180, error: false, needsConversion: false }
  const again = await library.listLibrary()
  assert.equal(again.prunedCount, 1)
  assert.equal(again.files[0].duration, 180)
  assert.equal(again.files[0].infoCached, true)
  assert.ok(again.files[0].thumbPath.endsWith(`${key}.jpg`))
})

test('artist playlists come only from confident tags', async (t) => {
  const { store, library } = setup(t, { 'a.mp4': 'a', 'b.mp4': 'b', 'c.mp4': 'c' })
  const files = await library.scanMediaFolder(store.getSettings().mediaFolder)
  const [a, b, c] = files.map((f) => f.key)
  store.writeJson(store.paths.metadata, {
    [a]: { artist: 'Queen', confidence: 'high' },
    [b]: { artist: 'Queen', confidence: 'manual' },
    [c]: { artist: 'Toto', confidence: 'low' },
  })
  const playlists = library.syncArtistPlaylists(files)
  assert.deepEqual(playlists.map((p) => p.name), ['Queen'])
  assert.equal(playlists[0].trackKeys.length, 2)
})

test('moving a file into a folder carries its playlists, queue, tags and thumbnail with it', async (t) => {
  const { store, library, media } = setup(t, { 'Toto - Africa.mp4': 'africa' })
  const [file] = await library.scanMediaFolder(media)
  const oldKey = file.key
  store.writeJson(store.paths.queue, { tracks: ['k1', oldKey], currentIndex: 0 })
  store.writeJson(store.paths.playlists, [{ id: 'm', name: 'Mine', trackKeys: [oldKey] }])
  store.writeJson(store.paths.metadata, { [oldKey]: { artist: 'Toto', confidence: 'manual' } })
  fs.mkdirSync(store.paths.thumbnails, { recursive: true })
  fs.writeFileSync(path.join(store.paths.thumbnails, `${oldKey}.jpg`), 't')

  const result = await library.moveFileToFolder(file.path, '1980s')
  assert.ok(fs.existsSync(path.join(media, '1980s', 'Toto - Africa.mp4')))
  assert.notEqual(result.newKey, oldKey)
  assert.deepEqual(result.queue.tracks, ['k1', result.newKey])
  assert.deepEqual(store.getPlaylists().find((p) => p.id === 'm').trackKeys, [result.newKey])
  assert.equal(store.getMetadata()[result.newKey].artist, 'Toto')
  assert.ok(fs.existsSync(path.join(store.paths.thumbnails, `${result.newKey}.jpg`)))
  assert.ok(result.playlists.some((p) => p.autoFolder && p.folderPath === '1980s'))
})

test('a move never overwrites: a clash gets a (2) suffix', async (t) => {
  const { library, media } = setup(t, { 'a.mp4': 'one', '1980s/a.mp4': 'two' })
  await library.moveFileToFolder(path.join(media, 'a.mp4'), '1980s')
  assert.deepEqual(fs.readdirSync(path.join(media, '1980s')).sort(), ['a (2).mp4', 'a.mp4'])
  assert.equal(fs.readFileSync(path.join(media, '1980s', 'a.mp4'), 'utf8'), 'two')
})

test('nothing can be moved or deleted outside the media folder', async (t) => {
  const { library, media } = setup(t, { 'a.mp4': 'a' })
  await assert.rejects(library.moveFileToFolder(path.join(media, 'a.mp4'), '../../escape'), /outside the media folder/)
  await assert.rejects(library.moveFileToFolder('/etc/passwd', 'x'), /outside the configured media folder/)
  assert.throws(() => library.deleteFile('a'.repeat(32), '/etc/passwd'), /outside the configured media folder/)
  assert.throws(() => library.deleteFile('not-a-key', path.join(media, 'a.mp4')), /Invalid track key/)
  assert.ok(fs.existsSync(path.join(media, 'a.mp4')))
})

test('deleting a file removes it everywhere and keeps the queue position on its song', async (t) => {
  const { store, library, media } = setup(t, { 'a.mp4': 'a', 'b.mp4': 'bb', 'c.mp4': 'ccc' })
  const keys = Object.fromEntries((await library.scanMediaFolder(media)).map((f) => [f.filename, f.key]))
  store.writeJson(store.paths.queue, { tracks: [keys['a.mp4'], keys['b.mp4'], keys['c.mp4']], currentIndex: 2 })
  store.writeJson(store.paths.playlists, [{ id: 'm', name: 'Mine', trackKeys: [keys['a.mp4'], keys['c.mp4']] }])
  const { queue, playlists } = library.deleteFile(keys['a.mp4'], path.join(media, 'a.mp4'))
  assert.equal(fs.existsSync(path.join(media, 'a.mp4')), false)
  assert.deepEqual(queue, { tracks: [keys['b.mp4'], keys['c.mp4']], currentIndex: 1 }) // still on c
  assert.deepEqual(playlists[0].trackKeys, [keys['c.mp4']])
})

test('an unplayable file goes to the Recycle Bin, not a permanent delete', async (t) => {
  const { library, media, trashed } = setup(t, { 'broken.avi': 'x' })
  const [file] = await library.scanMediaFolder(media)
  await library.trashUnplayableFile(file.key, file.path)
  assert.deepEqual(trashed, [file.path])
})

test('pointing at the same videos in a new place keeps their tags and queue', async (t) => {
  const { store, library, media } = setup(t, { '1980s/a.mp4': 'aaaa' })
  const [oldFile] = await library.scanMediaFolder(media)
  store.writeJson(store.paths.metadata, { [oldFile.key]: { artist: 'Queen', confidence: 'manual' } })
  store.writeJson(store.paths.queue, { tracks: [oldFile.key], currentIndex: 0 })
  const newMedia = `${media}-moved`
  fs.cpSync(media, newMedia, { recursive: true })
  t.after(() => fs.rmSync(newMedia, { recursive: true, force: true }))
  assert.equal(await library.relinkMovedLibrary(media, newMedia), 1)
  const newKey = fileKey(path.join(newMedia, '1980s', 'a.mp4'), 4)
  assert.equal(store.getMetadata()[newKey].artist, 'Queen')
  assert.deepEqual(store.getQueue().tracks, [newKey])
})

test('decade sort moves only confident matches still loose in the root', async (t) => {
  const { store, library, media } = setup(t, { 'a.mp4': 'a', 'b.mp4': 'b', 'Mine/c.mp4': 'c' })
  const keys = Object.fromEntries((await library.scanMediaFolder(media)).map((f) => [f.filename, f.key]))
  store.writeJson(store.paths.metadata, {
    [keys['a.mp4']]: { decade: '1980s', confidence: 'high' },
    [keys['b.mp4']]: { decade: '1990s', confidence: 'low' },
    [keys['c.mp4']]: { decade: '1970s', confidence: 'manual' },
  })
  const result = await library.sortUnsortedByDecade()
  assert.equal(result.moved, 1)
  assert.equal(result.skipped, 1)
  assert.ok(fs.existsSync(path.join(media, '1980s', 'a.mp4')))
  assert.ok(fs.existsSync(path.join(media, 'b.mp4')))
  assert.ok(fs.existsSync(path.join(media, 'Mine', 'c.mp4')))
})

test('song picker list: playable songs only, named from tags or the filename, reusing the last scan', async (t) => {
  let scans = 0
  const { store, library, media } = setup(t, {
    'Queen - Radio Ga Ga.mp4': 'a',
    '1990s/Oasis - Wonderwall.mp4': 'bb',
    'Broken - Thing.avi': 'ccc',
  }, { onScanned: () => { scans += 1 } })
  const files = await library.scanMediaFolder(media)
  const key = (name) => files.find((f) => f.filename === name).key
  store.loadTrackInfo()[key('Broken - Thing.avi')] = { duration: 0, error: true, needsConversion: true }
  store.writeJson(store.paths.metadata, { [key('Queen - Radio Ga Ga.mp4')]: { artist: 'Queen', decade: '1980s' } })
  fs.writeFileSync(path.join(media, 'Added After - Scan.mp4'), 'new') // not in the last scan
  const list = await library.listRequestLibrary()
  assert.equal(scans, 1, 'built from the last scan, no second walk')
  assert.deepEqual(list.map((s) => [s.t, s.a, s.d]), [['Radio Ga Ga', 'Queen', '1980s'], ['Wonderwall', 'Oasis', '1990s']])
})

test('New Suggestions inbox: sorted into its decade once fully arrived, unknowns to the main folder, inbox left empty', async (t) => {
  const { createInboxSorter } = require('../lib/inbox-sorter')
  const { store, library, media } = setup(t, {
    'New Suggestions/Oasis - Wonderwall.mp4': 'wonder',
    'New Suggestions/Mystery Band - Unknown.mp4': 'mystery',
    'New Suggestions/Still Coming - Song.mp4': 'part',
    'New Suggestions/.syncthing.Still Coming - Song.mp4.tmp': 'x',
    'New Suggestions/notes.txt': 'not a video',
  })
  const lookups = { 'Oasis - Wonderwall.mp4': { decade: '1990s', confidence: 'high' }, 'Mystery Band - Unknown.mp4': { decade: 'Unknown', confidence: 'none' } }
  let clock = 1000
  let movedCalls = 0
  const sorter = createInboxSorter({
    store, library, now: () => clock, onMoved: () => { movedCalls += 1 },
    metadata: { lookup: async (_key, name) => lookups[name] || { decade: 'Unknown', confidence: 'none' } },
  })
  const inbox = path.join(media, 'New Suggestions')
  assert.equal(await sorter.run(), 0) // first sight - waits to see the size settle
  clock += 5000
  assert.equal(await sorter.run(), 0) // not settled long enough yet
  clock += 20000
  assert.equal(await sorter.run(), 2)
  assert.equal(movedCalls, 1)
  assert.ok(fs.existsSync(path.join(media, '1990s', 'Oasis - Wonderwall.mp4')))
  assert.ok(fs.existsSync(path.join(media, 'Mystery Band - Unknown.mp4')))
  assert.ok(fs.existsSync(path.join(inbox, 'Still Coming - Song.mp4'))) // Syncthing still copying it
  assert.ok(fs.existsSync(path.join(inbox, 'notes.txt'))) // not a video - left alone

  // offline lookups wait for the next pass instead of dumping it unsorted
  fs.rmSync(path.join(inbox, '.syncthing.Still Coming - Song.mp4.tmp'))
  const offline = createInboxSorter({ store, library, now: () => clock, metadata: { lookup: async () => ({ decade: 'Unknown', confidence: 'none', offline: true }) } })
  await offline.run(); clock += 30000
  assert.equal(await offline.run(), 0)
  assert.ok(fs.existsSync(path.join(inbox, 'Still Coming - Song.mp4')))
})
