/* MSLSC club theme (Theme Manager, Sam 2026-10-11).
   The same file goes in every club system. It reads the club's active theme
   (the public-theme function), applies it as CSS variables on <html>, and
   checks again every minute - so a theme picked in the Theme Manager
   reaches every screen within about a minute, with no restart.
   The last theme is kept in this browser, so a screen with no internet
   still shows it; with nothing kept and no internet, the system's own
   built-in colours (the var() fallbacks in its CSS) show instead.

   Variables set: --t-bg --t-bg-2 --t-card --t-line --t-text --t-muted
   --t-accent --t-accent-text --t-accent-2 --t-accent-2-text --t-highlight
   --t-danger --t-good --t-warn --t-header-bg --t-header-text --t-input-bg
   --t-stripe --t-radius --t-font-display --t-font-body --t-font-label
   plus data-theme-mode="light|dark", data-theme-glow, data-theme-sunburst, data-theme-jukebox
   and data-theme="<name>" on <html>. A "mslsc-theme" event fires on change. */
(function () {
  var URL = 'https://zzfcadiphconmkeudrby.supabase.co/functions/v1/public-theme'
  var KEY = 'sb_publishable_IDOXZicxdptjL667yWpVAQ_H1jB2saj' // public anon key
  var STORE = 'mslsc-theme'
  var CHECK_MS = 60 * 1000
  var root = document.documentElement
  var current = ''

  function kebab(k) { return k.replace(/[A-Z0-9]+/g, function (m) { return '-' + m.toLowerCase() }) }
  var HEX = /^#[0-9A-Fa-f]{6}$/
  var FONT_OK = /^[A-Za-z -]{1,40}$/
  var GRADIENT_OK = /^linear-gradient\(180deg,(#[0-9A-Fa-f]{6}( \d{1,3}%?){0,2},?)+\)$/

  function apply(theme) {
    if (!theme || !theme.tokens) return
    var sig = theme.id + '|' + theme.updated_at
    if (sig === current) return
    current = sig
    var t = theme.tokens
    for (var k in t) if (HEX.test(t[k])) root.style.setProperty('--t-' + kebab(k), t[k])
    var f = theme.fonts || {}
    var stack = { display: ', Georgia, serif', body: ', system-ui, sans-serif', label: ', Barlow, system-ui, sans-serif' }
    for (var n in stack) if (FONT_OK.test(f[n] || '')) root.style.setProperty('--t-font-' + n, '"' + f[n] + '"' + stack[n])
    var e = theme.effects || {}
    if (GRADIENT_OK.test(e.stripe || '')) root.style.setProperty('--t-stripe', e.stripe)
    root.style.setProperty('--t-radius', (Number(e.radius) || 12) + 'px')
    root.setAttribute('data-theme-mode', theme.mode === 'dark' ? 'dark' : 'light')
    root.setAttribute('data-theme-glow', e.glow ? 'on' : 'off')
    root.setAttribute('data-theme-sunburst', e.sunburst ? 'on' : 'off')
    root.setAttribute('data-theme-jukebox', e.jukebox ? 'on' : 'off') // the song picker's bubble tubes + flashing sign
    root.setAttribute('data-theme', String(theme.name || '').slice(0, 60))
    root.style.colorScheme = theme.mode === 'dark' ? 'dark' : 'light'
    try { window.dispatchEvent(new CustomEvent('mslsc-theme', { detail: theme })) } catch (err) { /* old browser */ }
  }

  function check() {
    try {
      fetch(URL, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (!d || !d.ok || !d.theme) return
          apply(d.theme)
          try { localStorage.setItem(STORE, JSON.stringify(d.theme)) } catch (err) { /* private window */ }
        })
        .catch(function () { /* offline - keep what's showing */ })
    } catch (err) { /* very old browser */ }
  }

  try { apply(JSON.parse(localStorage.getItem(STORE) || 'null')) } catch (err) { /* nothing kept */ }
  window.mslscTheme = { apply: apply, check: check } // the Theme Manager's preview uses apply
  check()
  setInterval(check, CHECK_MS)
})()
