# @kamick/supabaseprovider

Production-ready [Yjs](https://yjs.dev) provider for [Supabase Realtime](https://supabase.com/docs/guides/realtime). Drop-in collaboration for [TipTap](https://tiptap.dev), ProseMirror, and any other Yjs-backed editor, with no extra server to run.

- **Realtime sync** over Supabase broadcast: incremental updates, not full-document blasts.
- **Peer sync protocol** so clients that were offline or joined late reconcile automatically.
- **Persistence** to a Postgres table (debounced, retried, flushed on unload). Or plug in your own `load`/`save`.
- **Awareness** (cursors, presence) with heartbeat and clean removal on disconnect.
- **Auto-reconnect** with exponential backoff.
- **Large-payload chunking** so big documents don't exceed the broadcast size limit.
- **Private channels** authorized by RLS on `realtime.messages`.
- Typed events. Zero runtime dependencies beyond `lib0` (already pulled in by Yjs).

Want a complete Next.js app with auth, sharing, RLS, and presence UI on top of this? See the [Supabase Collab Kit](https://github.com/kevinamick/supabaseprovider#kit).

## Install

```sh
npm install @kamick/supabaseprovider yjs y-protocols @supabase/supabase-js
```

## Database

Run [`sql/schema.sql`](./sql/schema.sql) in the Supabase SQL editor (or add it as a migration). It creates a `documents` table with `name` and `content` columns plus example RLS policies. Every name is configurable.

## Usage with TipTap

```ts
import { createClient } from '@supabase/supabase-js'
import { SupabaseProvider } from '@kamick/supabaseprovider'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import * as Y from 'yjs'

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)

const doc = new Y.Doc()
const provider = new SupabaseProvider(supabase, { name: 'my-document-id', document: doc })

const editor = useEditor({
  extensions: [
    StarterKit.configure({ undoRedo: false }), // Yjs handles history
    Collaboration.configure({ document: doc }),
    CollaborationCaret.configure({
      provider,
      user: { name: 'Ada', color: '#f783ac' },
    }),
  ],
})

// Later
provider.destroy()
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `name` | required | Document id. Row key and Realtime topic suffix. |
| `document` | `new Y.Doc()` | Y.Doc to bind. |
| `awareness` | `new Awareness(doc)` | Awareness instance. |
| `table` | `documents` | Table holding documents. |
| `schema` | client default | Postgres schema of `table`. |
| `nameColumn` | `name` | Column with the document id. |
| `contentColumn` | `content` | Column with the base64 Yjs state. |
| `onConflict` | `nameColumn` | `ON CONFLICT` target for upserts. |
| `persistMode` | `upsert` | `update` only updates an existing row. Use it when RLS requires the app to create rows. |
| `extraRow` | – | Extra columns written on upsert, e.g. `{ owner_id }`. |
| `load` / `save` | – | Replace the built-in storage entirely. |
| `channelPrefix` | `yjs:` | Realtime topic prefix. |
| `privateChannel` | `false` | Use a private channel authorized by `realtime.messages` policies. |
| `saveDebounceMs` | `1500` | Debounce window for persisting. |
| `awarenessHeartbeatMs` | `15000` | Re-broadcast interval for local awareness. `0` disables. |
| `chunkSize` | `200000` | Split broadcast payloads above this many characters. |
| `autoConnect` | `true` | Connect in the constructor. |
| `maxReconnectDelayMs` | `30000` | Cap for reconnect backoff. |

## Events

```ts
provider.on('status', ({ status }) => {}) // 'connecting' | 'connected' | 'disconnected'
provider.on('synced', ({ synced }) => {}) // initial load + peer sync done
provider.on('save', ({ version }) => {})  // persisted to the database
provider.on('error', ({ error, context }) => {}) // 'load' | 'save' | 'channel' | 'message'
```

`provider.status`, `provider.synced`, and `provider.hasUnsavedChanges` expose the same state synchronously. `on()` returns an unsubscribe function.

## Methods

- `connect()` / `disconnect()`: manage the Realtime channel.
- `flush()`: persist pending changes now. Resolves when the write finishes.
- `destroy()`: disconnect, flush, release listeners. Call it in your component cleanup.

## How it works

1. On connect the provider subscribes to `yjs:<name>`, loads the saved state from Postgres, and applies it.
2. It broadcasts a `sync-request` carrying its state vector. Each peer answers with the diff the requester is missing, plus its own state vector, and the requester sends back anything the peer lacks. Divergent clients converge in one round trip.
3. Local edits are broadcast as incremental Yjs updates. Remote updates are applied with the provider as origin, so they are never re-broadcast.
4. Every change marks the document dirty. After `saveDebounceMs` the full state is upserted. Failures are retried with backoff and surfaced via the `error` event.
5. Awareness updates are broadcast immediately and re-sent every `awarenessHeartbeatMs`, so peers don't expire them. Unload and `destroy()` remove the local state for everyone.

### Storage format

The full Yjs state (`Y.encodeStateAsUpdate`) is stored base64-encoded in a `text` column. That keeps the schema portable and readable from any client. For very large documents consider a `bytea` column via the `load`/`save` hooks.

### Security

Use RLS on the documents table to control who can read and write. For Realtime, set `privateChannel: true` and add policies on `realtime.messages` (see `sql/schema.sql`). Without private channels, anyone with your anon key can subscribe to a topic.

## Kit

The **Supabase Collab Kit** is a complete Next.js 16 starter built on this provider: Supabase auth, a documents list, sharing by email, owner/editor/viewer roles enforced by RLS and private Realtime channels, presence avatars, a TipTap toolbar, and a Vercel deploy guide.

## Migrating from 1.x

The constructor now takes flat options instead of `databaseDetails`:

```ts
// 1.x
new SupabaseProvider(supabase, { name, document, databaseDetails: { schema: 'public', table: 'documents', updateColumns: { name: 'name', content: 'content' }, conflictColumns: 'name' } })
// 2.x
new SupabaseProvider(supabase, { name, document, table: 'documents', nameColumn: 'name', contentColumn: 'content' })
```

`status` events now emit `{ status }` instead of an array. Updates are incremental, so 1.x and 2.x clients should not share a document at the same time. Stored data is compatible.

## Development

```sh
pnpm install
pnpm test        # vitest against an in-memory Realtime simulator
pnpm typecheck
pnpm build
```

## License

MIT © Kevin Amick
