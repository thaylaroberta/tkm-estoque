-- TKM SMOKE · 009 — Lista de estoque para o grupo (WhatsApp).
-- Guarda como cada produto/sabor aparece na lista e os textos fixos (cabeçalho e rodapé).
-- Aditiva: não altera estoque, custos nem vendas.
begin;

alter table public.products add column if not exists list_name text;
alter table public.products add column if not exists list_emoji text;
alter table public.products add column if not exists list_price numeric(14,2) check(list_price>=0);
alter table public.variants add column if not exists list_emoji text;
alter table public.variants add column if not exists list_label text;
alter table public.variants add column if not exists list_description text;

create table if not exists public.app_settings (
 id integer primary key default 1 check(id=1), list_header text not null default '', list_footer text not null default '', updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists operator_read on public.app_settings;
create policy operator_read on public.app_settings for select to authenticated using ((select public.is_operator()));
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;

insert into public.app_settings(id,list_header,list_footer) values(1,'📣 *LISTA ATUALIZADA*😉🔥',$footer$🚨 *ESTOQUE LIMITADO!* 🚨

━━━━━━━━━━━━━━━━━━

📲 *PEDIDOS NO PRIVADO*
Ao chamar, informe *modelo + sabor* 👀

🛵 *ENTREGAMOS EM JUNDIAÍ E REGIÃO*
Consulte a taxa para sua região.

💳 *FORMAS DE PAGAMENTO*
• Pix
• Cartão _(consulte taxas)_

━━━━━━━━━━━━━━━━━━

⚠️ *INFORMAÇÕES IMPORTANTES* ⚠️

✅ Garantia de *24h pela loja* para problemas de fábrica.

❌ Após esse prazo, *NÃO realizamos trocas.*

⚠️ *NÃO COBRIMOS* problemas ou defeitos causados por mau uso.

🔞 *VENDA SOMENTE PARA MAIORES DE 18 ANOS.*

🕒 *HORÁRIO DE ATENDIMENTO*
Segunda a segunda — *09h às 02h*$footer$) on conflict(id) do nothing;

-- Pré-preenchimento com a lista usada hoje no grupo (02/10/2026).
update public.products p set list_name=x.n, list_emoji=x.e, list_price=x.price
from (values ('ignite|vnano','IGNITE V NANO 1K','🟠',40.00),('lost mary|mt20000','LOST MARY 20K','💥',80.00),
             ('waka|fasta 46k','WAKA FASTA 46K','⚡🔥',100.00),('elfbar|ice king 40k','ELFBAR ICE KING 40K','❄️🔥',115.00)) x(k,n,e,price)
where public.product_key(p.brand,p.model)=x.k and p.list_name is null;

update public.variants v set list_emoji=x.e, list_label=nullif(x.l,''), list_description=x.d
from public.products p, (values
 ('ignite|vnano','PINEAPPLE ICE','🍍','','Abacaxi gelado'),('ignite|vnano','ORANGE SODA ICE','🍊','','Refrigerante de laranja gelado'),
 ('ignite|vnano','WATERMELON ICE','🍉','','Melancia gelada'),('ignite|vnano','BLUEBERRY RASPBERRY','🫐','','Mirtilo com framboesa'),
 ('lost mary|mt20000','SOUR STRAWBERRY DRAGONFRUIT','🐉','','Morango azedo com pitaya'),('lost mary|mt20000','BERRY BURST','🫐','','Mix de frutas vermelhas'),
 ('lost mary|mt20000','GRAPE ICE','🍇','','Uva gelada'),('lost mary|mt20000','BLUE RAZZ ICE','🫐','','Framboesa azul gelada'),
 ('lost mary|mt20000','HAWAII JUICE','🌺','','Mix tropical de frutas'),('lost mary|mt20000','TOASTED BANANA','🍌','','Banana tostada'),
 ('lost mary|mt20000','PINEAPPLE LEMON','🍍🍋','','Abacaxi com limão'),('lost mary|mt20000','SUMMER GRAPE','🍇','','Uva refrescante'),
 ('lost mary|mt20000','NANA COCONUT','🍌🥥','Banana Coconut','Banana com coco'),('lost mary|mt20000','BANANA COCONUT','🍌🥥','','Banana com coco'),
 ('waka|fasta 46k','PERFECT PEACH','🍑','','Pêssego'),('waka|fasta 46k','WATERMELON','🍉','','Melancia'),('waka|fasta 46k','BLUEMELON','🍉🍈','','Melancia azul / mix refrescante'),
 ('elfbar|ice king 40k','BLUEBERRY ICE','🫐','','Mirtilo gelado'),('elfbar|ice king 40k','BUBBALOO TUTTI FRUTTI','🍬','','Chiclete tutti-frutti'),
 ('elfbar|ice king 40k','PEACH MANGO WATERMELON','🍑🥭🍉🍇','Peach Mango Watermelon Grape Ice','Pêssego, manga, melancia e uva gelados'),
 ('elfbar|ice king 40k','SCARY BERRY','🫐','','Mix de frutas vermelhas'),('elfbar|ice king 40k','DRAGON STRAWNANA','🍓🐉','Dragon Strawberry','Morango com toque tropical'),
 ('elfbar|ice king 40k','SUMMER SPLASH','🌊','','Mix tropical refrescante'),('elfbar|ice king 40k','CHERRY FUSE','🍒','','Cereja'),
 ('elfbar|ice king 40k','MANGO MAGIC','🥭','','Manga'),('elfbar|ice king 40k','STRAWBERRY ICE','🍓','','Morango gelado'),('elfbar|ice king 40k','PEACH+','🍑','','Pêssego')
) x(k,name,e,l,d)
where p.id=v.product_id and public.product_key(p.brand,p.model)=x.k and upper(btrim(v.name))=x.name and v.list_emoji is null;

-- Salva a configuração da lista (cabeçalho, rodapé, produtos e sabores) de uma vez.
create or replace function public.save_list_settings(p jsonb) returns void language plpgsql security definer set search_path='' as $$
declare x jsonb; begin
 if not public.is_operator() then raise exception 'Acesso não autorizado'; end if;
 insert into public.app_settings(id,list_header,list_footer,updated_at) values(1,coalesce(p->>'header',''),coalesce(p->>'footer',''),now())
 on conflict(id) do update set list_header=excluded.list_header,list_footer=excluded.list_footer,updated_at=now();
 for x in select * from jsonb_array_elements(coalesce(p->'list_products','[]'::jsonb)) loop
  if (x->>'list_price') is not null and (x->>'list_price')::numeric<0 then raise exception 'Preço da lista inválido'; end if;
  update public.products set list_name=nullif(trim(x->>'list_name'),''),list_emoji=nullif(trim(x->>'list_emoji'),''),list_price=round(nullif(x->>'list_price','')::numeric,2) where id=(x->>'id')::uuid;
 end loop;
 for x in select * from jsonb_array_elements(coalesce(p->'list_variants','[]'::jsonb)) loop
  update public.variants set list_emoji=nullif(trim(x->>'list_emoji'),''),list_label=nullif(trim(x->>'list_label'),''),list_description=nullif(trim(x->>'list_description'),'') where id=(x->>'id')::uuid;
 end loop;
end $$;
revoke all on function public.save_list_settings(jsonb) from public,anon;
grant execute on function public.save_list_settings(jsonb) to authenticated;

-- Snapshot passa a incluir a configuração da lista.
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
 'expenses',coalesce((select jsonb_agg(t order by t.date) from public.expenses t),'[]'::jsonb),
 'movements',coalesce((select jsonb_agg(t order by t.created_at) from public.movements t),'[]'::jsonb),
 'settings',(select to_jsonb(s) from public.app_settings s where s.id=1));
end $$;

commit;
