/**
 * In-memory stand-in for the parts of supabase-js the provider touches:
 * realtime broadcast channels (with topic fan-out) and a Postgres table
 * accessed via the query builder. Messages are delivered asynchronously,
 * like the real thing, so ordering bugs show up in tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

type BroadcastHandler = (msg: { type: 'broadcast'; event: string; payload: unknown }) => void
type SubscribeCallback = (status: 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED', err?: Error) => void

export class FakeHub {
  topics = new Map<string, Set<FakeChannel>>()
  tables = new Map<string, Map<string, Record<string, unknown>>>()
  sent: { topic: string; event: string; payload: unknown }[] = []
  /** Set to simulate a broken database connection. */
  dbError: string | null = null
  /** Drop broadcasts (simulates a partition) while true. */
  dropBroadcasts = false

  table(name: string): Map<string, Record<string, unknown>> {
    let t = this.tables.get(name)
    if (!t) {
      t = new Map()
      this.tables.set(name, t)
    }
    return t
  }

  join(channel: FakeChannel): void {
    let set = this.topics.get(channel.topic)
    if (!set) {
      set = new Set()
      this.topics.set(channel.topic, set)
    }
    set.add(channel)
  }

  leave(channel: FakeChannel): void {
    this.topics.get(channel.topic)?.delete(channel)
  }

  client(): SupabaseClient {
    return new FakeClient(this) as unknown as SupabaseClient
  }
}

export class FakeChannel {
  private handlers: { event: string; cb: BroadcastHandler }[] = []
  private callback: SubscribeCallback | null = null
  subscribed = false
  closed = false

  constructor(
    private hub: FakeHub,
    public topic: string,
    public config: unknown,
  ) {}

  on(_type: 'broadcast', filter: { event: string }, cb: BroadcastHandler): this {
    this.handlers.push({ event: filter.event, cb })
    return this
  }

  subscribe(cb: SubscribeCallback): this {
    this.callback = cb
    this.hub.join(this)
    setTimeout(() => {
      if (this.closed) return
      this.subscribed = true
      cb('SUBSCRIBED')
    }, 0)
    return this
  }

  async send(msg: { type: 'broadcast'; event: string; payload: unknown }): Promise<'ok'> {
    this.hub.sent.push({ topic: this.topic, event: msg.event, payload: msg.payload })
    if (this.hub.dropBroadcasts) return 'ok'
    // Real Realtime serializes payloads as JSON; round-trip to catch non-serializable data.
    const wire = JSON.parse(JSON.stringify(msg)) as typeof msg
    for (const peer of this.hub.topics.get(this.topic) ?? []) {
      if (peer === this || !peer.subscribed) continue
      setTimeout(() => peer.deliver(wire), 0)
    }
    return 'ok'
  }

  deliver(msg: { type: 'broadcast'; event: string; payload: unknown }): void {
    if (this.closed) return
    for (const h of this.handlers) if (h.event === msg.event) h.cb(msg)
  }

  /** Simulate the server closing the channel (network blip). */
  simulateClose(): void {
    this.subscribed = false
    this.hub.leave(this)
    this.callback?.('CLOSED')
  }

  unsubscribe(): Promise<'ok'> {
    this.closed = true
    this.subscribed = false
    this.hub.leave(this)
    return Promise.resolve('ok')
  }
}

class FakeQuery {
  private op: 'select' | 'upsert' | 'update' = 'select'
  private row: Record<string, unknown> = {}
  private conflict: string | undefined
  private filters: [string, unknown][] = []
  private single = false

  constructor(
    private hub: FakeHub,
    private tableName: string,
  ) {}

  select(_cols?: string): this {
    this.op = 'select'
    return this
  }
  upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): this {
    this.op = 'upsert'
    this.row = row
    this.conflict = opts?.onConflict
    return this
  }
  update(row: Record<string, unknown>): this {
    this.op = 'update'
    this.row = row
    return this
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, val])
    return this
  }
  maybeSingle(): this {
    this.single = true
    return this
  }

  private run(): { data: unknown; error: { message: string } | null } {
    if (this.hub.dbError) return { data: null, error: { message: this.hub.dbError } }
    const table = this.hub.table(this.tableName)
    const matches = (r: Record<string, unknown>) => this.filters.every(([c, v]) => r[c] === v)
    switch (this.op) {
      case 'select': {
        const rows = Array.from(table.values()).filter(matches)
        return { data: this.single ? (rows[0] ?? null) : rows, error: null }
      }
      case 'upsert': {
        const key = String(this.row[this.conflict ?? 'name'])
        table.set(key, { ...(table.get(key) ?? {}), ...this.row })
        return { data: null, error: null }
      }
      case 'update': {
        for (const [k, r] of table) if (matches(r)) table.set(k, { ...r, ...this.row })
        return { data: null, error: null }
      }
    }
  }

  then<T>(resolve: (v: { data: unknown; error: { message: string } | null }) => T): Promise<T> {
    return new Promise((r) => setTimeout(() => r(resolve(this.run())), 0))
  }
}

class FakeClient {
  channels: FakeChannel[] = []
  constructor(private hub: FakeHub) {}

  channel(topic: string, opts?: unknown): FakeChannel {
    const ch = new FakeChannel(this.hub, topic, opts)
    this.channels.push(ch)
    return ch
  }

  removeChannel(ch: FakeChannel): Promise<'ok'> {
    this.channels = this.channels.filter((c) => c !== ch)
    return ch.unsubscribe()
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this.hub, table)
  }

  schema(_name: string): { from: (table: string) => FakeQuery } {
    return { from: (table: string) => new FakeQuery(this.hub, table) }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(5)
  }
}
