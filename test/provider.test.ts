import { describe, expect, it, afterEach } from 'vitest'
import * as Y from 'yjs'
import { SupabaseProvider } from '../src/index.js'
import { FakeChannel, FakeHub, sleep, waitFor } from './fake-supabase.js'

const providers: SupabaseProvider[] = []

function make(hub: FakeHub, name = 'doc-1', extra: Partial<ConstructorParameters<typeof SupabaseProvider>[1]> = {}) {
  const p = new SupabaseProvider(hub.client(), { name, saveDebounceMs: 20, awarenessHeartbeatMs: 0, ...extra })
  providers.push(p)
  return p
}

afterEach(() => {
  for (const p of providers.splice(0)) p.destroy()
})

describe('SupabaseProvider', () => {
  it('syncs edits between two peers', async () => {
    const hub = new FakeHub()
    const a = make(hub)
    const b = make(hub)
    await waitFor(() => a.synced && b.synced)

    a.document.getText('t').insert(0, 'hello')
    await waitFor(() => b.document.getText('t').toString() === 'hello')

    b.document.getText('t').insert(5, ' world')
    await waitFor(() => a.document.getText('t').toString() === 'hello world')
  })

  it('persists the document and a late joiner loads it from the database', async () => {
    const hub = new FakeHub()
    const a = make(hub)
    await waitFor(() => a.synced)
    a.document.getText('t').insert(0, 'persisted')

    let saved = 0
    a.on('save', () => saved++)
    await waitFor(() => saved > 0)
    expect(hub.table('documents').get('doc-1')?.content).toBeTypeOf('string')

    a.destroy()
    const later = make(hub)
    await waitFor(() => later.synced)
    expect(later.document.getText('t').toString()).toBe('persisted')
  })

  it('uses the configured table, columns, schema and extra columns', async () => {
    const hub = new FakeHub()
    const p = make(hub, 'abc', {
      table: 'notes',
      schema: 'app',
      nameColumn: 'id',
      contentColumn: 'state',
      extraRow: { owner_id: 'user-1' },
    })
    await waitFor(() => p.synced)
    p.document.getText('t').insert(0, 'x')
    await waitFor(() => hub.table('notes').size === 1)
    const row = hub.table('notes').get('abc')!
    expect(row.id).toBe('abc')
    expect(row.owner_id).toBe('user-1')
    expect(row.state).toBeTypeOf('string')
  })

  it('supports update-only persistence for RLS setups where the app creates the row', async () => {
    const hub = new FakeHub()
    hub.table('documents').set('doc-1', { name: 'doc-1', content: '', owner_id: 'u1' })
    const p = make(hub, 'doc-1', { persistMode: 'update' })
    await waitFor(() => p.synced)
    p.document.getText('t').insert(0, 'y')
    await waitFor(() => (hub.table('documents').get('doc-1')?.content as string).length > 0)
    expect(hub.table('documents').get('doc-1')?.owner_id).toBe('u1')
  })

  it('supports custom load/save hooks', async () => {
    const hub = new FakeHub()
    let stored: Uint8Array | null = null
    const a = make(hub, 'custom', {
      load: async () => stored,
      save: async (s) => {
        stored = s
      },
    })
    await waitFor(() => a.synced)
    a.document.getText('t').insert(0, 'hooked')
    await waitFor(() => stored !== null)
    a.destroy()

    const b = make(hub, 'custom', { load: async () => stored, save: async () => {} })
    await waitFor(() => b.synced)
    expect(b.document.getText('t').toString()).toBe('hooked')
  })

  it('reconciles divergent state on connect via the sync protocol', async () => {
    const hub = new FakeHub()
    // A is online alone and types.
    const a = make(hub)
    await waitFor(() => a.synced)
    hub.dropBroadcasts = true // nobody hears A's updates
    a.document.getText('t').insert(0, 'A')
    // B comes up with its own offline edit, before A has saved anything.
    const b = make(hub, 'doc-1', { autoConnect: false })
    b.document.getText('t').insert(0, 'B')
    hub.dropBroadcasts = false
    b.connect()
    await waitFor(() => b.synced)
    await waitFor(() => a.document.getText('t').toString().length === 2 && b.document.getText('t').toString().length === 2)
    expect(a.document.getText('t').toString()).toBe(b.document.getText('t').toString())
  })

  it('propagates awareness without echoing it back', async () => {
    const hub = new FakeHub()
    const a = make(hub)
    const b = make(hub)
    await waitFor(() => a.synced && b.synced)

    a.awareness.setLocalStateField('user', { name: 'Ada' })
    await waitFor(() => b.awareness.getStates().get(a.document.clientID)?.user?.name === 'Ada')

    const before = hub.sent.filter((m) => m.event === 'awareness').length
    await sleep(50)
    const after = hub.sent.filter((m) => m.event === 'awareness').length
    expect(after).toBe(before) // no ping-pong
  })

  it('removes a peer from awareness when it is destroyed', async () => {
    const hub = new FakeHub()
    const a = make(hub)
    const b = make(hub)
    await waitFor(() => a.synced && b.synced)
    a.awareness.setLocalStateField('user', { name: 'Ada' })
    await waitFor(() => b.awareness.getStates().has(a.document.clientID))
    a.destroy()
    await waitFor(() => !b.awareness.getStates().has(a.document.clientID))
  })

  it('chunks large payloads', async () => {
    const hub = new FakeHub()
    const a = make(hub, 'big', { chunkSize: 500 })
    const b = make(hub, 'big', { chunkSize: 500 })
    await waitFor(() => a.synced && b.synced)
    const text = 'x'.repeat(5000)
    a.document.getText('t').insert(0, text)
    await waitFor(() => b.document.getText('t').toString() === text)
    expect(hub.sent.some((m) => m.event === 'chunk')).toBe(true)
  })

  it('reconnects after the channel closes and resyncs', async () => {
    const hub = new FakeHub()
    const a = make(hub)
    const b = make(hub)
    await waitFor(() => a.synced && b.synced)

    const statuses: string[] = []
    b.on('status', ({ status }) => statuses.push(status))
    const aChannel = (a as unknown as { channel: FakeChannel }).channel
    const bChannel = Array.from(hub.topics.get('yjs:doc-1')!).find((c) => c !== aChannel)!
    bChannel.simulateClose()
    expect(b.status).toBe('disconnected')

    // Edit while B is down; B should catch up after reconnecting.
    a.document.getText('t').insert(0, 'while-away')
    await waitFor(() => b.synced, 5000)
    await waitFor(() => b.document.getText('t').toString() === 'while-away', 5000)
    expect(statuses).toContain('connecting')
    expect(statuses).toContain('connected')
  })

  it('emits save errors and retries', async () => {
    const hub = new FakeHub()
    const a = make(hub)
    await waitFor(() => a.synced)
    hub.dbError = 'boom'
    const errors: string[] = []
    a.on('error', ({ context }) => errors.push(context))
    a.document.getText('t').insert(0, 'z')
    await waitFor(() => errors.includes('save'))
    hub.dbError = null
    let saved = false
    a.on('save', () => (saved = true))
    await waitFor(() => saved, 3000)
  })

  it('stops sending after destroy', async () => {
    const hub = new FakeHub()
    const a = make(hub)
    await waitFor(() => a.synced)
    a.destroy()
    const count = hub.sent.length
    a.document.getText('t').insert(0, 'ignored')
    await sleep(60)
    expect(hub.sent.length).toBe(count)
  })

  it('reports an error when update mode matches no row (RLS or missing row)', async () => {
    const hub = new FakeHub()
    const p = make(hub, 'missing', { persistMode: 'update' })
    await waitFor(() => p.synced)
    const errors: string[] = []
    p.on('error', ({ error }) => errors.push(error.message))
    p.document.getText('t').insert(0, 'x')
    await waitFor(() => errors.length > 0)
    expect(errors[0]).toMatch(/no row updated/)
  })

  it('never writes when persist is false', async () => {
    const hub = new FakeHub()
    const viewer = make(hub, 'doc-1', { persist: false })
    await waitFor(() => viewer.synced)
    viewer.document.getText('t').insert(0, 'view')
    await viewer.flush()
    await sleep(60)
    expect(hub.table('documents').size).toBe(0)
    expect(viewer.hasUnsavedChanges).toBe(false)
  })

  it('flush() persists immediately', async () => {
    const hub = new FakeHub()
    const a = make(hub, 'doc-1', { saveDebounceMs: 10_000 })
    await waitFor(() => a.synced)
    a.document.getText('t').insert(0, 'now')
    expect(a.hasUnsavedChanges).toBe(true)
    await a.flush()
    expect(a.hasUnsavedChanges).toBe(false)
    expect(hub.table('documents').get('doc-1')).toBeDefined()
  })
})
