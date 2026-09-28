const test = require('node:test')
const assert = require('node:assert/strict')
const { guessArtistTitle } = require('../shared/names')
const { toFileUrl } = require('../shared/file-url')

test('artist and title guessed from a filename', () => {
  assert.deepEqual(guessArtistTitle("Queen - Don't Stop Me Now.mp4"), { artist: 'Queen', title: "Don't Stop Me Now" })
  assert.deepEqual(guessArtistTitle('01 - Dave Dobbyn - Slice of Heaven (Official Video).mkv'), { artist: 'Dave Dobbyn', title: 'Slice of Heaven' })
  assert.deepEqual(guessArtistTitle('Toto_-_Africa [HD].mp4'), { artist: 'Toto', title: 'Africa' })
  assert.deepEqual(guessArtistTitle('Wonderwall.mp4'), { artist: '', title: 'Wonderwall' })
  // a title with its own dash keeps it
  assert.deepEqual(guessArtistTitle('Salmonella Dub - Tui Dub - Live.mp4'), { artist: 'Salmonella Dub', title: 'Tui Dub - Live' })
})

test('file URLs: Windows drive letter kept, every segment encoded', () => {
  assert.equal(toFileUrl('C:\\Users\\MSLSC Kiosk\\Videos\\80\'s #1.mp4'), "file:///C:/Users/MSLSC%20Kiosk/Videos/80's%20%231.mp4")
  assert.equal(toFileUrl('D:/Music Videos/a b.mp4'), 'file:///D:/Music%20Videos/a%20b.mp4')
  assert.equal(toFileUrl('/home/sam/My Videos/x.mp4'), 'file:///home/sam/My%20Videos/x.mp4')
})
