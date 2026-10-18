-- PriceLog Googleログイン・共有用
-- MealLogと同じSupabaseプロジェクトで実行する想定です。

create extension if not exists pgcrypto;

create table if not exists public.pricelog_share_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique default upper(substr(encode(gen_random_bytes(6),'hex'),1,8)),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.pricelog_share_group_members (
  group_id uuid not null references public.pricelog_share_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id,user_id)
);

create table if not exists public.pricelog_documents (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('personal','group')),
  owner_id uuid references auth.users(id) on delete cascade,
  group_id uuid references public.pricelog_share_groups(id) on delete cascade,
  data jsonb not null default '{"products":[]}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  check ((scope_type='personal' and owner_id is not null and group_id is null) or (scope_type='group' and group_id is not null and owner_id is null))
);
create unique index if not exists pricelog_personal_doc_unique on public.pricelog_documents(owner_id) where scope_type='personal';
create unique index if not exists pricelog_group_doc_unique on public.pricelog_documents(group_id) where scope_type='group';

alter table public.pricelog_share_groups enable row level security;
alter table public.pricelog_share_group_members enable row level security;
alter table public.pricelog_documents enable row level security;

-- APIから利用するのはログイン済みユーザーのみ。実際の行アクセスは下のRLSで制限します。
grant select, insert, update, delete on public.pricelog_share_groups to authenticated;
grant select, insert, update, delete on public.pricelog_share_group_members to authenticated;
grant select, insert, update, delete on public.pricelog_documents to authenticated;

create or replace function public.pricelog_is_group_member(p_group_id uuid)
returns boolean
language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.pricelog_share_group_members m
    where m.group_id=p_group_id and m.user_id=auth.uid()
  );
$$;

grant execute on function public.pricelog_is_group_member(uuid) to authenticated;

drop policy if exists "pricelog groups visible to members" on public.pricelog_share_groups;
create policy "pricelog groups visible to members" on public.pricelog_share_groups for select to authenticated using (
  owner_id = auth.uid() or public.pricelog_is_group_member(id)
);

drop policy if exists "pricelog members visible to group members" on public.pricelog_share_group_members;
create policy "pricelog members visible to group members" on public.pricelog_share_group_members for select to authenticated using (
  public.pricelog_is_group_member(group_id)
);

drop policy if exists "pricelog personal documents own" on public.pricelog_documents;
create policy "pricelog personal documents own" on public.pricelog_documents for all to authenticated using (
  scope_type='personal' and owner_id=auth.uid()
) with check (
  scope_type='personal' and owner_id=auth.uid()
);

drop policy if exists "pricelog group documents members" on public.pricelog_documents;
create policy "pricelog group documents members" on public.pricelog_documents for all to authenticated using (
  scope_type='group' and public.pricelog_is_group_member(pricelog_documents.group_id)
) with check (
  scope_type='group' and public.pricelog_is_group_member(pricelog_documents.group_id)
);

create or replace function public.pricelog_create_group(p_name text)
returns public.pricelog_share_groups
language plpgsql security definer set search_path=public as $$
declare g public.pricelog_share_groups;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into public.pricelog_share_groups(name,owner_id) values (trim(p_name),auth.uid()) returning * into g;
  insert into public.pricelog_share_group_members(group_id,user_id,role) values(g.id,auth.uid(),'owner');
  insert into public.pricelog_documents(scope_type,group_id,updated_by) values('group',g.id,auth.uid());
  return g;
end $$;

grant execute on function public.pricelog_create_group(text) to authenticated;

create or replace function public.pricelog_join_group(p_code text)
returns uuid
language plpgsql security definer set search_path=public as $$
declare gid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id into gid from public.pricelog_share_groups where upper(invite_code)=upper(trim(p_code));
  if gid is null then raise exception 'invalid invite code'; end if;
  insert into public.pricelog_share_group_members(group_id,user_id,role) values(gid,auth.uid(),'member') on conflict do nothing;
  return gid;
end $$;

grant execute on function public.pricelog_join_group(text) to authenticated;

create or replace function public.pricelog_leave_group(p_group_id uuid)
returns void
language plpgsql security definer set search_path=public as $$
declare owner uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select owner_id into owner from public.pricelog_share_groups where id=p_group_id;
  if owner is null then raise exception 'group not found'; end if;
  if owner=auth.uid() then
    delete from public.pricelog_share_groups where id=p_group_id;
  else
    delete from public.pricelog_share_group_members where group_id=p_group_id and user_id=auth.uid();
  end if;
end $$;

grant execute on function public.pricelog_leave_group(uuid) to authenticated;
