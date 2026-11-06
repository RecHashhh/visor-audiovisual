import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

// Transforma JSX sin montar React; las API y las esperas son falsas.
const source = (await readFile(new URL('./remoteUpload.jsx', import.meta.url), 'utf8'))
  .replace(/^import .* from 'react'\r?\n/m, '')
  .replace(/^import .* from '\.\/api'\r?\n/m, 'const api = globalThis.remoteTestApi\n')
const client = {}
globalThis.remoteTestApi = client
const code = await transform(source, { loader: 'jsx', format: 'esm' })
const { runCopyMigration, projectRemoteBatches, analyzeProjectRemote } = await import(`data:text/javascript;base64,${Buffer.from(code.code).toString('base64')}`)
delete globalThis.remoteTestApi

function noWait(t) {
  const delays = []
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { delays.push(ms); fn(); return 0 })
  return delays
}

test('sondea solo pendientes y faltantes; sube de 3 a 10 segundos sin cambios', async t => {
  const delays = noWait(t)
  const calls = [], progress = []
  const responses = [
    { pendingPaths: ['b', 'c'], notDone: [] },
    { pendingPaths: ['b', 'c'], notDone: [] },
    { pendingPaths: [], notDone: ['c'] },
    { pendingPaths: [], notDone: [] },
  ]
  client.postRemoteCopyStatus = async payload => { calls.push(payload.blobPaths); return responses.shift() }
  const chunks = []
  const result = await runCopyMigration({ todo: ['a', 'b', 'c'].map(blobPath => ({ blobPath, size: 100 })),
    statusBase: { projectCode: 'obra' }, issue: async (items, refresh) => { chunks.push({ items, refresh }); return { processed: items.length } },
    onProgress: p => progress.push(p) })
  assert.deepEqual(calls, [['a', 'b', 'c'], ['b', 'c'], ['b', 'c'], ['c']])
  assert.deepEqual(delays, [3000, 10000, 12000])
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks[1].items.map(f => f.blobPath), ['c'])
  assert.equal(chunks[1].refresh, true)
  assert.deepEqual(result, { done: 3, failed: 0, total: 3 })
  assert.equal(progress.at(-1).doneBytes, 300)
})

test('videos de 1 GB pasan a bloques de uno en uno después de las copias normales', async t => {
  noWait(t)
  const events = [], progress = [], order = [], issued = []
  const gb = 1024 ** 3
  const todo = [{ blobPath: 'small', size: 10 }, { blobPath: 'big', size: gb, name: 'Video río.mp4' },
    { blobPath: 'big2', size: 2 * gb, name: 'Video 2.mp4' }]
  client.postRemoteCopyStatus = async () => { order.push('status'); return { pendingPaths: [], notDone: [] } }
  let part = 0
  client.postRemoteBlockCopy = async ({ item }) => {
    order.push(item.blobPath)
    if (item.blobPath === 'big' && !part++) return { done: false, stagedBytes: gb / 2 }
    return { done: true, stagedBytes: item.size }
  }
  const result = await runCopyMigration({ todo, statusBase: { projectCode: 'obra' },
    issue: async items => { issued.push(...items); order.push('issue'); return { processed: items.length } },
    onEvent: e => events.push(e), onProgress: p => progress.push(p) })
  assert.deepEqual(issued.map(f => f.blobPath), ['small'])
  assert.deepEqual(order, ['issue', 'status', 'big', 'big', 'big2'])
  assert.equal(result.done, 3)
  assert.equal(progress.at(-1).doneBytes, 3 * gb + 10)
  assert.ok(progress.some(p => p.doneBytes === gb / 2 + 10))
  assert.ok(events.some(e => e.includes('Video grande 1/2: Video río.mp4')))
})

test('corta después de cinco errores de red consecutivos en bloques', async t => {
  noWait(t)
  let calls = 0
  client.postRemoteBlockCopy = async () => { calls++; throw new Error('Sin red') }
  await assert.rejects(runCopyMigration({ todo: [{ blobPath: 'big', size: 1024 ** 3 }],
    statusBase: { projectCode: 'obra' }, issue: async () => { throw new Error('No corresponde') } }), /Sin red/)
  assert.equal(calls, 5)
})

test('primer nivel: raíz propia y subcarpetas con ruta relativa conservada', async t => {
  noWait(t)
  const lists = [], prepares = []
  client.resolveSharepointUrl = async () => ({ site_id: 'site', folder_path: '/Fotos' })
  client.postRemoteList = async payload => {
    lists.push(payload)
    if (payload.firstLevel) return { done: true, files: [
      { name: 'raíz.jpg', size: 20 }, { folder: true, name: 'Marzo', relDir: 'Marzo', childrenUrl: 'children' },
    ] }
    return { done: true, files: [{ name: 'foto.jpg', size: 10, relDir: 'Marzo' }] }
  }
  client.postRemotePrepare = async payload => { prepares.push(payload); return { total: 1, files: payload.files } }
  const batches = await projectRemoteBatches({ source: 'sharepoint', sharepointUrl: 'https://empresa.sharepoint.com/sites/fotos',
    projectCode: 'obra', projectName: 'obra', splitBySubfolder: true, recursive: true })
  assert.deepEqual(batches.map(b => b.name), ['Archivos de la raíz', 'Marzo'])
  await analyzeProjectRemote(batches[0].config)
  await analyzeProjectRemote(batches[1].config)
  assert.equal(lists[0].firstLevel, true)
  assert.equal(lists[1].recursive, false)
  assert.deepEqual(lists[2].cursor.pending, [['children', 'Marzo']])
  assert.equal(lists[2].recursive, true)
  assert.equal(prepares[1].files[0].relDir, 'Marzo')
})
