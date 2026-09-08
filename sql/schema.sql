-- @kamick/supabaseprovider — minimal schema
--
-- One row per document. `content` stores the full Yjs state, base64-encoded.
-- Adjust names freely; pass them to the provider via `table`, `nameColumn`,
-- `contentColumn`.

create table if not exists public.documents (
  name        text primary key,
  content     text,
  updated_at  timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security (recommended)
--
-- The example below lets any signed-in user read and write any document.
-- Replace the `using`/`with check` expressions with your own ownership or
-- membership rules. See the kit's migrations for a full owner + members model.
-- ---------------------------------------------------------------------------

alter table public.documents enable row level security;

drop policy if exists "documents: authenticated read" on public.documents;
create policy "documents: authenticated read"
  on public.documents for select
  to authenticated using (true);

drop policy if exists "documents: authenticated insert" on public.documents;
create policy "documents: authenticated insert"
  on public.documents for insert
  to authenticated with check (true);

drop policy if exists "documents: authenticated update" on public.documents;
create policy "documents: authenticated update"
  on public.documents for update
  to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Private Realtime channels (set `privateChannel: true` on the provider)
--
-- Broadcast on a private channel is authorized by RLS on `realtime.messages`.
-- The provider's topic is `<channelPrefix><name>`, i.e. `yjs:<name>` by default.
-- ---------------------------------------------------------------------------

drop policy if exists "yjs channels: authenticated read" on realtime.messages;
create policy "yjs channels: authenticated read"
  on realtime.messages for select
  to authenticated
  using (realtime.topic() like 'yjs:%' and extension = 'broadcast');

drop policy if exists "yjs channels: authenticated write" on realtime.messages;
create policy "yjs channels: authenticated write"
  on realtime.messages for insert
  to authenticated
  with check (realtime.topic() like 'yjs:%' and extension = 'broadcast');
