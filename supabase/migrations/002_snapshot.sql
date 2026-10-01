-- Snapshot único: uma leitura consistente, sem limite implícito de 1.000 linhas da API.
create function public.get_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.is_operator() then raise exception 'Usuário sem autorização. Cadastre este usuário em app_users.'; end if;
 return jsonb_build_object(
 'products',coalesce((select jsonb_agg(t order by t.model) from public.products t),'[]'::jsonb),
 'variants',coalesce((select jsonb_agg(t order by t.name) from public.variants t),'[]'::jsonb),
 'batches',coalesce((select jsonb_agg(t order by t.created_at) from public.batches t),'[]'::jsonb),
 'batch_items',coalesce((select jsonb_agg(t) from public.batch_items t),'[]'::jsonb),
 'sales',coalesce((select jsonb_agg(t order by t.created_at) from public.sales t),'[]'::jsonb),
 'sale_items',coalesce((select jsonb_agg(t) from public.sale_items t),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(t order by t.date) from public.expenses t),'[]'::jsonb),
 'movements',coalesce((select jsonb_agg(t order by t.created_at) from public.movements t),'[]'::jsonb));
end $$;
revoke all on function public.get_state() from public,anon;
grant execute on function public.get_state() to authenticated;
