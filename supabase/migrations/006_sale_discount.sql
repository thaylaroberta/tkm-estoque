-- TKM SMOKE · 006 — Desconto na venda.
-- Faturamento de produtos = soma (qtd × preço praticado) − desconto da venda.
-- Desconto exibido = diferença para o preço de tabela (quando vendido abaixo) + desconto da venda.
-- Não altera faturamento, CMV ou lucro de vendas já registradas.
begin;

alter table public.sales add column if not exists discount numeric(14,2) not null default 0 check(discount>=0);
alter table public.sale_items add column if not exists list_price numeric(14,2) check(list_price>=0);
alter table public.sale_items add column if not exists discount numeric(14,2) not null default 0 check(discount>=0);

-- Vendas anteriores: preço de tabela = preço atual do produto (todas foram feitas com a tabela vigente).
update public.sale_items si set list_price=p.price
from public.variants v join public.products p on p.id=v.product_id
where v.id=si.variant_id and si.list_price is null;

-- Venda com desconto em R$ rateado entre os itens pelo valor de cada um (fecha no centavo).
create or replace function public.record_sale(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; line jsonb; v public.variants; q integer; price numeric; cost numeric; v_revenue numeric:=0; v_cogs numeric:=0;
 fee numeric; charged numeric; delivery numeric; pay text; rid uuid; disc numeric; gross numeric:=0; share numeric; given numeric:=0;
 cnt integer; idx integer:=0; list numeric;
begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 select id into sid from public.sales where request_id=rid; if found then return sid; end if;
 cnt:=coalesce(jsonb_array_length(p->'items'),0);
 if cnt not between 1 and 200 then raise exception 'Adicione itens à venda'; end if;
 pay:=p->>'payment'; fee:=round(coalesce((p->>'card_fee')::numeric,0),2);
 charged:=round(coalesce((p->>'delivery_charged')::numeric,0),2);
 delivery:=round(coalesce((p->>'delivery_cost')::numeric,0),2);
 disc:=round(coalesce((p->>'discount')::numeric,0),2);
 if disc<0 then raise exception 'O desconto não pode ser negativo'; end if;
 for line in select * from jsonb_array_elements(p->'items') loop
  q:=(line->>'quantity')::integer; price:=round((line->>'unit_price')::numeric,2);
  if q is null or q<=0 or price is null or price<0 then raise exception 'Item da venda inválido'; end if;
  gross:=gross+q*price;
 end loop;
 if disc>gross then raise exception 'O desconto (R$ %) é maior que o valor dos produtos (R$ %)',disc,gross; end if;
 insert into public.sales(payment,revenue,cogs,card_fee,delivery_charged,delivery_cost,discount,note,created_by,request_id)
 values(pay,0,0,fee,charged,delivery,disc,coalesce(p->>'note',''),auth.uid(),rid) returning id into sid;
 for line in select * from jsonb_array_elements(p->'items') loop
  idx:=idx+1; q:=(line->>'quantity')::integer; price:=round((line->>'unit_price')::numeric,2);
  select * into v from public.variants where id=(line->>'variant_id')::uuid for update;
  if not found then raise exception 'Variedade não encontrada'; end if;
  if v.quantity<q then raise exception 'Estoque insuficiente para %: % disponíveis',v.name,v.quantity; end if;
  select pr.price into list from public.products pr where pr.id=v.product_id;
  cost:=case when v.quantity=q then v.value else round(v.value*q/v.quantity,6) end;
  share:=case when gross=0 then 0 when idx=cnt then disc-given else least(disc-given,round(disc*q*price/gross,2)) end;
  given:=given+share;
  update public.variants set quantity=quantity-q,value=value-cost where id=v.id;
  insert into public.sale_items(sale_id,variant_id,quantity,unit_price,list_price,discount,cogs) values(sid,v.id,q,price,list,share,cost);
  insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by) values(v.id,'Venda',-q,-cost,sid,'Venda registrada',auth.uid());
  v_cogs:=v_cogs+cost;
 end loop;
 update public.sales set revenue=gross-disc,cogs=v_cogs where id=sid;
 if delivery>0 then
  insert into public.expenses(category,description,amount,date,source,sale_id,created_by,request_id)
  values('Entrega','Entrega da venda #'||(select number::text from public.sales where id=sid),delivery,(now() at time zone 'America/Sao_Paulo')::date,'venda',sid,auth.uid(),rid);
 end if;
 return sid;
end $$;

commit;
