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

// Real filenames from the club's library that the song picker used to show
// badly (2026-10-09).
test('messy real-world filenames come out clean', () => {
  const cases = [
    ['LUNIZ -- I GOT 5 ON IT.mp4', 'LUNIZ', 'I GOT 5 ON IT'],
    ['Wu-Tang Clan - C.R.E.A.M. (Official HD Video - Edited).mp4', 'Wu-Tang Clan', 'C.R.E.A.M.'],
    ['Sir Mix-A-Lot - Baby Got Back (Official Music Video).mp4', 'Sir Mix-A-Lot', 'Baby Got Back'],
    ['Beastie Boys - (You Gotta) Fight For Your Right (To Party) (Official Music Video).mp4', 'Beastie Boys', '(You Gotta) Fight For Your Right (To Party)'],
    ['Lady Gaga - Telephone ft. Beyoncé (Official Music Video) ft. Beyoncé.mp4', 'Lady Gaga ft. Beyoncé', 'Telephone'],
    ['The Beatles - The Beatles - Hey Jude (Official Music Video) [Remastered 2015].mp4', 'The Beatles', 'Hey Jude'],
    ['Lian Ross \u200e-- Say You\'ll Never.mp4', 'Lian Ross', "Say You'll Never"],
    ['Destiny s Child - Survivor (Official Video) ft. Da Brat.mp4', "Destiny's Child ft. Da Brat", 'Survivor'],
    ['AC DC - T.N.T..mp4', 'AC DC', 'T.N.T.'],
    ['Radiorama - Vampires. (HD).mp4', 'Radiorama', 'Vampires'],
    ['50 Cent - Candy Shop.mp4', '50 Cent', 'Candy Shop'],
    ['Britney Spears - ...Baby One More Time (Official Video).mp4', 'Britney Spears', '...Baby One More Time'],
    ['Jefferson Airplane -White Rabbit-.mp4', 'Jefferson Airplane', 'White Rabbit'],
    ['Oasis - Wonderwall (Official Video) (1).mp4', 'Oasis', 'Wonderwall'],
    ['Bee Gees - Stayin  Alive (1977).mp4', 'Bee Gees', 'Stayin Alive (1977)'],
    ['Led Zeppelin - Immigrant Song (Live 1972) (Official Video).mp4', 'Led Zeppelin', 'Immigrant Song (Live 1972)'],
    ['Blinded by the Light by Manfred Mann in HD.mp4', '', 'Blinded by the Light by Manfred Mann'],
    ['Motörhead – Overkill (Official Video).mp4', 'Motörhead', 'Overkill'],
  ]
  for (const [file, artist, title] of cases) assert.deepEqual(guessArtistTitle(file), { artist, title }, file)
})

test('file URLs: Windows drive letter kept, every segment encoded', () => {
  assert.equal(toFileUrl('C:\\Users\\MSLSC Kiosk\\Videos\\80\'s #1.mp4'), "file:///C:/Users/MSLSC%20Kiosk/Videos/80's%20%231.mp4")
  assert.equal(toFileUrl('D:/Music Videos/a b.mp4'), 'file:///D:/Music%20Videos/a%20b.mp4')
  assert.equal(toFileUrl('/home/sam/My Videos/x.mp4'), 'file:///home/sam/My%20Videos/x.mp4')
})
