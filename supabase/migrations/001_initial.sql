-- Clara V1. Execute como postgres no SQL Editor do Supabase.
begin;
create table public.app_users (user_id uuid primary key references auth.users(id) on delete cascade);
create table public.products (
 id uuid primary key default gen_random_uuid(), brand text not null check(length(trim(brand))>0),
 model text not null check(length(trim(model))>0), category text not null,
 price numeric(14,2) not null check(price>=0), minimum integer not null default 2 check(minimum>=0), created_at timestamptz not null default now()
);
create table public.variants (
 id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id), name text not null check(length(trim(name))>0),
 quantity integer not null default 0 check(quantity>=0), value numeric(18,6) not null default 0 check(value>=0), unique(product_id,name), check(quantity>0 or value=0)
);
create table public.batches (
 id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
 name text not null, freight numeric(14,2) not null check(freight>=0), merchandise numeric(14,2) not null check(merchandise>0),
 created_at timestamptz not null default now(), created_by uuid references auth.users(id), request_id uuid not null unique
);
create table public.batch_items (
 id uuid primary key default gen_random_uuid(), batch_id uuid not null references public.batches(id), variant_id uuid not null references public.variants(id),
 quantity integer not null check(quantity>0), unit_cost numeric(14,2) not null check(unit_cost>0), freight numeric(14,2) not null check(freight>=0)
);
create table public.sales (
 id uuid primary key default gen_random_uuid(), number bigint generated always as identity unique,
 payment text not null check(payment in ('Pix','Dinheiro','Débito','Crédito')), revenue numeric(14,2) not null check(revenue>=0),
 cogs numeric(18,6) not null check(cogs>=0), card_fee numeric(14,2) not null default 0 check(card_fee>=0), note text not null default '',
 created_at timestamptz not null default now(), created_by uuid references auth.users(id), request_id uuid not null unique,
 check(payment in ('Débito','Crédito') or card_fee=0)
);
create table public.sale_items (
 id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.sales(id), variant_id uuid not null references public.variants(id),
 quantity integer not null check(quantity>0), unit_price numeric(14,2) not null check(unit_price>=0), cogs numeric(18,6) not null check(cogs>=0)
);
create table public.expenses (
 id uuid primary key default gen_random_uuid(), category text not null check(category in ('Anúncios','Entrega','Embalagem','Ferramentas/sistemas','Outros')),
 description text not null check(length(trim(description))>0), amount numeric(14,2) not null check(amount>0), date date not null,
 source text not null default 'manual', external_id text, created_at timestamptz not null default now(), created_by uuid references auth.users(id),
 request_id uuid not null unique, unique(source, external_id)
);
create table public.movements (
 id uuid primary key default gen_random_uuid(), variant_id uuid not null references public.variants(id),
 kind text not null check(kind in ('Entrada','Venda','Ajuste')), quantity integer not null check(quantity<>0), value numeric(18,6) not null,
 reference_id uuid not null, reason text not null, created_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
create index movements_variant_time on public.movements(variant_id,created_at);
create index sales_time on public.sales(created_at);
create index expenses_date on public.expenses(date);
create index sale_items_sale on public.sale_items(sale_id);
create index batch_items_batch on public.batch_items(batch_id);
create index variants_product on public.variants(product_id);

create function public.is_operator() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.app_users where user_id=auth.uid());
$$;
revoke all on function public.is_operator() from public;
grant execute on function public.is_operator() to authenticated;
alter table public.app_users enable row level security;
-- app_users não pode ser consultada/editada via API; a autorização é verificada pela função.
do $$ declare t text; begin
 foreach t in array array['products','variants','batches','batch_items','sales','sale_items','expenses','movements'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy operator_read on public.%I for select to authenticated using ((select public.is_operator()))',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
revoke all on public.app_users from anon, authenticated;

create function public.save_product(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare pid uuid; n text; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 if p->>'id' is not null then
 pid := (p->>'id')::uuid;
 update public.products set brand=trim(p->>'brand'),model=trim(p->>'model'),category=trim(p->>'category'),price=(p->>'price')::numeric,minimum=(p->>'minimum')::integer where id=pid;
 if not found then raise exception 'Produto não encontrado'; end if;
 else
 insert into public.products(brand,model,category,price,minimum) values(trim(p->>'brand'),trim(p->>'model'),trim(p->>'category'),(p->>'price')::numeric,(p->>'minimum')::integer) returning id into pid;
 end if;
 for n in select jsonb_array_elements_text(coalesce(p->'variants','[]'::jsonb)) loop
 insert into public.variants(product_id,name) values(pid,trim(n)) on conflict(product_id,name) do nothing;
 end loop;
 if not exists(select 1 from public.variants where product_id=pid) then raise exception 'Cadastre pelo menos uma variedade'; end if;
 return pid;
end $$;

create function public.record_batch(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare bid uuid; line jsonb; total numeric:=0; shipping numeric; share numeric; allocated numeric:=0; idx integer:=0; cnt integer; q integer; cost numeric; vid uuid; rid uuid;
begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid := (p->>'request_id')::uuid;
 select id into bid from public.batches where request_id=rid; if found then return bid; end if;
 cnt := jsonb_array_length(p->'items'); shipping:=round((p->>'freight')::numeric,2);
 if cnt is null or cnt<1 or cnt>200 or shipping is null or shipping<0 then raise exception 'Lote inválido'; end if;
 for line in select * from jsonb_array_elements(p->'items') loop
 q:=(line->>'quantity')::integer; cost:=round((line->>'unit_cost')::numeric,2);
 if q is null or q<=0 or cost is null or cost<=0 then raise exception 'Quantidade e custo devem ser positivos'; end if;
 total:=total+q*cost;
 end loop;
 insert into public.batches(name,freight,merchandise,created_by,request_id) values(coalesce(nullif(trim(p->>'name'),''),'Compra'),shipping,total,auth.uid(),rid) returning id into bid;
 -- Restante no último item: a soma das parcelas sempre corresponde ao frete, sem centavos perdidos.
 for line in select * from jsonb_array_elements(p->'items') loop
 idx:=idx+1; vid:=(line->>'variant_id')::uuid; q:=(line->>'quantity')::integer; cost:=round((line->>'unit_cost')::numeric,2);
 share:=case when idx=cnt then shipping-allocated else least(shipping-allocated,round(shipping*(q*cost)/total,2)) end;
 allocated:=allocated+share;
 update public.variants set quantity=quantity+q,value=value+q*cost+share where id=vid;
 if not found then raise exception 'Variedade não encontrada'; end if;
 insert into public.batch_items(batch_id,variant_id,quantity,unit_cost,freight) values(bid,vid,q,cost,share);
 insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by) values(vid,'Entrada',q,q*cost+share,bid,'Compra com frete rateado',auth.uid());
 end loop;
 return bid;
end $$;

create function public.record_sale(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; line jsonb; v public.variants; q integer; price numeric; cost numeric; v_revenue numeric:=0; v_cogs numeric:=0; fee numeric; pay text; rid uuid;
begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 select id into sid from public.sales where request_id=rid; if found then return sid; end if;
 if coalesce(jsonb_array_length(p->'items'),0) not between 1 and 200 then raise exception 'Adicione itens à venda'; end if;
 pay:=p->>'payment'; fee:=round(coalesce((p->>'card_fee')::numeric,0),2);
 insert into public.sales(payment,revenue,cogs,card_fee,note,created_by,request_id) values(pay,0,0,fee,coalesce(p->>'note',''),auth.uid(),rid) returning id into sid;
 for line in select * from jsonb_array_elements(p->'items') loop
 q:=(line->>'quantity')::integer; price:=round((line->>'unit_price')::numeric,2);
 if q is null or q<=0 or price is null or price<0 then raise exception 'Item da venda inválido'; end if;
 select * into v from public.variants where id=(line->>'variant_id')::uuid for update;
 if not found then raise exception 'Variedade não encontrada'; end if;
 if v.quantity<q then raise exception 'Estoque insuficiente para %: % disponíveis',v.name,v.quantity; end if;
 cost:=case when v.quantity=q then v.value else round(v.value*q/v.quantity,6) end;
 update public.variants set quantity=quantity-q,value=value-cost where id=v.id;
 insert into public.sale_items(sale_id,variant_id,quantity,unit_price,cogs) values(sid,v.id,q,price,cost);
 insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by) values(v.id,'Venda',-q,-cost,sid,'Venda registrada',auth.uid());
 v_revenue:=v_revenue+q*price; v_cogs:=v_cogs+cost;
 end loop;
 update public.sales set revenue=v_revenue,cogs=v_cogs where id=sid;
 return sid;
end $$;

create function public.record_expense(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare eid uuid; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 select id into eid from public.expenses where request_id=(p->>'request_id')::uuid; if found then return eid; end if;
 insert into public.expenses(category,description,amount,date,created_by,request_id)
 values(p->>'category',trim(p->>'description'),round((p->>'amount')::numeric,2),(p->>'date')::date,auth.uid(),(p->>'request_id')::uuid) returning id into eid;
 return eid;
end $$;

create function public.adjust_stock(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v public.variants; q integer; delta numeric; rid uuid; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 if rid is null then raise exception 'Identificador obrigatório'; end if;
 if exists(select 1 from public.movements where reference_id=rid and kind='Ajuste') then return rid; end if;
 q:=(p->>'quantity')::integer;
 if q is null or q=0 or length(trim(coalesce(p->>'reason','')))<3 then raise exception 'Informe quantidade diferente de zero e motivo'; end if;
 select * into v from public.variants where id=(p->>'variant_id')::uuid for update;
 if not found then raise exception 'Variedade não encontrada'; end if;
 if v.quantity+q<0 then raise exception 'O ajuste excede o estoque disponível'; end if;
 if q>0 then
 if (p->>'unit_cost') is null or (p->>'unit_cost')::numeric<0 then raise exception 'Informe o custo das unidades adicionadas'; end if;
 delta:=round((p->>'unit_cost')::numeric,2)*q;
 else delta:=case when v.quantity=-q then -v.value else round(v.value*q/v.quantity,6) end;
 end if;
 update public.variants set quantity=quantity+q,value=value+delta where id=v.id;
 insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by) values(v.id,'Ajuste',q,delta,rid,trim(p->>'reason'),auth.uid());
 return rid;
end $$;

-- Apenas funções transacionais podem gravar dados do negócio.
revoke all on function public.save_product(jsonb),public.record_batch(jsonb),public.record_sale(jsonb),public.record_expense(jsonb),public.adjust_stock(jsonb) from public, anon;
grant execute on function public.save_product(jsonb),public.record_batch(jsonb),public.record_sale(jsonb),public.record_expense(jsonb),public.adjust_stock(jsonb) to authenticated;
commit;
