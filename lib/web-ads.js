// Ads come from the shared Ad Manager (separate repo mslsc-jukebox-ad-upload,
// Supabase function jukebox-ads). This app only ever READS from it: each
// pass downloads anything new, deletes anything no longer listed (so a
// delete on the web takes effect here too), and refreshes each ad's display
// seconds/size. A failed pass (no internet) is never fatal - whatever's
// already downloaded keeps playing. These are public values (the anon key
// and a function URL), not secrets.
const path = require('node:path')
const fs = require('node:fs')

const JUKEBOX_ADS_FN_URL = 'https://zzfcadiphconmkeudrby.supabase.co/functions/v1/jukebox-ads'
const JUKEBOX_ADS_ANON_KEY = 'sb_publishable_IDOXZicxdptjL667yWpVAQ_H1jB2saj'
const WEB_ADS_SYNC_INTERVAL_MS = 2 * 60 * 1000

function createWebAds({ store, fetchImpl = (...args) => fetch(...args) }) {
  const { paths, writeJson } = store

  function callJukeboxAdsFn(body) {
    return fetchImpl(JUKEBOX_ADS_FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${JUKEBOX_ADS_ANON_KEY}`,
        apikey: JUKEBOX_ADS_ANON_KEY,
      },
      body: JSON.stringify(body),
    }).then((r) => r.json())
  }

  async function syncOnce() {
    let files
    try {
      // 'jukebox' = only ads the Ad Manager has targeted at this app (not
      // ones meant only for the Bar Menu board).
      const data = await callJukeboxAdsFn({ action: 'list', target: 'jukebox' })
      if (!data.ok) throw new Error(data.error || 'Could not list web ads.')
      // The Ad Manager already makes names safe, but they become file names
      // here, so anything that isn't a plain file name is ignored.
      files = (data.files || []).filter((f) => typeof f.path === 'string' && f.path && path.basename(f.path) === f.path && f.path !== '..')
    } catch (err) {
      return { ok: false, error: err.message }
    }

    fs.mkdirSync(paths.webAds, { recursive: true })
    const remoteNames = new Set(files.map((f) => f.path))
    const existingLocal = new Set(fs.readdirSync(paths.webAds))

    let downloaded = 0
    for (const file of files) {
      if (existingLocal.has(file.path)) continue // names are timestamp-prefixed, so stable and unique
      try {
        const response = await fetchImpl(file.url)
        if (!response.ok) continue // try again on the next pass
        fs.writeFileSync(path.join(paths.webAds, file.path), Buffer.from(await response.arrayBuffer()))
        downloaded += 1
      } catch { /* offline mid-download - try again next pass */ }
    }

    let removed = 0
    for (const localName of existingLocal) {
      if (!remoteNames.has(localName)) {
        try { fs.rmSync(path.join(paths.webAds, localName), { force: true }); removed += 1 } catch { /* best effort */ }
      }
    }

    // Every pass: an ad's duration/size can change without its file changing.
    const metadata = {}
    for (const file of files) metadata[file.path] = { seconds: file.jukeboxSeconds, sizePct: file.jukeboxSizePct }
    writeJson(paths.webAdsMetadata, metadata)

    return { ok: true, downloaded, removed, total: files.length }
  }

  // A "sync now" landing while the background pass is still downloading
  // shares that pass instead of starting a second one.
  let syncing = null
  function sync() {
    if (!syncing) syncing = syncOnce().finally(() => { syncing = null })
    return syncing
  }

  // Runs now, then every 2 minutes. onChanged fires only when a pass
  // actually added or removed an ad.
  function start(onChanged) {
    const run = async () => {
      const result = await sync()
      if (result.ok && (result.downloaded > 0 || result.removed > 0)) onChanged()
    }
    run()
    return setInterval(run, WEB_ADS_SYNC_INTERVAL_MS)
  }

  return { sync, start }
}

module.exports = { createWebAds, WEB_ADS_SYNC_INTERVAL_MS }
