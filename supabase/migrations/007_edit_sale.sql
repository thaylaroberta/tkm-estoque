-- TKM SMOKE · 007 — Editar e excluir vendas.
-- Regras:
--  • Pagamento, preços, desconto, entrega, taxa e observação: sempre editáveis (estoque e CMV não mudam).
--  • Trocar sabor ou quantidade: estorna a venda e lança de novo. Bloqueado se, depois da venda, houve
--    compra ou ajuste nesses sabores (o custo original não seria mais recuperável com exatidão).
--  • Excluir venda: sempre permitido; as unidades voltam ao estoque pelo mesmo custo com que saíram,
--    e a despesa de entrega vinculada é removida.
--  • A versão anterior fica guardada em sale_revisions.
begin;

alter table public.sales add column if not exists updated_at timestamptz;
create table if not exists public.sale_revisions (
 id uuid primary key default gen_random_uuid(), sale_id uuid not null, sale_number bigint not null,
 action text not null check(action in ('edit','delete')), snapshot jsonb not null,
 request_id uuid not null unique, created_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
alter table public.sale_revisions enable row level security;
drop policy if exists operator_read on public.sale_revisions;
create policy operator_read on public.sale_revisions for select to authenticated using ((select public.is_operator()));
revoke all on public.sale_revisions from anon, authenticated;
grant select on public.sale_revisions to authenticated;

create or replace function public.sale_snapshot(sid uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('sale',to_jsonb(s),'items',coalesce((select jsonb_agg(to_jsonb(i)) from public.sale_items i where i.sale_id=sid),'[]'::jsonb),
  'expense',(select to_jsonb(e) from public.expenses e where e.sale_id=sid))
 from public.sales s where s.id=sid;
$$;
revoke all on function public.sale_snapshot(uuid) from public,anon,authenticated;

-- Compra ou ajuste depois da venda nos sabores informados.
create or replace function public.sale_blockers(sid uuid, vids uuid[]) returns text language sql stable security definer set search_path='' as $$
 select string_agg(distinct p.model||' · '||v.name||' ('||lower(m.kind)||')',', ')
 from public.movements m join public.variants v on v.id=m.variant_id join public.products p on p.id=v.product_id
 join public.sales s on s.id=sid
 where m.variant_id=any(vids) and m.kind in ('Entrada','Ajuste') and m.created_at>s.created_at;
$$;
revoke all on function public.sale_blockers(uuid,uuid[]) from public,anon,authenticated;

-- Despesa de entrega vinculada: uma por venda, sempre igual ao custo informado.
create or replace function public.sync_delivery_expense(sid uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.sales; begin
 select * into s from public.sales where id=sid;
 if s.delivery_cost>0 then
  update public.expenses set amount=s.delivery_cost where sale_id=sid;
  if not found then
   insert into public.expenses(category,description,amount,date,source,sale_id,created_by,request_id)
   values('Entrega','Entrega da venda #'||s.number,s.delivery_cost,(s.created_at at time zone 'America/Sao_Paulo')::date,'venda',sid,auth.uid(),s.request_id);
  end if;
 else
  delete from public.expenses where sale_id=sid;
 end if;
end $$;
revoke all on function public.sync_delivery_expense(uuid) from public,anon,authenticated;

-- Núcleo da venda (nova ou relançada): valida, rateia desconto, baixa estoque ao custo médio, grava itens e movimentos.
create or replace function public.apply_sale(target uuid, p jsonb, keep_list jsonb default '{}'::jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid:=target; line jsonb; v public.variants; q integer; price numeric; cost numeric; v_cogs numeric:=0;
 fee numeric; charged numeric; delivery numeric; pay text; disc numeric; gross numeric:=0; share numeric; given numeric:=0;
 cnt integer; idx integer:=0; list numeric; stamp timestamptz;
begin
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
 if sid is null then
  insert into public.sales(payment,revenue,cogs,card_fee,delivery_charged,delivery_cost,discount,note,created_by,request_id)
  values(pay,0,0,fee,charged,delivery,disc,coalesce(p->>'note',''),auth.uid(),(p->>'request_id')::uuid) returning id,created_at into sid,stamp;
 else
  update public.sales set payment=pay,card_fee=fee,delivery_charged=charged,delivery_cost=delivery,discount=disc,note=coalesce(p->>'note',''),updated_at=now()
  where id=sid returning created_at into stamp;
 end if;
 for line in select * from jsonb_array_elements(p->'items') loop
  idx:=idx+1; q:=(line->>'quantity')::integer; price:=round((line->>'unit_price')::numeric,2);
  select * into v from public.variants where id=(line->>'variant_id')::uuid for update;
  if not found then raise exception 'Variedade não encontrada'; end if;
  if v.quantity<q then raise exception 'Estoque insuficiente para %: % disponíveis',v.name,v.quantity; end if;
  list:=(keep_list->>(v.id::text))::numeric;
  if list is null then select pr.price into list from public.products pr where pr.id=v.product_id; end if;
  cost:=case when v.quantity=q then v.value else round(v.value*q/v.quantity,6) end;
  share:=case when gross=0 then 0 when idx=cnt then disc-given else least(disc-given,round(disc*q*price/gross,2)) end;
  given:=given+share;
  update public.variants set quantity=quantity-q,value=value-cost where id=v.id;
  insert into public.sale_items(sale_id,variant_id,quantity,unit_price,list_price,discount,cogs) values(sid,v.id,q,price,list,share,cost);
  insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by,created_at) values(v.id,'Venda',-q,-cost,sid,'Venda registrada',auth.uid(),stamp);
  v_cogs:=v_cogs+cost;
 end loop;
 update public.sales set revenue=gross-disc,cogs=v_cogs where id=sid;
 perform public.sync_delivery_expense(sid);
 return sid;
end $$;
revoke all on function public.apply_sale(uuid,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.record_sale(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 select id into sid from public.sales where request_id=(p->>'request_id')::uuid; if found then return sid; end if;
 return public.apply_sale(null,p);
end $$;

-- Devolve as unidades ao estoque pelo custo com que saíram e apaga itens/movimentos da venda.
create or replace function public.reverse_sale(sid uuid) returns void language plpgsql security definer set search_path='' as $$
declare i public.sale_items; begin
 for i in select * from public.sale_items where sale_id=sid loop
  update public.variants set quantity=quantity+i.quantity,value=value+i.cogs where id=i.variant_id;
 end loop;
 delete from public.movements where reference_id=sid and kind='Venda';
 delete from public.sale_items where sale_id=sid;
end $$;
revoke all on function public.reverse_sale(uuid) from public,anon,authenticated;

create or replace function public.update_sale(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; rid uuid; s public.sales; same boolean; blockers text; old_vids uuid[]; new_vids uuid[]; keep jsonb;
 line jsonb; it record; gross numeric:=0; disc numeric; given numeric:=0; share numeric; cnt integer; idx integer:=0; price numeric;
begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid; sid:=(p->>'sale_id')::uuid;
 if rid is null or sid is null then raise exception 'Identificador obrigatório'; end if;
 if exists(select 1 from public.sale_revisions where request_id=rid) then return sid; end if;
 select * into s from public.sales where id=sid; if not found then raise exception 'Venda não encontrada'; end if;
 cnt:=coalesce(jsonb_array_length(p->'items'),0);
 if cnt not between 1 and 200 then raise exception 'Adicione itens à venda'; end if;
 -- Mesmos sabores e quantidades (na mesma ordem)? Então é só edição financeira.
 select coalesce(array_agg(variant_id order by id),'{}') into old_vids from public.sale_items where sale_id=sid;
 select coalesce(array_agg((x->>'variant_id')::uuid),'{}') into new_vids from jsonb_array_elements(p->'items') x;
 select (select jsonb_agg(jsonb_build_array(variant_id,quantity) order by variant_id,quantity) from public.sale_items where sale_id=sid)
      = (select jsonb_agg(jsonb_build_array((x->>'variant_id')::uuid,(x->>'quantity')::integer) order by (x->>'variant_id')::uuid,(x->>'quantity')::integer) from jsonb_array_elements(p->'items') x)
 into same;
 insert into public.sale_revisions(sale_id,sale_number,action,snapshot,request_id,created_by) values(sid,s.number,'edit',public.sale_snapshot(sid),rid,auth.uid());
 if coalesce(same,false) then
  disc:=round(coalesce((p->>'discount')::numeric,0),2);
  if disc<0 then raise exception 'O desconto não pode ser negativo'; end if;
  for line in select * from jsonb_array_elements(p->'items') loop
   price:=round((line->>'unit_price')::numeric,2);
   if price is null or price<0 then raise exception 'Item da venda inválido'; end if;
   gross:=gross+(line->>'quantity')::integer*price;
  end loop;
  if disc>gross then raise exception 'O desconto (R$ %) é maior que o valor dos produtos (R$ %)',disc,gross; end if;
  -- Casa cada linha nova com um item existente do mesmo sabor e quantidade; custo (CMV) preservado.
  for it in
   with l as (select (x->>'variant_id')::uuid vid,(x->>'quantity')::integer q,round((x->>'unit_price')::numeric,2) price,
               row_number() over (partition by x->>'variant_id',x->>'quantity' order by ord) n
              from jsonb_array_elements(p->'items') with ordinality t(x,ord)),
        si as (select id,variant_id,quantity,row_number() over (partition by variant_id,quantity order by id) n from public.sale_items where sale_id=sid)
   select si.id, l.price, si.quantity from si join l on l.vid=si.variant_id and l.q=si.quantity and l.n=si.n order by si.id loop
   idx:=idx+1;
   share:=case when gross=0 then 0 when idx=cnt then disc-given else least(disc-given,round(disc*it.quantity*it.price/gross,2)) end;
   given:=given+share;
   update public.sale_items set unit_price=it.price,discount=share where id=it.id;
  end loop;
  update public.sales set payment=p->>'payment',card_fee=round(coalesce((p->>'card_fee')::numeric,0),2),delivery_charged=round(coalesce((p->>'delivery_charged')::numeric,0),2),
   delivery_cost=round(coalesce((p->>'delivery_cost')::numeric,0),2),discount=disc,revenue=gross-disc,note=coalesce(p->>'note',''),updated_at=now() where id=sid;
  perform public.sync_delivery_expense(sid);
  return sid;
 end if;
 blockers:=public.sale_blockers(sid,old_vids||new_vids);
 if blockers is not null then raise exception 'Depois desta venda houve compra ou ajuste em % . Para não alterar custos, só dá para mudar preço, desconto, pagamento e entrega. Para trocar sabor ou quantidade, exclua a venda e lance de novo.',blockers; end if;
 select coalesce(jsonb_object_agg(variant_id::text,list_price),'{}'::jsonb) into keep from public.sale_items where sale_id=sid and list_price is not null;
 perform public.reverse_sale(sid);
 return public.apply_sale(sid,p,keep);
end $$;

create or replace function public.delete_sale(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; rid uuid; s public.sales; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid; sid:=(p->>'sale_id')::uuid;
 if rid is null or sid is null then raise exception 'Identificador obrigatório'; end if;
 if exists(select 1 from public.sale_revisions where request_id=rid) then return sid; end if;
 select * into s from public.sales where id=sid; if not found then raise exception 'Venda não encontrada'; end if;
 insert into public.sale_revisions(sale_id,sale_number,action,snapshot,request_id,created_by) values(sid,s.number,'delete',public.sale_snapshot(sid),rid,auth.uid());
 perform public.reverse_sale(sid);
 delete from public.expenses where sale_id=sid;
 delete from public.sales where id=sid;
 return sid;
end $$;
revoke all on function public.update_sale(jsonb),public.delete_sale(jsonb) from public,anon;
grant execute on function public.update_sale(jsonb),public.delete_sale(jsonb) to authenticated;

commit;
