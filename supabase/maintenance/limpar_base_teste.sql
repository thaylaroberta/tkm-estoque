-- TKM SMOKE · Limpeza completa dos dados de teste (decisão: base zerada).
-- NÃO é migration. Rodar manualmente, como postgres, no SQL Editor do Supabase,
-- SOMENTE depois de conferir a contagem da PARTE A.
-- Não usa venda, saída ou ajuste para zerar: remove os registros na ordem das chaves estrangeiras.
-- Preserva: usuários (auth.users), autorização (app_users), estrutura, funções e políticas.

-- ── PARTE A · Conferência (somente leitura) ─────────────────────────────
select 'produtos' as tabela, count(*) from public.products
union all select 'variedades', count(*) from public.variants
union all select 'lotes', count(*) from public.batches
union all select 'itens de lote', count(*) from public.batch_items
union all select 'vendas', count(*) from public.sales
union all select 'itens de venda', count(*) from public.sale_items
union all select 'despesas', count(*) from public.expenses
union all select 'movimentações', count(*) from public.movements
union all select 'unidades em estoque', coalesce(sum(quantity),0) from public.variants;

-- ── PARTE B · Limpeza (transação única: qualquer erro desfaz tudo) ──────
begin;
delete from public.expenses;      -- inclui despesas de entrega vinculadas a vendas
delete from public.sale_items;
delete from public.sales;
delete from public.movements;
delete from public.batch_items;
delete from public.batches;
delete from public.variants;
delete from public.products;
-- A primeira compra real volta a ser "Lote 1" e a primeira venda "#001".
alter table public.batches alter column number restart with 1;
alter table public.sales alter column number restart with 1;
do $$ begin
 if exists(select 1 from public.products) or exists(select 1 from public.variants) or exists(select 1 from public.batches)
 or exists(select 1 from public.batch_items) or exists(select 1 from public.sales) or exists(select 1 from public.sale_items)
 or exists(select 1 from public.expenses) or exists(select 1 from public.movements) then
  raise exception 'Limpeza incompleta: nada foi apagado.';
 end if;
end $$;
commit;

-- ── PARTE C · Validação: tudo deve retornar 0 ───────────────────────────
-- Rode novamente a PARTE A. Esperado: estoque 0 unidades, capital R$ 0,00, lotes vazio.
