-- TKM SMOKE · 005 — Produto único por marca+modelo e edição/exclusão de compras.
begin;

-- ── 1. Juntar produtos duplicados (mesma marca + modelo, ignorando caixa e espaços) ─────────
-- Mantém o produto mais antigo; os sabores dos duplicados passam para ele; preço = o maior do grupo;
-- estoque mínimo = o valor mais comum do grupo (empate: o menor).
-- Nenhum lançamento muda: lotes, vendas e movimentações apontam para variedades, não para produtos.
create or replace function public.product_key(brand text, model text) returns text language sql immutable set search_path='' as $$
 select lower(regexp_replace(btrim(coalesce(brand,'')),'\s+',' ','g'))||'|'||lower(regexp_replace(btrim(coalesce(model,'')),'\s+',' ','g'));
$$;
do $$
declare g record; keeper uuid; dup uuid;
begin
 for g in select public.product_key(brand,model) k, max(price) max_price, mode() within group (order by minimum) max_min, count(*) n
  from public.products group by 1 having count(*)>1 loop
  select id into keeper from public.products where public.product_key(brand,model)=g.k order by created_at,id limit 1;
  for dup in select id from public.products where public.product_key(brand,model)=g.k and id<>keeper loop
   if exists(select 1 from public.variants a join public.variants b on lower(btrim(a.name))=lower(btrim(b.name)) where a.product_id=dup and b.product_id=keeper) then
    raise exception 'Sabor repetido ao juntar produtos (%). Nada foi alterado.',g.k;
   end if;
   update public.variants set product_id=keeper where product_id=dup;
   delete from public.products where id=dup;
  end loop;
  update public.products set price=g.max_price, minimum=g.max_min where id=keeper;
 end loop;
end $$;
create unique index if not exists products_brand_model_unique on public.products(public.product_key(brand,model));

-- ── 2. Histórico de revisões de compras (versão anterior guardada) ──────────────────────────
alter table public.batches add column if not exists updated_at timestamptz;
create table if not exists public.batch_revisions (
 id uuid primary key default gen_random_uuid(), batch_id uuid not null, batch_number bigint not null,
 action text not null check(action in ('edit','rename','delete')), snapshot jsonb not null,
 request_id uuid not null unique, created_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
alter table public.batch_revisions enable row level security;
drop policy if exists operator_read on public.batch_revisions;
create policy operator_read on public.batch_revisions for select to authenticated using ((select public.is_operator()));
revoke all on public.batch_revisions from anon, authenticated;
grant select on public.batch_revisions to authenticated;

-- ── 3. Núcleo da compra: cria/atualiza lote, produtos, sabores, rateio, estoque e movimentações ─
-- Interno (não exposto): chamado por record_purchase e update_purchase, já dentro da trava.
create or replace function public.apply_purchase(target uuid, p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare
 bid uuid:=target; line jsonb; np jsonb; pu jsonb; keys jsonb:='{}'::jsonb; vids uuid[]:='{}';
 pid uuid; vid uuid; vname text; cnt integer; idx integer; q integer; cost numeric; total numeric:=0;
 shipping numeric; other numeric; fshare numeric; oshare numeric; fall numeric:=0; oall numeric:=0;
 item_value numeric; eff numeric; v public.variants; pdate date; today date; current_price numeric; stamp timestamptz;
begin
 today:=(now() at time zone 'America/Sao_Paulo')::date;
 pdate:=coalesce(nullif(p->>'purchase_date','')::date,today);
 if pdate>today then raise exception 'A data da compra não pode ser futura'; end if;
 shipping:=round(coalesce((p->>'freight')::numeric,0),2);
 other:=round(coalesce((p->>'other_costs')::numeric,0),2);
 if shipping<0 or other<0 then raise exception 'Frete e outros custos não podem ser negativos'; end if;
 cnt:=coalesce(jsonb_array_length(p->'items'),0);
 if cnt<1 or cnt>200 then raise exception 'Adicione pelo menos um produto à compra'; end if;

 -- Produtos novos: se marca+modelo já existe, reaproveita o produto (não duplica).
 for np in select * from jsonb_array_elements(coalesce(p->'new_products','[]'::jsonb)) loop
  if coalesce(np->>'key','')='' then raise exception 'Produto novo sem identificador'; end if;
  if length(trim(coalesce(np->>'brand','')))=0 or length(trim(coalesce(np->>'model','')))=0 then raise exception 'Informe marca e modelo do novo produto'; end if;
  if (np->>'price') is null or (np->>'price')::numeric<0 then raise exception 'Informe o preço de venda de %',trim(np->>'model'); end if;
  if coalesce((np->>'minimum')::integer,0)<0 then raise exception 'Estoque mínimo inválido'; end if;
  select id into pid from public.products where public.product_key(brand,model)=public.product_key(np->>'brand',np->>'model');
  if found then
   update public.products set price=round((np->>'price')::numeric,2) where id=pid;
  else
   insert into public.products(brand,model,category,price,minimum)
   values(regexp_replace(trim(np->>'brand'),'\s+',' ','g'),regexp_replace(trim(np->>'model'),'\s+',' ','g'),coalesce(nullif(trim(np->>'category'),''),'Geral'),round((np->>'price')::numeric,2),coalesce((np->>'minimum')::integer,0))
   returning id into pid;
  end if;
  keys:=keys||jsonb_build_object(np->>'key',pid);
 end loop;
 for pu in select * from jsonb_array_elements(coalesce(p->'price_updates','[]'::jsonb)) loop
  if (pu->>'price') is null or (pu->>'price')::numeric<0 then raise exception 'Preço de venda inválido'; end if;
  update public.products set price=round((pu->>'price')::numeric,2) where id=(pu->>'product_id')::uuid;
  if not found then raise exception 'Produto não encontrado para atualizar o preço'; end if;
 end loop;

 for idx in 1..cnt loop
  line:=p->'items'->(idx-1);
  q:=(line->>'quantity')::integer; cost:=round((line->>'unit_cost')::numeric,2);
  if q is null or q<=0 or cost is null or cost<=0 then raise exception 'Quantidade e custo unitário devem ser positivos'; end if;
  if nullif(line->>'variant_id','') is not null then
   vid:=(line->>'variant_id')::uuid;
   perform 1 from public.variants where id=vid; if not found then raise exception 'Variedade não encontrada'; end if;
  else
   pid:=coalesce(nullif(line->>'product_id','')::uuid,(keys->>(line->>'product_key'))::uuid);
   if pid is null then raise exception 'Selecione ou cadastre o produto do item %',idx; end if;
   perform 1 from public.products where id=pid; if not found then raise exception 'Produto não encontrado'; end if;
   vname:=regexp_replace(trim(coalesce(line->>'variant_name','')),'\s+',' ','g');
   if length(vname)=0 then raise exception 'Informe o sabor/variedade do item %',idx; end if;
   select id into vid from public.variants where product_id=pid and lower(name)=lower(vname);
   if not found then insert into public.variants(product_id,name) values(pid,vname) returning id into vid; end if;
  end if;
  vids:=vids||vid; total:=total+q*cost;
 end loop;

 if bid is null then
  insert into public.batches(name,freight,other_costs,merchandise,purchase_date,created_by,request_id)
  values(coalesce(nullif(trim(p->>'name'),''),'Compra'),shipping,other,total,pdate,auth.uid(),(p->>'request_id')::uuid) returning id,created_at into bid,stamp;
 else
  update public.batches set name=coalesce(nullif(trim(p->>'name'),''),'Compra'),freight=shipping,other_costs=other,merchandise=total,purchase_date=pdate,updated_at=now()
  where id=bid returning created_at into stamp;
 end if;

 for idx in 1..cnt loop
  line:=p->'items'->(idx-1);
  q:=(line->>'quantity')::integer; cost:=round((line->>'unit_cost')::numeric,2); item_value:=q*cost;
  fshare:=case when idx=cnt then shipping-fall else least(shipping-fall,round(shipping*item_value/total,2)) end;
  oshare:=case when idx=cnt then other-oall else least(other-oall,round(other*item_value/total,2)) end;
  fall:=fall+fshare; oall:=oall+oshare;
  eff:=round((item_value+fshare+oshare)/q,6);
  update public.variants set quantity=quantity+q,value=value+item_value+fshare+oshare where id=vids[idx] returning * into v;
  select price into current_price from public.products where id=v.product_id;
  insert into public.batch_items(batch_id,variant_id,quantity,unit_cost,freight,other_costs,effective_unit_cost,avg_cost_after,suggested_price,sale_price)
  values(bid,v.id,q,cost,fshare,oshare,eff,round(v.value/v.quantity,6),round(eff/0.53,2),current_price);
  -- A entrada mantém o momento original da compra (preserva a ordem do histórico em edições).
  insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by,created_at)
  values(v.id,'Entrada',q,item_value+fshare+oshare,bid,'Compra com frete rateado',auth.uid(),stamp);
 end loop;
 return bid;
end $$;
revoke all on function public.apply_purchase(uuid,jsonb) from public,anon,authenticated;

create or replace function public.record_purchase(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare bid uuid; rid uuid; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 if rid is null then raise exception 'Identificador obrigatório'; end if;
 select id into bid from public.batches where request_id=rid; if found then return bid; end if;
 return public.apply_purchase(null,p);
end $$;
revoke all on function public.record_purchase(jsonb) from public,anon;
grant execute on function public.record_purchase(jsonb) to authenticated;

-- ── 4. Trava: houve venda, ajuste ou outra compra nos sabores desta compra depois dela? ─────
create or replace function public.purchase_blockers(bid uuid) returns text language sql stable security definer set search_path='' as $$
 select string_agg(distinct p.model||' · '||v.name||' ('||lower(m.kind)||')',', ')
 from public.movements m join public.variants v on v.id=m.variant_id join public.products p on p.id=v.product_id
 join public.batches b on b.id=bid
 where m.variant_id in (select variant_id from public.batch_items where batch_id=bid)
 and m.reference_id<>bid and m.created_at>=b.created_at;
$$;
revoke all on function public.purchase_blockers(uuid) from public,anon,authenticated;

create or replace function public.purchase_snapshot(bid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('batch',to_jsonb(b),'items',coalesce((select jsonb_agg(to_jsonb(i)) from public.batch_items i where i.batch_id=bid),'[]'::jsonb))
 from public.batches b where b.id=bid;
$$;
revoke all on function public.purchase_snapshot(uuid) from public,anon,authenticated;

-- Desfaz o efeito da compra no estoque (exato: nada aconteceu depois nesses sabores).
create or replace function public.reverse_purchase(bid uuid) returns void language plpgsql security definer set search_path='' as $$
declare i public.batch_items; begin
 for i in select * from public.batch_items where batch_id=bid loop
  update public.variants set quantity=quantity-i.quantity,
   value=case when quantity-i.quantity=0 then 0 else greatest(0,value-(i.quantity*i.unit_cost+i.freight+i.other_costs)) end
  where id=i.variant_id;
 end loop;
 delete from public.movements where reference_id=bid and kind='Entrada';
 delete from public.batch_items where batch_id=bid;
end $$;
revoke all on function public.reverse_purchase(uuid) from public,anon,authenticated;

-- Editar compra completa: guarda a versão anterior, desfaz e lança a versão corrigida.
create or replace function public.update_purchase(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare bid uuid; rid uuid; b public.batches; blockers text; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid; bid:=(p->>'batch_id')::uuid;
 if rid is null or bid is null then raise exception 'Identificador obrigatório'; end if;
 if exists(select 1 from public.batch_revisions where request_id=rid) then return bid; end if;
 select * into b from public.batches where id=bid; if not found then raise exception 'Compra não encontrada'; end if;
 blockers:=public.purchase_blockers(bid);
 if blockers is not null then raise exception 'Esta compra já teve movimentações depois dela (%). Só é possível alterar nome e data.',blockers; end if;
 insert into public.batch_revisions(batch_id,batch_number,action,snapshot,request_id,created_by) values(bid,b.number,'edit',public.purchase_snapshot(bid),rid,auth.uid());
 perform public.reverse_purchase(bid);
 return public.apply_purchase(bid,p);
end $$;

-- Só nome e data: sempre permitido (não mexe em estoque nem custo).
create or replace function public.rename_purchase(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare bid uuid; rid uuid; b public.batches; pdate date; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid; bid:=(p->>'batch_id')::uuid;
 if rid is null or bid is null then raise exception 'Identificador obrigatório'; end if;
 if exists(select 1 from public.batch_revisions where request_id=rid) then return bid; end if;
 select * into b from public.batches where id=bid; if not found then raise exception 'Compra não encontrada'; end if;
 pdate:=coalesce(nullif(p->>'purchase_date','')::date,b.purchase_date);
 if pdate>(now() at time zone 'America/Sao_Paulo')::date then raise exception 'A data da compra não pode ser futura'; end if;
 insert into public.batch_revisions(batch_id,batch_number,action,snapshot,request_id,created_by) values(bid,b.number,'rename',public.purchase_snapshot(bid),rid,auth.uid());
 update public.batches set name=coalesce(nullif(trim(p->>'name'),''),b.name),purchase_date=pdate,updated_at=now() where id=bid;
 return bid;
end $$;

-- Excluir compra: desfaz o estoque e remove o lote. Produtos e sabores continuam cadastrados.
create or replace function public.delete_purchase(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare bid uuid; rid uuid; b public.batches; blockers text; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid; bid:=(p->>'batch_id')::uuid;
 if rid is null or bid is null then raise exception 'Identificador obrigatório'; end if;
 if exists(select 1 from public.batch_revisions where request_id=rid) then return bid; end if;
 select * into b from public.batches where id=bid; if not found then raise exception 'Compra não encontrada'; end if;
 blockers:=public.purchase_blockers(bid);
 if blockers is not null then raise exception 'Esta compra já teve movimentações depois dela (%). Não é possível excluir; use ajuste de estoque.',blockers; end if;
 insert into public.batch_revisions(batch_id,batch_number,action,snapshot,request_id,created_by) values(bid,b.number,'delete',public.purchase_snapshot(bid),rid,auth.uid());
 perform public.reverse_purchase(bid);
 delete from public.batches where id=bid;
 return bid;
end $$;
revoke all on function public.update_purchase(jsonb),public.rename_purchase(jsonb),public.delete_purchase(jsonb) from public,anon;
grant execute on function public.update_purchase(jsonb),public.rename_purchase(jsonb),public.delete_purchase(jsonb) to authenticated;

-- Cadastro avulso de produto também não duplica marca+modelo.
create or replace function public.save_product(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare pid uuid; n text; existing uuid; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 select id into existing from public.products where public.product_key(brand,model)=public.product_key(p->>'brand',p->>'model') and (p->>'id' is null or id<>(p->>'id')::uuid);
 if found then raise exception 'Já existe um produto % · %. Edite esse produto para adicionar sabores.',trim(p->>'brand'),trim(p->>'model'); end if;
 if p->>'id' is not null then
  pid:=(p->>'id')::uuid;
  update public.products set brand=trim(p->>'brand'),model=trim(p->>'model'),category=trim(p->>'category'),price=(p->>'price')::numeric,minimum=(p->>'minimum')::integer where id=pid;
  if not found then raise exception 'Produto não encontrado'; end if;
 else
  insert into public.products(brand,model,category,price,minimum) values(trim(p->>'brand'),trim(p->>'model'),trim(p->>'category'),(p->>'price')::numeric,(p->>'minimum')::integer) returning id into pid;
 end if;
 for n in select jsonb_array_elements_text(coalesce(p->'variants','[]'::jsonb)) loop
  if not exists(select 1 from public.variants where product_id=pid and lower(name)=lower(trim(n))) then insert into public.variants(product_id,name) values(pid,trim(n)); end if;
 end loop;
 if not exists(select 1 from public.variants where product_id=pid) then raise exception 'Cadastre pelo menos uma variedade'; end if;
 return pid;
end $$;

commit;
