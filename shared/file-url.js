// A local file path -> the file:// URL a <video>/<img> can load. Shared by
// the Control and Display windows (it used to be copied into each).
//
// Real filenames (and the app's own data folder, "MSLSC Jukebox") are full
// of spaces and other characters that are invalid in a bare file:// URL, so
// each path segment is percent-encoded - but not the separators, and not a
// Windows drive letter ("C:" must stay literal; encoded as "C%3A" the URL
// resolves to nothing). The URL always uses forward slashes: one with
// backslashes silently fails to load on Windows.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else Object.assign(root, api)
})(typeof self !== 'undefined' ? self : this, function () {
  function toFileUrl(filePath) {
    const winMatch = filePath.match(/^([A-Za-z]:)[\\/](.*)$/)
    if (winMatch) {
      const [, drive, rest] = winMatch
      const encoded = rest.split(/[\\/]/).map(encodeURIComponent).join('/')
      return `file:///${drive}/${encoded}`
    }
    return 'file://' + filePath.split('/').map(encodeURIComponent).join('/')
  }

  return { toFileUrl }
})
