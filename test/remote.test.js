// The staff Remote's server side (requests.js): pairing kinds, who may use
// the remote commands, and the relay to the Control window.
const test = require('node:test')
const assert = require('node:assert/strict')
const { tempDir } = require('./helpers')
const { createStore } = require('../lib/store')
const setupRequests = require('../requests')

const PORT = 4697

// A stand-in for Electron's ipcMain + the Control window: records what was
// sent to Control, and lets a test answer remote commands.
function fakeElectron() {
  const handlers = {}
  const listeners = {}
  const sent = []
  const ipcMain = {
    handle: (ch, fn) => { handlers[ch] = fn },
    on: (ch, fn) => { listeners[ch] = fn },
  }
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (ch, payload) => {
        sent.push({ ch, payload })
        // Control answering a remote command
        if (ch === 'remote:command') setImmediate(() => listeners['remote:reply'](null, { id: payload.id, result: { ok: true, did: payload.action, args: payload.args } }))
      },
    },
  }
  return { ipcMain, handlers, listeners, sent, getControlWindow: () => win }
}

function start(t, extra = {}) {
  const userData = tempDir(t, 'remote')
  const store = createStore(userData)
  const fake = fakeElectron()
  const api = setupRequests({
    ipcMain: fake.ipcMain,
    getControlWindow: fake.getControlWindow,
    userData,
    thumbnailsDir: userData,
    readJson: store.readJson,
    writeJson: store.writeJson,
    listLibrary: async () => [],
    appVersion: '9.9.9',
    port: PORT,
    barCheckMs: 0, // no real bar checks in tests - see the bar tests below
    ...extra,
  })
  t.after(() => api.close())
  fake.api = api
  return fake
}

// A stand-in for the two Supabase bar functions.
function fakeBar(state) {
  return async (url) => {
    if (state.fail) throw new Error('offline')
    const body = url.endsWith('public-kiosk-state')
      ? { ok: true, session: { is_open: state.open } }
      : { ok: true, booking: state.booking || null }
    return { json: async () => body }
  }
}

const base = `http://127.0.0.1:${PORT}`
async function call(path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Device-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}
async function pair(fake, kind) {
  const st = await fake.handlers['requests:start-pairing'](null, kind)
  await new Promise((r) => setTimeout(r, 50)) // server listening
  const r = await call('/api/pair', { body: { code: st.pairing.code, kind } })
  assert.equal(r.status, 200)
  return r.data.token
}

test('a remote code only sets up a remote, and a picker code only a picker', async (t) => {
  const fake = start(t)
  const st = await fake.handlers['requests:start-pairing'](null, 'remote')
  await new Promise((r) => setTimeout(r, 50))
  const wrong = await call('/api/pair', { body: { code: st.pairing.code, kind: 'picker' } })
  assert.equal(wrong.status, 403)
  assert.match(wrong.data.error, /remote/)
  const right = await call('/api/pair', { body: { code: st.pairing.code, kind: 'remote' } })
  assert.equal(right.status, 200)
  assert.equal(right.data.name, 'Remote 1')
})

test('a song-picker screen cannot use the remote', async (t) => {
  const fake = start(t)
  const picker = await pair(fake, 'picker')
  assert.equal((await call('/api/remote/state', { token: picker })).status, 403)
  assert.equal((await call('/api/remote/command', { token: picker, body: { action: 'skip' } })).status, 403)
  assert.equal((await call('/api/remote/state')).status, 401)
})

test('remote state carries the Control snapshot and the request settings', async (t) => {
  const fake = start(t)
  const remote = await pair(fake, 'remote')
  fake.listeners['remote:status'](null, { status: 'playing', upcoming: [], upcomingTotal: 0 })
  const r = await call('/api/remote/state', { token: remote })
  assert.equal(r.status, 200)
  assert.equal(r.data.version, '9.9.9')
  assert.equal(r.data.player.status, 'playing')
  assert.equal(r.data.requests.devices.length, 1)
  assert.equal(r.data.requests.devices[0].kind, 'remote')
})

test('queue commands are relayed to Control and its answer comes back', async (t) => {
  const fake = start(t)
  const remote = await pair(fake, 'remote')
  const r = await call('/api/remote/command', { token: remote, body: { action: 'move', args: { index: 3, key: 'abc', direction: -1 } } })
  assert.deepEqual(r.data, { ok: true, did: 'move', args: { index: 3, key: 'abc', direction: -1 } })
  assert.ok(fake.sent.some((m) => m.ch === 'remote:command' && m.payload.action === 'move'))
})

test('unknown commands are refused without reaching Control', async (t) => {
  const fake = start(t)
  const remote = await pair(fake, 'remote')
  const r = await call('/api/remote/command', { token: remote, body: { action: 'delete-everything' } })
  assert.equal(r.status, 400)
  assert.ok(!fake.sent.some((m) => m.ch === 'remote:command'))
})

test('requests switch, pairing codes and removing screens work from a remote', async (t) => {
  const fake = start(t)
  const remote = await pair(fake, 'remote')
  await call('/api/remote/command', { token: remote, body: { action: 'requests-enabled', args: { enabled: true } } })
  let st = (await call('/api/remote/state', { token: remote })).data
  assert.equal(st.requests.enabled, true)
  await call('/api/remote/command', { token: remote, body: { action: 'pair', args: { kind: 'picker' } } })
  st = (await call('/api/remote/state', { token: remote })).data
  assert.equal(st.requests.pairing.kind, 'picker')
  const picker = await call('/api/pair', { body: { code: st.requests.pairing.code, kind: 'picker' } })
  assert.equal(picker.status, 200)
  st = (await call('/api/remote/state', { token: remote })).data
  const pickerDevice = st.requests.devices.find((d) => d.kind === 'picker')
  // can't remove itself, can remove the picker
  const self = await call('/api/remote/command', { token: remote, body: { action: 'remove-device', args: { id: st.you } } })
  assert.equal(self.status, 400)
  await call('/api/remote/command', { token: remote, body: { action: 'remove-device', args: { id: pickerDevice.id } } })
  st = (await call('/api/remote/state', { token: remote })).data
  assert.equal(st.requests.devices.length, 1)
})

test('the remote page and its files are served', async (t) => {
  const fake = start(t)
  await pair(fake, 'remote')
  for (const p of ['/remote', '/remote/remote.js', '/remote/remote.css', '/']) {
    const res = await fetch(base + p)
    assert.equal(res.status, 200, p)
  }
})

test('the picker follows the bar: closed shows the next opening and refuses requests', async (t) => {
  const bar = { open: false, booking: { title: 'Members Social Night', event_date: '2026-10-16', start_time: '17:00:00' } }
  const fake = start(t, { fetchImpl: fakeBar(bar) })
  const picker = await pair(fake, 'picker')
  await fake.handlers['requests:set-enabled'](null, true)
  await fake.api.checkBar()
  let st = (await call('/api/status', { token: picker })).data
  assert.equal(st.barAllows, false)
  assert.deepEqual(st.nextOpening, { title: 'Members Social Night', date: '2026-10-16', time: '17:00' })
  const refused = await call('/api/request', { token: picker, body: { key: 'a'.repeat(32) } })
  assert.equal(refused.data.reason, 'bar-closed')

  bar.open = true
  await fake.api.checkBar()
  st = (await call('/api/status', { token: picker })).data
  assert.equal(st.barAllows, true)
  assert.equal(st.nextOpening, null)
})

test('staff can turn off following the bar from a remote', async (t) => {
  const fake = start(t, { fetchImpl: fakeBar({ open: false }) })
  const remote = await pair(fake, 'remote')
  await fake.api.checkBar()
  assert.equal((await call('/api/remote/state', { token: remote })).data.requests.barAllows, false)
  await call('/api/remote/command', { token: remote, body: { action: 'requests-follow-bar', args: { follow: false } } })
  const r = (await call('/api/remote/state', { token: remote })).data.requests
  assert.equal(r.followBar, false)
  assert.equal(r.barAllows, true)
})

test('if the bar status can\'t be checked, the picker stays open', async (t) => {
  const bar = { fail: true }
  const fake = start(t, { fetchImpl: fakeBar(bar) })
  const picker = await pair(fake, 'picker')
  await fake.api.checkBar()
  assert.equal((await call('/api/status', { token: picker })).data.barAllows, true)
  // ...and once known closed, a later failed check keeps it closed
  Object.assign(bar, { fail: false, open: false })
  await fake.api.checkBar()
  bar.fail = true
  await fake.api.checkBar()
  assert.equal((await call('/api/status', { token: picker })).data.barAllows, false)
})

test('Show on TV / Hide TV from a remote', async (t) => {
  let visible = false
  const tv = { visible: () => visible, show: () => { visible = true }, hide: () => { visible = false } }
  const fake = start(t, { tv })
  const remote = await pair(fake, 'remote')
  assert.equal((await call('/api/remote/state', { token: remote })).data.tv.visible, false)
  await call('/api/remote/command', { token: remote, body: { action: 'tv-show' } })
  assert.equal((await call('/api/remote/state', { token: remote })).data.tv.visible, true)
  await call('/api/remote/command', { token: remote, body: { action: 'tv-hide' } })
  assert.equal(visible, false)
  // the start-hidden setting is Control's to change - relayed, not handled here
  const r = await call('/api/remote/command', { token: remote, body: { action: 'tv-start-hidden', args: { hidden: true } } })
  assert.equal(r.data.did, 'tv-start-hidden')
})

test('Remote preview video: remotes only, byte ranges, unknown keys 404', async (t) => {
  const dir = tempDir(t, 'video')
  const file = require('node:path').join(dir, 'a.mp4')
  require('node:fs').writeFileSync(file, Buffer.from('0123456789'))
  const key = 'ab'.repeat(16)
  const fake = start(t, { videoPath: (k) => (k === key ? file : null) })
  const remote = await pair(fake, 'remote')
  const picker = await pair(fake, 'picker')
  const get = (k, token, range) => fetch(`${base}/api/remote/video?k=${k}&t=${token}`, { headers: range ? { Range: range } : {} })
  let r = await get(key, remote)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'video/mp4')
  assert.equal(await r.text(), '0123456789')
  r = await get(key, remote, 'bytes=2-5')
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(await r.text(), '2345')
  r = await get(key, remote, 'bytes=7-')
  assert.equal(await r.text(), '789')
  assert.equal((await get('cd'.repeat(16), remote)).status, 404)
  assert.equal((await get(key, picker)).status, 403) // song pickers can't pull videos
  assert.equal((await get(key, 'nope')).status, 401)
})
