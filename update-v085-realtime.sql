-- PriceLog Ver.0.85 既存環境向け
-- Supabase SQL Editorで1回だけ実行してください。

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'pricelog_documents'
  ) then
    alter publication supabase_realtime add table public.pricelog_documents;
  end if;
end $$;
