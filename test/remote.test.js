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

function start(t) {
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
  })
  t.after(() => api.close())
  return fake
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
