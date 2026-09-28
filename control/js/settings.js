// Control window - Tab switching and the Settings tab.
// Plain scripts loaded in order by index.html; they share one global scope.

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'))
    btn.classList.add('active')
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active')
  })
})

document.getElementById('reopen-display-btn').addEventListener('click', () => jukebox.reopenDisplay())

// --- Settings ---
async function loadSettings() {
  settings = await jukebox.getSettings()
  document.getElementById('settings-folder').value = settings.mediaFolder || ''
  document.getElementById('crossfade-slider').value = settings.crossfadeSeconds
  document.getElementById('crossfade-value').textContent = settings.crossfadeSeconds
  document.getElementById('volume-slider').value = Math.round(settings.volume * 100)
  document.getElementById('volume-value').textContent = Math.round(settings.volume * 100)
  document.getElementById('library-folder-label').textContent = settings.mediaFolder
    ? `Folder: ${settings.mediaFolder}`
    : 'No media folder set — go to Settings.'

  document.getElementById('ads-enabled-toggle').checked = Boolean(settings.adsEnabled)
  document.getElementById('ads-every-slider').value = settings.adsEverySongs
  document.getElementById('ads-every-value').textContent = settings.adsEverySongs
  document.getElementById('ads-every-plural').textContent = settings.adsEverySongs === 1 ? '' : 's'
  document.getElementById('ads-seconds-slider').value = settings.adsSecondsPerImage
  document.getElementById('ads-seconds-value').textContent = settings.adsSecondsPerImage

  document.getElementById('intro-video-enabled-toggle').checked = Boolean(settings.introVideoEnabled)
}

document.getElementById('choose-folder-btn').addEventListener('click', async () => {
  const folder = await jukebox.chooseMediaFolder()
  if (folder) { await loadSettings(); await runLibraryOp(rescanLibrary) }
})

// Sliders fire on every step of a drag. Their live effect (volume,
// crossfade) is sent to the TV straight away, but the settings file is only
// saved once the dragging pauses - it used to be written ~100 times per
// drag, each one also making the TV re-read its ad folder.
let settingsSaveTimer = null
function saveSettingsSoon() {
  clearTimeout(settingsSaveTimer)
  settingsSaveTimer = setTimeout(() => jukebox.saveSettings(settings), 300)
}

document.getElementById('ads-enabled-toggle').addEventListener('change', async (e) => {
  settings.adsEnabled = e.target.checked
  await jukebox.saveSettings(settings)
})
document.getElementById('ads-every-slider').addEventListener('input', async (e) => {
  const n = Number(e.target.value)
  document.getElementById('ads-every-value').textContent = n
  document.getElementById('ads-every-plural').textContent = n === 1 ? '' : 's'
  settings.adsEverySongs = n
  saveSettingsSoon()
})
document.getElementById('ads-seconds-slider').addEventListener('input', async (e) => {
  const n = Number(e.target.value)
  document.getElementById('ads-seconds-value').textContent = n
  settings.adsSecondsPerImage = n
  saveSettingsSoon()
})

document.getElementById('intro-video-enabled-toggle').addEventListener('change', async (e) => {
  settings.introVideoEnabled = e.target.checked
  await jukebox.saveSettings(settings)
})

document.getElementById('crossfade-slider').addEventListener('input', async (e) => {
  const seconds = Number(e.target.value)
  document.getElementById('crossfade-value').textContent = seconds
  settings.crossfadeSeconds = seconds
  saveSettingsSoon()
  jukebox.playerSetCrossfadeDuration(seconds)
})
document.getElementById('volume-slider').addEventListener('input', async (e) => {
  const pct = Number(e.target.value)
  document.getElementById('volume-value').textContent = pct
  settings.volume = pct / 100
  saveSettingsSoon()
  jukebox.playerSetVolume(settings.volume)
})
