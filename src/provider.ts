import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { fromBase64, toBase64 } from 'lib0/buffer'
import { TypedEmitter } from './emitter.js'

export type ProviderStatus = 'connecting' | 'connected' | 'disconnected'

export interface SupabaseProviderEvents extends Record<string, unknown> {
  /** Connection state changed. */
  status: { status: ProviderStatus }
  /** Emitted with `true` once the document has been loaded from the database and a sync with peers was requested. */
  synced: { synced: boolean }
  /** The document was persisted to the database. `version` increments on every successful save. */
  save: { version: number }
  /** A recoverable error occurred. The provider keeps running; inspect `context` to see where it happened. */
  error: { error: Error; context: 'load' | 'save' | 'channel' | 'message' }
  /** Convenience events mirroring `status`. */
  connect: undefined
  disconnect: undefined
}

export interface SupabaseProviderOptions {
  /** Unique document identifier. Used as the row key and (with `channelPrefix`) as the Realtime topic. */
  name: string
  /** Existing Y.Doc to bind. A new one is created when omitted. */
  document?: Y.Doc
  /** Existing awareness instance. A new one is created when omitted. */
  awareness?: Awareness
  /** Table holding the document rows. Default `documents`. */
  table?: string
  /** Postgres schema of `table`. Default: the client's default schema (`public`). */
  schema?: string
  /** Column holding the document identifier. Default `name`. */
  nameColumn?: string
  /** Column holding the base64-encoded Yjs state. Default `content`. */
  contentColumn?: string
  /** Column(s) used for `ON CONFLICT` when upserting. Default: `nameColumn`. */
  onConflict?: string
  /**
   * `upsert` (default) inserts the row if missing. `update` only updates an existing row,
   * which is the right choice when your RLS policies require the row to be created by the app first.
   */
  persistMode?: 'upsert' | 'update'
  /** Extra columns written on upsert, e.g. `{ owner_id: user.id }`. Ignored in `update` mode. */
  extraRow?: Record<string, unknown>
  /** Override how state is loaded. Return `null` when no state exists. */
  load?: () => Promise<Uint8Array | null>
  /** Override how state is stored. */
  save?: (state: Uint8Array) => Promise<void>
  /** Prefix for the Realtime topic. Default `yjs:`. */
  channelPrefix?: string
  /** Use a private channel authorized by RLS policies on `realtime.messages`. Default `false`. */
  privateChannel?: boolean
  /** Debounce window for persisting the document. Default 1500 ms. */
  saveDebounceMs?: number
  /** How often the local awareness state is re-broadcast so peers don't expire it. Default 15000 ms. */
  awarenessHeartbeatMs?: number
  /** Broadcast payloads above this many characters are split into chunks. Default 200000. */
  chunkSize?: number
  /** Connect immediately in the constructor. Default `true`. */
  autoConnect?: boolean
  /** Upper bound for exponential reconnect backoff. Default 30000 ms. */
  maxReconnectDelayMs?: number
}

type ChunkPayload = { id: string; event: string; i: number; n: number; part: string }
type UpdatePayload = { u: string; to?: number }
type AwarenessPayload = { a: string }
type SyncRequestPayload = { sv: string; from: number }
type SyncReplyPayload = { to: number; u: string; sv: string; from: number }

const DEFAULTS = {
  table: 'documents',
  nameColumn: 'name',
  contentColumn: 'content',
  persistMode: 'upsert' as const,
  channelPrefix: 'yjs:',
  privateChannel: false,
  saveDebounceMs: 1500,
  awarenessHeartbeatMs: 15_000,
  chunkSize: 200_000,
  autoConnect: true,
  maxReconnectDelayMs: 30_000,
}

/**
 * Yjs provider that syncs a document over Supabase Realtime broadcast and persists it
 * to a Postgres table. Peers exchange incremental updates; the full state is saved
 * (debounced) so late joiners and reloads start from the latest snapshot.
 */
export class SupabaseProvider extends TypedEmitter<SupabaseProviderEvents> {
  readonly document: Y.Doc
  readonly awareness: Awareness
  readonly options: Required<
    Omit<SupabaseProviderOptions, 'document' | 'awareness' | 'schema' | 'onConflict' | 'extraRow' | 'load' | 'save'>
  > &
    Pick<SupabaseProviderOptions, 'schema' | 'onConflict' | 'extraRow' | 'load' | 'save'>

  private supabase: SupabaseClient
  private channel: RealtimeChannel | null = null
  private _status: ProviderStatus = 'disconnected'
  private _synced = false
  private shouldConnect = false
  private destroyed = false
  private version = 0

  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private savePromise: Promise<void> | null = null
  private saveFailures = 0

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  private pendingUpdates: Uint8Array[] = []
  private chunks = new Map<string, { event: string; parts: (string | undefined)[]; received: number; n: number }>()

  constructor(supabase: SupabaseClient, options: SupabaseProviderOptions) {
    super()
    if (!options?.name) throw new Error('SupabaseProvider: `name` is required')
    this.supabase = supabase
    this.document = options.document ?? new Y.Doc()
    this.awareness = options.awareness ?? new Awareness(this.document)
    this.options = { ...DEFAULTS, ...stripUndefined(options), name: options.name }

    this.document.on('update', this.handleDocumentUpdate)
    this.awareness.on('update', this.handleAwarenessUpdate)

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', this.handleUnload)
      window.addEventListener('pagehide', this.handleUnload)
    }

    if (this.options.autoConnect) this.connect()
  }

  /** Current connection status. */
  get status(): ProviderStatus {
    return this._status
  }

  /** `true` once the initial load + peer sync has been performed for the current connection. */
  get synced(): boolean {
    return this._synced
  }

  /** `true` while there are unsaved local or remote changes. */
  get hasUnsavedChanges(): boolean {
    return this.dirty || this.savePromise !== null
  }

  /** Realtime topic this provider subscribes to. */
  get topic(): string {
    return `${this.options.channelPrefix}${this.options.name}`
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  connect(): void {
    if (this.destroyed) throw new Error('SupabaseProvider: cannot connect after destroy()')
    this.shouldConnect = true
    if (this.channel) return
    this.clearReconnectTimer()
    this.setStatus('connecting')

    const channel = this.supabase.channel(this.topic, {
      config: {
        private: this.options.privateChannel,
        broadcast: { self: false, ack: false },
      },
    })
    this.channel = channel

    channel
      .on('broadcast', { event: 'update' }, ({ payload }) => this.handleMessage('update', payload))
      .on('broadcast', { event: 'awareness' }, ({ payload }) => this.handleMessage('awareness', payload))
      .on('broadcast', { event: 'sync-request' }, ({ payload }) => this.handleMessage('sync-request', payload))
      .on('broadcast', { event: 'sync-reply' }, ({ payload }) => this.handleMessage('sync-reply', payload))
      .on('broadcast', { event: 'chunk' }, ({ payload }) => this.handleChunk(payload as ChunkPayload))
      .subscribe((state, err) => {
        if (this.channel !== channel) return // stale callback from a torn-down channel
        switch (state) {
          case 'SUBSCRIBED':
            this.reconnectAttempts = 0
            void this.onSubscribed()
            break
          case 'CHANNEL_ERROR':
            this.emit('error', {
              error: err instanceof Error ? err : new Error(String(err ?? 'channel error')),
              context: 'channel',
            })
            this.scheduleReconnect()
            break
          case 'TIMED_OUT':
          case 'CLOSED':
            this.scheduleReconnect()
            break
        }
      })
  }

  disconnect(): void {
    this.shouldConnect = false
    this.clearReconnectTimer()
    this.teardownChannel()
    this.setStatus('disconnected')
  }

  /**
   * Persist any pending changes immediately. Resolves once the write completes (or fails).
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  /**
   * Disconnect, persist pending changes, and release all listeners. The provider cannot be reused afterwards.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // Tell peers we're gone before the channel closes.
    removeAwarenessStates(this.awareness, [this.document.clientID], 'provider destroy')
    this.disconnect()
    void this.flush()
    this.document.off('update', this.handleDocumentUpdate)
    this.awareness.off('update', this.handleAwarenessUpdate)
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('beforeunload', this.handleUnload)
      window.removeEventListener('pagehide', this.handleUnload)
    }
    this.removeAllListeners()
  }

  private async onSubscribed(): Promise<void> {
    this.setStatus('connected')
    this.emit('connect', undefined)

    try {
      const state = await this.loadState()
      if (state && state.byteLength > 0) Y.applyUpdate(this.document, state, this)
    } catch (error) {
      this.emit('error', { error: toError(error), context: 'load' })
    }
    if (this.status !== 'connected') return // disconnected while loading

    // Push anything that happened while we were offline, then ask peers for what we missed.
    if (this.pendingUpdates.length > 0) {
      const merged = Y.mergeUpdates(this.pendingUpdates)
      this.pendingUpdates = []
      this.send('update', { u: toBase64(merged) } satisfies UpdatePayload)
    }
    this.send('sync-request', {
      sv: toBase64(Y.encodeStateVector(this.document)),
      from: this.document.clientID,
    } satisfies SyncRequestPayload)

    this.broadcastLocalAwareness()
    this.startHeartbeat()
    this.setSynced(true)
  }

  private scheduleReconnect(): void {
    this.teardownChannel()
    this.setStatus('disconnected')
    if (!this.shouldConnect || this.destroyed) return
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, this.options.maxReconnectDelayMs)
    this.reconnectAttempts++
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldConnect && !this.channel) this.connect()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private teardownChannel(): void {
    this.stopHeartbeat()
    this.setSynced(false)
    const channel = this.channel
    this.channel = null
    if (channel) void this.supabase.removeChannel(channel)
    this.chunks.clear()
    // Peers can no longer be observed; drop their cursors.
    const remote = Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.document.clientID)
    if (remote.length > 0) removeAwarenessStates(this.awareness, remote, this)
  }

  private setStatus(status: ProviderStatus): void {
    if (this._status === status) return
    this._status = status
    this.emit('status', { status })
    if (status === 'disconnected') this.emit('disconnect', undefined)
  }

  private setSynced(synced: boolean): void {
    if (this._synced === synced) return
    this._synced = synced
    this.emit('synced', { synced })
  }

  // ---------------------------------------------------------------------------
  // Document sync
  // ---------------------------------------------------------------------------

  private handleDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    this.dirty = true
    this.scheduleSave()
    if (origin === this) return // came from a peer or the database
    if (this.status === 'connected' && this.channel) {
      this.send('update', { u: toBase64(update) } satisfies UpdatePayload)
    } else {
      this.pendingUpdates.push(update)
    }
  }

  private handleMessage(event: string, payload: unknown): void {
    try {
      switch (event) {
        case 'update': {
          const { u, to } = payload as UpdatePayload
          if (to !== undefined && to !== this.document.clientID) return
          Y.applyUpdate(this.document, fromBase64(u), this)
          break
        }
        case 'awareness': {
          const { a } = payload as AwarenessPayload
          applyAwarenessUpdate(this.awareness, fromBase64(a), this)
          break
        }
        case 'sync-request': {
          const { sv, from } = payload as SyncRequestPayload
          if (from === this.document.clientID) return
          const diff = Y.encodeStateAsUpdate(this.document, fromBase64(sv))
          this.send('sync-reply', {
            to: from,
            from: this.document.clientID,
            u: toBase64(diff),
            sv: toBase64(Y.encodeStateVector(this.document)),
          } satisfies SyncReplyPayload)
          break
        }
        case 'sync-reply': {
          const { to, u, sv, from } = payload as SyncReplyPayload
          if (to !== this.document.clientID) return
          Y.applyUpdate(this.document, fromBase64(u), this)
          // Send the responder whatever it is missing from us.
          const missing = Y.encodeStateAsUpdate(this.document, fromBase64(sv))
          if (!isEmptyUpdate(missing)) {
            this.send('update', { u: toBase64(missing), to: from } satisfies UpdatePayload)
          }
          break
        }
      }
    } catch (error) {
      this.emit('error', { error: toError(error), context: 'message' })
    }
  }

  // ---------------------------------------------------------------------------
  // Awareness
  // ---------------------------------------------------------------------------

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return // applied from a peer
    if (!this.channel || this.status !== 'connected') return
    const changed = [...added, ...updated, ...removed]
    if (changed.length === 0) return
    const update = encodeAwarenessUpdate(this.awareness, changed)
    this.send('awareness', { a: toBase64(update) } satisfies AwarenessPayload)
  }

  private broadcastLocalAwareness(): void {
    if (this.awareness.getLocalState() === null) return
    const update = encodeAwarenessUpdate(this.awareness, [this.document.clientID])
    this.send('awareness', { a: toBase64(update) } satisfies AwarenessPayload)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    if (this.options.awarenessHeartbeatMs <= 0) return
    this.heartbeatTimer = setInterval(() => this.broadcastLocalAwareness(), this.options.awarenessHeartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private handleUnload = (): void => {
    removeAwarenessStates(this.awareness, [this.document.clientID], 'window unload')
    void this.flush()
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, this.options.saveDebounceMs)
  }

  private save(): Promise<void> {
    if (this.savePromise) {
      // A write is in flight; run again afterwards if anything changed meanwhile.
      return this.savePromise.then(() => (this.dirty ? this.save() : undefined))
    }
    if (!this.dirty) return Promise.resolve()
    this.dirty = false
    const state = Y.encodeStateAsUpdate(this.document)
    this.savePromise = this.storeState(state)
      .then(() => {
        this.saveFailures = 0
        this.version++
        this.emit('save', { version: this.version })
      })
      .catch((error: unknown) => {
        this.dirty = true
        this.saveFailures++
        this.emit('error', { error: toError(error), context: 'save' })
        const delay = Math.min(this.options.saveDebounceMs * 2 ** this.saveFailures, this.options.maxReconnectDelayMs)
        if (!this.destroyed) {
          if (this.saveTimer) clearTimeout(this.saveTimer)
          this.saveTimer = setTimeout(() => {
            this.saveTimer = null
            void this.save()
          }, delay)
        }
      })
      .finally(() => {
        this.savePromise = null
      })
    return this.savePromise
  }

  private table() {
    const { schema, table } = this.options
    return schema ? this.supabase.schema(schema).from(table) : this.supabase.from(table)
  }

  private async loadState(): Promise<Uint8Array | null> {
    if (this.options.load) return this.options.load()
    const { nameColumn, contentColumn, name } = this.options
    const { data, error } = await this.table().select(contentColumn).eq(nameColumn, name).maybeSingle()
    if (error) throw new Error(`load failed: ${error.message}`)
    const encoded = (data as Record<string, unknown> | null)?.[contentColumn]
    if (typeof encoded !== 'string' || encoded.length === 0) return null
    return fromBase64(encoded)
  }

  private async storeState(state: Uint8Array): Promise<void> {
    if (this.options.save) return this.options.save(state)
    const { nameColumn, contentColumn, name, persistMode, onConflict, extraRow } = this.options
    const encoded = toBase64(state)
    if (persistMode === 'update') {
      const { error } = await this.table().update({ [contentColumn]: encoded }).eq(nameColumn, name)
      if (error) throw new Error(`save failed: ${error.message}`)
      return
    }
    const { error } = await this.table().upsert(
      { ...(extraRow ?? {}), [nameColumn]: name, [contentColumn]: encoded },
      { onConflict: onConflict ?? nameColumn },
    )
    if (error) throw new Error(`save failed: ${error.message}`)
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  private send(event: string, payload: Record<string, unknown>): void {
    const channel = this.channel
    if (!channel) return
    const serialized = JSON.stringify(payload)
    if (serialized.length <= this.options.chunkSize) {
      void channel.send({ type: 'broadcast', event, payload })
      return
    }
    const id = `${this.document.clientID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const n = Math.ceil(serialized.length / this.options.chunkSize)
    for (let i = 0; i < n; i++) {
      const part = serialized.slice(i * this.options.chunkSize, (i + 1) * this.options.chunkSize)
      void channel.send({ type: 'broadcast', event: 'chunk', payload: { id, event, i, n, part } satisfies ChunkPayload })
    }
  }

  private handleChunk(chunk: ChunkPayload): void {
    let entry = this.chunks.get(chunk.id)
    if (!entry) {
      entry = { event: chunk.event, parts: new Array<string | undefined>(chunk.n), received: 0, n: chunk.n }
      this.chunks.set(chunk.id, entry)
    }
    if (entry.parts[chunk.i] === undefined) {
      entry.parts[chunk.i] = chunk.part
      entry.received++
    }
    if (entry.received < entry.n) return
    this.chunks.delete(chunk.id)
    try {
      this.handleMessage(entry.event, JSON.parse(entry.parts.join('')))
    } catch (error) {
      this.emit('error', { error: toError(error), context: 'message' })
    }
  }
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** An update that carries no structs and no deletions encodes to exactly two zero bytes. */
function isEmptyUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2 && update.every((b) => b === 0)
}
