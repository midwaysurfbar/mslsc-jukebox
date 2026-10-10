// Shared by the main process (require) and the Control window (<script>):
// one copy of the "Artist - Title" guess, instead of two that could drift.
// Works in both because it only defines globals when there's no `module`.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else Object.assign(root, api)
})(typeof self !== 'undefined' ? self : this, function () {
  // "01 - Queen - Don't Stop Me Now (Official Video).mp4" ->
  //   { artist: 'Queen', title: "Don't Stop Me Now" }
  // No " - " in the name means no artist can be told apart: artist ''.
  //
  // Tidied 2026-10-09 against the club's real 3,956 files (the song picker
  // showed "- I GOT 5 ON IT", "Wu" as an artist, blank titles...):
  //   * only a dash with a space beside it (or a double dash) separates
  //     artist from title - "Wu-Tang Clan", "T-Pain", "Holi-Holiday" stay whole
  //   * a bracket is dropped only when the words inside THAT bracket are
  //     video noise (Official Video, HD, Lyrics, Remastered 2015, VOD...) -
  //     it used to run on into the next bracket and eat the whole title
  //   * the same noise loose at the end ("... Official Music Video HD") goes
  //   * "ft./feat. X" moves from the title to the artist, once
  //   * "The Beatles - The Beatles - Hey Jude" loses the repeated artist
  //   * invisible characters, doubled spaces, stray dashes and a trailing
  //     full stop (but not the one in "T.N.T." or "U.S.A.") are cleaned up
  //   * "Destiny s Child" / "Don t" (apostrophes a download tool turned into
  //     spaces) get their apostrophe back
  //   * leading track numbers go only as "01 - " / "01. " - "50 Cent" stays
  const NOISE = '(?:official|video|hd|hq|4k|1080p|720p|lyrics?|audio|vod|remaster(?:ed)?|explicit|uncensored|dirty|visuali[sz]er|subtitlad[ao]|oficial|mv|clip)'
  const NOISE_BRACKET = new RegExp(`\\s*[\\[(][^\\[\\]()]*\\b${NOISE}\\b[^\\[\\]()]*[\\])]`, 'gi')
  const NOISE_TAIL = new RegExp(`\\s+(?:official(?: music| lyric)? video|music video|lyric video|official audio|full hd|in (?:hd|high definition)|${NOISE})\\s*$`, 'i')
  const FEAT = /\s+[([]?\s*(?:ft|feat|featuring)\.?\s+([^()[\]]+?)\s*[)\]]?\s*$/i

  function tidy(text) {
    let t = String(text || '')
      .replace(/\p{Cf}/gu, '') // zero-width / direction marks, soft hyphens
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/([([])\s+/g, '$1').replace(/\s+([)\]])/g, '$1')
      .replace(/\b([A-Za-z]+) (s|t|m|re|ll|ve|d)\b(?=\s|$)/g, (m, word, tail) => (word.length > 1 || /^[IiYy]$/.test(word) ? `${word}'${tail}` : m))
      .replace(/\s{2,}/g, ' ')
      .trim()
    t = t.replace(/^[-–—_,:;|\s]+/, '').replace(/[-–—_,:;|\s]+$/, '')
    // "Vampires." / "(1992)." lose the full stop; "T.N.T." and "U.S.A." keep theirs
    t = t.replace(/([a-z0-9)\]'"])\.+$/, '$1')
    return t.trim()
  }

  function guessArtistTitle(filename) {
    let name = String(filename || '').replace(/\.[^.]+$/, '')
    name = name.replace(/\p{Cf}/gu, '').replace(/[_]+/g, ' ')
    name = name.replace(/^\s*\d{1,3}\s*(?:[.)]|-)\s+/, '') // leading track numbers ("01 - ", "01. ")
    for (let i = 0; i < 3; i++) name = name.replace(NOISE_BRACKET, '')
    name = name.replace(/\s*\(\d\)\s*$/, '') // "Wonderwall (1)" - a second copy of the file
    for (let i = 0; i < 4; i++) name = name.replace(NOISE_TAIL, '')

    let parts = name.split(/\s+[-–—]+\s*|\s*[-–—]+\s+|\s*-{2,}\s*/).map(tidy).filter(Boolean)
    if (parts.length >= 3 && parts[0].toLowerCase() === parts[1].toLowerCase()) parts.splice(1, 1)
    // "Jive Bunny - The Album - 01 - Swing the Mood" (Sam, 2026-10-10): a
    // track number standing on its own between dashes means "Artist - Album
    // - NN - Song" - keep the artist and what comes after the number.
    const trackAt = parts.findIndex((p, i) => i > 0 && i < parts.length - 1 && /^\d{1,3}$/.test(p))
    if (trackAt > 0) parts = [parts[0], ...parts.slice(trackAt + 1)]
    let artist = parts.length >= 2 ? parts[0] : ''
    let title = parts.length >= 2 ? parts.slice(1).join(' - ') : (parts[0] || tidy(name))

    // featured artists belong with the artist, and only once
    const feat = title.match(FEAT)
    if (feat && title.length > feat[0].length) {
      title = tidy(title.slice(0, feat.index).replace(FEAT, ''))
      // "ft. Beyoncé ... ft. Beyoncé" - each featured name once
      const names = [...new Set(feat[1].split(/\s+(?:ft|feat|featuring)\.?\s+/i).map(tidy).filter(Boolean))]
      const who = names.filter((n) => !artist.toLowerCase().includes(n.toLowerCase())).join(', ')
      if (artist && who) artist = `${artist} ft. ${who}`
    }
    return { artist: tidy(artist), title: tidy(title) }
  }

  return { guessArtistTitle }
})
