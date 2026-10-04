-- TKM SMOKE · 010 — Caixa (saldo, aportes, retiradas, empréstimos) e edição/exclusão de despesas manuais.
-- Caixa ≠ resultado: empréstimo entra no caixa mas não é receita; pagar o principal sai do caixa mas não é despesa
-- (somente juros viram despesa). Exclusões são lógicas (o histórico fica guardado).
begin;

create table if not exists public.cash_entries (
 id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('saldo_inicial','aporte','retirada','emprestimo','pagamento_emprestimo')),
 amount numeric(14,2) not null check(amount>0),
 date date not null,
 description text not null default '',
 loan_id uuid references public.cash_entries(id),
 interest numeric(14,2) not null default 0 check(interest>=0),
 canceled_at timestamptz,
 request_id uuid not null unique,
 created_at timestamptz not null default now(),
 created_by uuid references auth.users(id),
 check((kind='pagamento_emprestimo')=(loan_id is not null))
);
create index if not exists cash_entries_date on public.cash_entries(date);
alter table public.cash_entries enable row level security;
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='cash_entries' and policyname='operator_read') then
  create policy operator_read on public.cash_entries for select to authenticated using ((select public.is_operator()));
 end if;
end $$;
revoke all on public.cash_entries from anon, authenticated;
grant select on public.cash_entries to authenticated;

alter table public.expenses add column if not exists canceled_at timestamptz;
alter table public.expenses add column if not exists updated_at timestamptz;

-- Saldo em aberto de um empréstimo (principal recebido − principal pago).
create or replace function public.loan_open(lid uuid) returns numeric language sql stable security definer set search_path='' as $$
 select l.amount-coalesce((select sum(p.amount-p.interest) from public.cash_entries p where p.loan_id=l.id and p.canceled_at is null),0)
 from public.cash_entries l where l.id=lid;
$$;
revoke all on function public.loan_open(uuid) from public,anon,authenticated;

create or replace function public.record_cash_entry(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare eid uuid; rid uuid; k text; amt numeric; jur numeric; dt date; lid uuid; l public.cash_entries; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid; if rid is null then raise exception 'Identificador obrigatório'; end if;
 select id into eid from public.cash_entries where request_id=rid; if found then return eid; end if;
 k:=p->>'kind'; amt:=round((p->>'amount')::numeric,2); jur:=round(coalesce(nullif(p->>'interest','')::numeric,0),2);
 dt:=coalesce(nullif(p->>'date','')::date,(now() at time zone 'America/Sao_Paulo')::date);
 if k not in ('saldo_inicial','aporte','retirada','emprestimo','pagamento_emprestimo') then raise exception 'Tipo de lançamento inválido'; end if;
 if amt is null or amt<=0 then raise exception 'Informe um valor maior que zero'; end if;
 if dt>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'A data não pode ser futura'; end if;
 if k='pagamento_emprestimo' then
  lid:=(p->>'loan_id')::uuid;
  select * into l from public.cash_entries where id=lid and kind='emprestimo' and canceled_at is null;
  if not found then raise exception 'Escolha o empréstimo que está sendo pago'; end if;
  if jur<0 or jur>=amt then raise exception 'Os juros devem ser menores que o valor pago'; end if;
  if amt-jur>public.loan_open(lid)+0.004 then raise exception 'O valor pago (sem juros) é maior que o saldo em aberto do empréstimo (R$ %)',public.loan_open(lid); end if;
 else jur:=0; lid:=null;
 end if;
 insert into public.cash_entries(kind,amount,date,description,loan_id,interest,request_id,created_by)
 values(k,amt,dt,coalesce(trim(p->>'description'),''),lid,jur,rid,auth.uid()) returning id into eid;
 if jur>0 then
  insert into public.expenses(category,description,amount,date,source,external_id,created_by,request_id)
  values('Outros','Juros do empréstimo'||coalesce(' — '||nullif(l.description,''),''),jur,dt,'caixa',eid::text,auth.uid(),gen_random_uuid());
 end if;
 return eid;
end $$;

create or replace function public.cancel_cash_entry(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare e public.cash_entries; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 select * into e from public.cash_entries where id=(p->>'id')::uuid; if not found then raise exception 'Lançamento não encontrado'; end if;
 if e.canceled_at is not null then return e.id; end if;
 if e.kind='emprestimo' and exists(select 1 from public.cash_entries where loan_id=e.id and canceled_at is null) then
  raise exception 'Este empréstimo tem pagamentos registrados. Exclua os pagamentos antes.';
 end if;
 update public.cash_entries set canceled_at=now() where id=e.id;
 update public.expenses set canceled_at=now() where source='caixa' and external_id=e.id::text;
 return e.id;
end $$;

-- Despesas manuais: editar e excluir (exclusão lógica). Entregas de venda e juros são gerenciados na origem.
create or replace function public.update_expense(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare x public.expenses; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 select * into x from public.expenses where id=(p->>'id')::uuid and canceled_at is null; if not found then raise exception 'Despesa não encontrada'; end if;
 if x.source<>'manual' then raise exception 'Esta despesa é gerada automaticamente (venda ou empréstimo). Corrija na origem.'; end if;
 if coalesce((p->>'amount')::numeric,0)<=0 or length(trim(coalesce(p->>'description','')))=0 or (p->>'date') is null then raise exception 'Preencha os dados da despesa'; end if;
 update public.expenses set category=p->>'category',description=trim(p->>'description'),amount=round((p->>'amount')::numeric,2),date=(p->>'date')::date,updated_at=now() where id=x.id;
 return x.id;
end $$;

create or replace function public.cancel_expense(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare x public.expenses; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 select * into x from public.expenses where id=(p->>'id')::uuid; if not found then raise exception 'Despesa não encontrada'; end if;
 if x.source<>'manual' then raise exception 'Esta despesa é gerada automaticamente (venda ou empréstimo). Corrija na origem.'; end if;
 update public.expenses set canceled_at=coalesce(canceled_at,now()) where id=x.id;
 return x.id;
end $$;
revoke all on function public.record_cash_entry(jsonb),public.cancel_cash_entry(jsonb),public.update_expense(jsonb),public.cancel_expense(jsonb) from public,anon;
grant execute on function public.record_cash_entry(jsonb),public.cancel_cash_entry(jsonb),public.update_expense(jsonb),public.cancel_expense(jsonb) to authenticated;

-- Snapshot: despesas excluídas ficam fora; caixa incluído.
create or replace function public.get_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.is_operator() then raise exception 'Usuário sem autorização. Cadastre este usuário em app_users.'; end if;
 return jsonb_build_object(
 'products',coalesce((select jsonb_agg(t order by t.model) from public.products t),'[]'::jsonb),
 'variants',coalesce((select jsonb_agg(t order by t.name) from public.variants t),'[]'::jsonb),
 'batches',coalesce((select jsonb_agg(t order by t.created_at) from public.batches t),'[]'::jsonb),
 'batch_items',coalesce((select jsonb_agg(t) from public.batch_items t),'[]'::jsonb),
 'sales',coalesce((select jsonb_agg(t order by t.created_at) from public.sales t),'[]'::jsonb),
 'sale_items',coalesce((select jsonb_agg(t) from public.sale_items t),'[]'::jsonb),
 'expenses',coalesce((select jsonb_agg(t order by t.date) from public.expenses t where t.canceled_at is null),'[]'::jsonb),
 'movements',coalesce((select jsonb_agg(t order by t.created_at) from public.movements t),'[]'::jsonb),
 'cash',coalesce((select jsonb_agg(t order by t.date,t.created_at) from public.cash_entries t where t.canceled_at is null),'[]'::jsonb),
 'settings',(select to_jsonb(s) from public.app_settings s where s.id=1));
end $$;

commit;
