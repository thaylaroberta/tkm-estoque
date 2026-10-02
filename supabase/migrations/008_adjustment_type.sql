-- TKM SMOKE · 008 — Tipo de ajuste de estoque: perda × correção de lançamento.
-- Correção de lançamento muda o estoque e o capital, mas não entra como perda no resultado.
begin;

alter table public.movements add column if not exists adjustment_type text check(adjustment_type in ('perda','correcao'));
update public.movements set adjustment_type='perda' where kind='Ajuste' and adjustment_type is null;
-- Ajustes de 02/10/2026 lançados para corrigir a compra (Lote 1): não são perda.
update public.movements set adjustment_type='correcao' where kind='Ajuste' and reason='Erro lançamento compra';

create or replace function public.adjust_stock(p jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v public.variants; q integer; delta numeric; rid uuid; kind_of text; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 perform pg_advisory_xact_lock(903211);
 rid:=(p->>'request_id')::uuid;
 if rid is null then raise exception 'Identificador obrigatório'; end if;
 if exists(select 1 from public.movements where reference_id=rid and kind='Ajuste') then return rid; end if;
 q:=(p->>'quantity')::integer;
 kind_of:=coalesce(nullif(p->>'adjustment_type',''),'perda');
 if kind_of not in ('perda','correcao') then raise exception 'Tipo de ajuste inválido'; end if;
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
 insert into public.movements(variant_id,kind,quantity,value,reference_id,reason,created_by,adjustment_type) values(v.id,'Ajuste',q,delta,rid,trim(p->>'reason'),auth.uid(),kind_of);
 return rid;
end $$;

commit;
