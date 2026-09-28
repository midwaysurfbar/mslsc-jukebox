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
  function guessArtistTitle(filename) {
    let name = String(filename || '').replace(/\.[^.]+$/, '')
    name = name.replace(/[\[(].*?(official|video|hd|lyrics|audio|4k|hq).*?[\])]/gi, '')
    name = name.replace(/^\s*\d+[\s._-]+/, '') // leading track numbers
    name = name.replace(/[_]+/g, ' ').trim()
    const parts = name.split(/\s*-\s*/)
    if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
    return { artist: '', title: name.trim() }
  }

  return { guessArtistTitle }
})
