-- TKM SMOKE · 004 — Compra/Lote como porta de entrada do estoque.
-- Aditiva: não altera nem remove dados existentes. As funções anteriores continuam disponíveis,
-- então a versão publicada do site segue funcionando até o novo frontend ser publicado.
begin;

-- Compra: data informada pela usuária (informativa/filtro) e outros custos de aquisição.
alter table public.batches add column if not exists purchase_date date;
update public.batches set purchase_date=(created_at at time zone 'America/Sao_Paulo')::date where purchase_date is null;
alter table public.batches alter column purchase_date set not null;
alter table public.batches alter column purchase_date set default ((now() at time zone 'America/Sao_Paulo')::date);
alter table public.batches add column if not exists other_costs numeric(14,2) not null default 0 check(other_costs>=0);

-- Itens: custos preservados separadamente para auditoria e precificação.
alter table public.batch_items add column if not exists other_costs numeric(14,2) not null default 0 check(other_costs>=0);
alter table public.batch_items add column if not exists effective_unit_cost numeric(18,6);
alter table public.batch_items add column if not exists avg_cost_after numeric(18,6);
alter table public.batch_items add column if not exists suggested_price numeric(14,2);
alter table public.batch_items add column if not exists sale_price numeric(14,2);
update public.batch_items set effective_unit_cost=round((quantity*unit_cost+freight+other_costs)/quantity,6) where effective_unit_cost is null;
create index if not exists batches_purchase_date on public.batches(purchase_date);

-- Compra completa em uma única transação:
-- cria produtos e variedades novos, rateia frete e outros custos, recalcula custo médio,
-- movimenta estoque, registra movimentações, guarda preço sugerido (margem 47%) e preço definido.
create or replace function public.record_purchase(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare
 bid uuid; rid uuid; line jsonb; np jsonb; pu jsonb; keys jsonb:='{}'::jsonb; vids uuid[]:='{}';
 pid uuid; vid uuid; vname text; cnt integer; idx integer; q integer; cost numeric; total numeric:=0;
 shipping numeric; other numeric; fshare numeric; oshare numeric; fall numeric:=0; oall numeric:=0;
 item_value numeric; eff numeric; v public.variants; pdate date; today date; current_price numeric;
begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 if rid is null then raise exception 'Identificador obrigatório'; end if;
 select id into bid from public.batches where request_id=rid; if found then return bid; end if;

 today:=(now() at time zone 'America/Sao_Paulo')::date;
 pdate:=coalesce(nullif(p->>'purchase_date','')::date,today);
 if pdate>today then raise exception 'A data da compra não pode ser futura'; end if;
 shipping:=round(coalesce((p->>'freight')::numeric,0),2);
 other:=round(coalesce((p->>'other_costs')::numeric,0),2);
 if shipping<0 or other<0 then raise exception 'Frete e outros custos não podem ser negativos'; end if;
 cnt:=coalesce(jsonb_array_length(p->'items'),0);
 if cnt<1 or cnt>200 then raise exception 'Adicione pelo menos um produto à compra'; end if;

 -- Novos produtos (existem independentemente do estoque).
 for np in select * from jsonb_array_elements(coalesce(p->'new_products','[]'::jsonb)) loop
  if coalesce(np->>'key','')='' then raise exception 'Produto novo sem identificador'; end if;
  if length(trim(coalesce(np->>'brand','')))=0 or length(trim(coalesce(np->>'model','')))=0 then raise exception 'Informe marca e modelo do novo produto'; end if;
  if (np->>'price') is null or (np->>'price')::numeric<0 then raise exception 'Informe o preço de venda de %',trim(np->>'model'); end if;
  if coalesce((np->>'minimum')::integer,0)<0 then raise exception 'Estoque mínimo inválido'; end if;
  insert into public.products(brand,model,category,price,minimum)
  values(trim(np->>'brand'),trim(np->>'model'),coalesce(nullif(trim(np->>'category'),''),'Geral'),round((np->>'price')::numeric,2),coalesce((np->>'minimum')::integer,0))
  returning id into pid;
  keys:=keys||jsonb_build_object(np->>'key',pid);
 end loop;

 -- Novo preço de venda escolhido para produtos existentes (nunca automático).
 for pu in select * from jsonb_array_elements(coalesce(p->'price_updates','[]'::jsonb)) loop
  if (pu->>'price') is null or (pu->>'price')::numeric<0 then raise exception 'Preço de venda inválido'; end if;
  update public.products set price=round((pu->>'price')::numeric,2) where id=(pu->>'product_id')::uuid;
  if not found then raise exception 'Produto não encontrado para atualizar o preço'; end if;
 end loop;

 -- 1ª passada: resolve/cria variedades e soma as mercadorias.
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
   vname:=trim(coalesce(line->>'variant_name',''));
   if length(vname)=0 then raise exception 'Informe o sabor/variedade do item %',idx; end if;
   insert into public.variants(product_id,name) values(pid,vname) on conflict(product_id,name) do nothing;
   select id into vid from public.variants where product_id=pid and name=vname;
  end if;
  vids:=vids||vid; total:=total+q*cost;
 end loop;

 insert into public.batches(name,freight,other_costs,merchandise,purchase_date,created_by,request_id)
 values(coalesce(nullif(trim(p->>'name'),''),'Compra'),shipping,other,total,pdate,auth.uid(),rid) returning id into bid;

 -- 2ª passada: rateio proporcional ao valor do item; o último item recebe o restante (fecha no centavo).
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
  insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by)
  values(v.id,'Entrada',q,item_value+fshare+oshare,bid,'Compra com frete rateado',auth.uid());
 end loop;
 return bid;
end $$;
revoke all on function public.record_purchase(jsonb) from public,anon;
grant execute on function public.record_purchase(jsonb) to authenticated;

-- Correção da 003: remove trecho sem efeito no caminho de repetição (idempotência).
-- Comportamento idêntico: venda repetida retorna a mesma venda sem duplicar despesa.
create or replace function public.record_sale(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; line jsonb; v public.variants; q integer; price numeric; cost numeric; v_revenue numeric:=0; v_cogs numeric:=0; fee numeric; charged numeric; delivery numeric; pay text; rid uuid;
begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 select id into sid from public.sales where request_id=rid; if found then return sid; end if;
 if coalesce(jsonb_array_length(p->'items'),0) not between 1 and 200 then raise exception 'Adicione itens à venda'; end if;
 pay:=p->>'payment'; fee:=round(coalesce((p->>'card_fee')::numeric,0),2);
 charged:=round(coalesce((p->>'delivery_charged')::numeric,0),2);
 delivery:=round(coalesce((p->>'delivery_cost')::numeric,0),2);
 insert into public.sales(payment,revenue,cogs,card_fee,delivery_charged,delivery_cost,note,created_by,request_id) values(pay,0,0,fee,charged,delivery,coalesce(p->>'note',''),auth.uid(),rid) returning id into sid;
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
 if delivery>0 then
  insert into public.expenses(category,description,amount,date,source,sale_id,created_by,request_id)
  values('Entrega','Entrega da venda #'||(select number::text from public.sales where id=sid),delivery,(now() at time zone 'America/Sao_Paulo')::date,'venda',sid,auth.uid(),rid);
 end if;
 return sid;
end $$;

commit;
