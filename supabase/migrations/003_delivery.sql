-- Entrega vinculada à venda: receita cobrada e custo efetivo separados.
begin;
alter table public.sales add column delivery_charged numeric(14,2) not null default 0 check(delivery_charged>=0);
alter table public.sales add column delivery_cost numeric(14,2) not null default 0 check(delivery_cost>=0);
alter table public.expenses add column sale_id uuid unique references public.sales(id);
create or replace function public.record_sale(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; line jsonb; v public.variants; q integer; price numeric; cost numeric; v_revenue numeric:=0; v_cogs numeric:=0; fee numeric; charged numeric; delivery numeric; pay text; rid uuid;
begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 select id into sid from public.sales where request_id=rid; if found then if delivery>0 then
 insert into public.expenses(category,description,amount,date,source,sale_id,created_by,request_id)
 values('Entrega','Entrega da venda #'||(select number::text from public.sales where id=sid),delivery,(now() at time zone 'America/Sao_Paulo')::date,'venda',sid,auth.uid(),rid);
 end if;
 return sid; end if;
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
