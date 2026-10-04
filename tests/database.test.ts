import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const UID='11111111-1111-4111-8111-111111111111';
const ALL=['001_initial.sql','002_snapshot.sql','003_delivery.sql','004_purchase_flow.sql','005_edit_purchase.sql','006_sale_discount.sql','007_edit_sale.sql','008_adjustment_type.sql','009_whatsapp_list.sql','010_cash.sql'];
async function migrate(db:PGlite,files:string[]){for(const file of files)await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));}
async function database(files=ALL){const db=new PGlite();await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon; insert into auth.users values('${UID}');`);
 await migrate(db,files);
 await db.exec(`insert into public.app_users values('${UID}');set request.jwt.claim.sub='${UID}';`);return db;}
async function rpc(db:PGlite,name:string,p:object){const result=await db.query<{id:string}>(`select public.${name}($1::jsonb) as id`,[JSON.stringify(p)]);return result.rows[0].id;}
const rid=()=>crypto.randomUUID();
test('migration e seed: totais, leitura autorizada e bloqueio de acesso anônimo',async()=>{const db=await database();try{
 await db.exec(await readFile(new URL('../supabase/seed.sql',import.meta.url),'utf8'));
 const stock=await db.query<{quantity:string;value:string}>('select sum(quantity)::text as quantity,sum(value)::text as value from variants');assert.equal(+stock.rows[0].quantity,44);assert.equal(+stock.rows[0].value,528);
 await db.exec('set role authenticated');const snapshot=await db.query<{state:{products:unknown[]}}>('select public.get_state() as state');assert.equal(snapshot.rows[0].state.products.length,3);
 await assert.rejects(db.exec("insert into products(brand,model,category,price) values('x','y','z',1)"),/permission denied/);
 await db.exec("set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'");const denied=await db.query('select * from variants');assert.equal(denied.rows.length,0);await assert.rejects(db.query('select get_state()'),/autorização/);
 await assert.rejects(rpc(db,'record_batch',{request_id:rid(),items:[],freight:0}),/autorizado/);
 await db.exec('reset role;set role anon');await assert.rejects(db.query('select * from variants'),/permission denied/);await assert.rejects(db.query('select get_state()'),/permission denied/);
 }finally{await db.close();}});
test('transações reais: rateio, média, CMV congelado, rollback, idempotência e ajustes',async()=>{const db=await database();try{
 await db.exec('set role authenticated');const pid=await rpc(db,'save_product',{brand:'Papel',model:'Agenda',category:'Papelaria',price:40,minimum:2,variants:['Azul','Rosa']});const vs=await db.query<{id:string}>('select id from variants where product_id=$1 order by name',[pid]);const [a,b]=vs.rows.map(v=>v.id);
 await rpc(db,'record_batch',{request_id:rid(),freight:10,items:[{variant_id:a,quantity:3,unit_cost:10},{variant_id:b,quantity:1,unit_cost:10}]});
 const shipping=await db.query<{sum:string}>('select sum(freight)::text from batch_items');assert.equal(+shipping.rows[0].sum,10);
 await rpc(db,'record_batch',{request_id:rid(),freight:0,items:[{variant_id:a,quantity:2,unit_cost:20}]});
 const sale={request_id:rid(),payment:'Crédito',card_fee:2,items:[{variant_id:a,quantity:1,unit_price:30}]};const sid=await rpc(db,'record_sale',sale);assert.equal(await rpc(db,'record_sale',sale),sid);
 const first=await db.query<{cogs:string;revenue:string}>('select cogs::text,revenue::text from sales where id=$1',[sid]);assert.equal(+first.rows[0].cogs,15.5);assert.equal(+first.rows[0].revenue,30);
 await assert.rejects(rpc(db,'record_sale',{request_id:rid(),payment:'Pix',items:[{variant_id:a,quantity:1,unit_price:30},{variant_id:b,quantity:99,unit_price:30}]}),/Estoque insuficiente/);
 const unchanged=await db.query<{quantity:number}>('select quantity from variants where id=$1',[a]);assert.equal(unchanged.rows[0].quantity,4);
 await rpc(db,'record_batch',{request_id:rid(),freight:0,items:[{variant_id:a,quantity:1,unit_cost:100}]});const history=await db.query<{cogs:string}>('select cogs::text from sales where id=$1',[sid]);assert.equal(+history.rows[0].cogs,15.5);
 await rpc(db,'adjust_stock',{request_id:rid(),variant_id:a,quantity:-5,reason:'Contagem'});const zero=await db.query<{quantity:number;value:string}>('select quantity,value::text from variants where id=$1',[a]);assert.equal(zero.rows[0].quantity,0);assert.equal(+zero.rows[0].value,0);
 await assert.rejects(rpc(db,'adjust_stock',{request_id:rid(),variant_id:a,quantity:-1,reason:'Avaria'}),/excede/);
 await assert.rejects(rpc(db,'record_sale',{request_id:rid(),payment:'Pix',card_fee:2,items:[{variant_id:b,quantity:1,unit_price:20}]}),/check constraint/);
 }finally{await db.close();}});
test('entregas geram despesa vinculada uma vez; lucro positivo e negativo; rollback não deixa despesas',async()=>{const db=await database();try{
 await db.exec('set role authenticated');await rpc(db,'save_product',{brand:'Papel',model:'Caderno',category:'Papelaria',price:20,minimum:1,variants:['Verde']});const vid=(await db.query<{id:string}>('select id from variants')).rows[0].id;
 await rpc(db,'record_batch',{request_id:rid(),freight:0,items:[{variant_id:vid,quantity:2,unit_cost:5}]});
 for(const cost of [7,15]){const payload={request_id:rid(),payment:'Pix',delivery_charged:10,delivery_cost:cost,items:[{variant_id:vid,quantity:1,unit_price:20}]};const sid=await rpc(db,'record_sale',payload);assert.equal(await rpc(db,'record_sale',payload),sid);const e=await db.query<{amount:string;sale_id:string}>('select amount::text,sale_id from expenses where sale_id=$1',[sid]);assert.equal(e.rows.length,1);assert.equal(+e.rows[0].amount,cost);}
 const result=await db.query<{profit:string;expense:string;revenue:string}>('select (select sum(delivery_charged-delivery_cost)::text from sales) as profit,(select sum(amount)::text from expenses) as expense,(select sum(revenue+delivery_charged)::text from sales) as revenue');assert.equal(+result.rows[0].profit,-2);assert.equal(+result.rows[0].expense,22);assert.equal(+result.rows[0].revenue,60);
 await assert.rejects(rpc(db,'record_sale',{request_id:rid(),payment:'Pix',delivery_charged:10,delivery_cost:15,items:[{variant_id:vid,quantity:1,unit_price:20}]}),/Estoque insuficiente/);const count=await db.query<{n:number}>('select count(*)::integer as n from expenses');assert.equal(count.rows[0].n,2);
 }finally{await db.close();}});

test('compra a partir da base zerada: caso a/b/c/d, 47%, custo médio, histórico e rollback',async()=>{const db=await database();try{
 await db.exec('set role authenticated');
 const empty=await db.query<{n:number}>('select (select count(*) from products)+(select count(*) from variants)+(select count(*) from batches) as n');assert.equal(Number(empty.rows[0].n),0);
 const np=(key:string,model:string,price:number)=>({key,brand:'Marca',model,category:'',price,minimum:1});
 const purchase={request_id:rid(),name:'Lote 1',purchase_date:'2026-09-30',freight:120,new_products:[np('a','Produto A',140),np('b','Produto B',96),np('c','Produto C',103),np('d','Produto D',42)],
  items:[{product_key:'a',variant_name:'Menta',quantity:6,unit_cost:66},{product_key:'b',variant_name:'Uva',quantity:10,unit_cost:46},{product_key:'c',variant_name:'Melancia',quantity:4,unit_cost:49},{product_key:'d',variant_name:'Gelo',quantity:4,unit_cost:20}]};
 const bid=await rpc(db,'record_purchase',purchase);assert.equal(await rpc(db,'record_purchase',purchase),bid);
 const items=await db.query<{model:string;freight:string;eff:string;sug:string;avg:string;sale:string}>(`select p.model,bi.freight::text,bi.effective_unit_cost::text as eff,bi.suggested_price::text as sug,bi.avg_cost_after::text as avg,bi.sale_price::text as sale from batch_items bi join variants v on v.id=bi.variant_id join products p on p.id=v.product_id order by p.model`);
 assert.deepEqual(items.rows.map(r=>Math.round(+r.eff*100)/100),[73,50.88,54.2,22.12]);
 assert.equal(Math.round(items.rows.reduce((a,r)=>a+ +r.freight,0)*100),12000);
 assert.deepEqual(items.rows.map(r=>+r.sug),items.rows.map(r=>Math.round(+r.eff/0.53*100)/100));
 assert.equal(+items.rows[0].sale,140);
 const totals=await db.query<{q:string;v:string;m:string;dt:string}>(`select (select sum(quantity)::text from variants) as q,(select sum(value)::text from variants) as v,(select count(*)::text from movements where kind='Entrada') as m,(select purchase_date::text from batches) as dt`);
 assert.equal(+totals.rows[0].q,24);assert.equal(+totals.rows[0].v,1252);assert.equal(+totals.rows[0].m,4);assert.equal(totals.rows[0].dt,'2026-09-30');
 const exp=await db.query<{n:number}>('select count(*)::integer as n from expenses');assert.equal(exp.rows[0].n,0);
 const a=(await db.query<{id:string;product_id:string}>(`select v.id,v.product_id from variants v join products p on p.id=v.product_id where p.model='Produto A'`)).rows[0];
 const sid=await rpc(db,'record_sale',{request_id:rid(),payment:'Pix',items:[{variant_id:a.id,quantity:1,unit_price:140}]});
 const before=(await db.query<{cogs:string}>('select cogs::text from sales where id=$1',[sid])).rows[0].cogs;
 // 2ª compra do mesmo produto/sabor com custo diferente e novo preço escolhido
 await rpc(db,'record_purchase',{request_id:rid(),name:'Lote 2',freight:10,items:[{product_id:a.product_id,variant_name:'Menta',quantity:5,unit_cost:70}],price_updates:[{product_id:a.product_id,price:150}]});
 const after=(await db.query<{quantity:number;value:string;avg:string;price:string}>(`select v.quantity,v.value::text,(select bi.avg_cost_after::text from batch_items bi join batches b on b.id=bi.batch_id where bi.variant_id=v.id order by b.number desc limit 1) as avg,(select price::text from products where id=v.product_id) as price from variants v where v.id=$1`,[a.id])).rows[0];
 const expectedValue=6*66+41.98-(6*66+41.98)/6+5*70+10;
 assert.equal(after.quantity,10);assert.ok(Math.abs(+after.value-expectedValue)<1e-5);assert.ok(Math.abs(+after.avg-expectedValue/10)<1e-5);assert.equal(+after.price,150);
 assert.equal((await db.query<{cogs:string}>('select cogs::text from sales where id=$1',[sid])).rows[0].cogs,before);
 const saleItem=(await db.query<{unit_price:string}>('select unit_price::text from sale_items where sale_id=$1',[sid])).rows[0];assert.equal(+saleItem.unit_price,140);
 // falha no meio não deixa produto, variedade nem lote
 const counts=async()=>(await db.query<{n:string}>('select ((select count(*) from products)*1000000+(select count(*) from variants)*1000+(select count(*) from batches))::text as n')).rows[0].n;
 const c0=await counts();
 await assert.rejects(rpc(db,'record_purchase',{request_id:rid(),freight:5,new_products:[np('x','Produto X',10)],items:[{product_key:'x',variant_name:'Coco',quantity:1,unit_cost:5},{product_key:'x',variant_name:'',quantity:1,unit_cost:5}]}),/sabor/);
 await assert.rejects(rpc(db,'record_purchase',{request_id:rid(),purchase_date:'2999-01-01',items:[{variant_id:a.id,quantity:1,unit_cost:5}]}),/futura/);
 assert.equal(await counts(),c0);
 await db.exec("set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'");await assert.rejects(rpc(db,'record_purchase',{request_id:rid(),items:[{variant_id:a.id,quantity:1,unit_cost:5}]}),/autorizado/);
 }finally{await db.close();}});
test('script de limpeza zera a base na ordem correta e reinicia a numeração de lotes',async()=>{const db=await database();try{
 await db.exec(await readFile(new URL('../supabase/seed.sql',import.meta.url),'utf8'));
 await db.exec('set role authenticated');const vid=(await db.query<{id:string}>('select id from variants limit 1')).rows[0].id;
 await rpc(db,'record_sale',{request_id:rid(),payment:'Pix',delivery_charged:10,delivery_cost:7,items:[{variant_id:vid,quantity:1,unit_price:30}]});
 await db.exec('reset role');await db.exec(await readFile(new URL('../supabase/maintenance/limpar_base_teste.sql',import.meta.url),'utf8'));
 const left=await db.query<{n:string}>('select ((select count(*) from products)+(select count(*) from variants)+(select count(*) from batches)+(select count(*) from batch_items)+(select count(*) from sales)+(select count(*) from sale_items)+(select count(*) from expenses)+(select count(*) from movements))::text as n');assert.equal(left.rows[0].n,'0');
 const users=await db.query<{n:string}>('select count(*)::text as n from app_users');assert.equal(users.rows[0].n,'1');
 await db.exec('set role authenticated');const bid=await rpc(db,'record_purchase',{request_id:rid(),freight:0,new_products:[{key:'k',brand:'B',model:'M',price:10}],items:[{product_key:'k',variant_name:'S',quantity:1,unit_cost:5}]});
 const n=await db.query<{number:string}>('select number::text from batches where id=$1',[bid]);assert.equal(n.rows[0].number,'1');
 }finally{await db.close();}});

test('005 junta produtos duplicados do lote sem mudar estoque, custo ou lote; e impede novos duplicados',async()=>{const db=await database(ALL.slice(0,4));try{
 await db.exec('set role authenticated');
 const np=(key:string,brand:string,model:string,price:number)=>({key,brand,model,category:'40000',price,minimum:2});
 await rpc(db,'record_purchase',{request_id:rid(),freight:120,new_products:[np('a','ELFBAR','ICE KING 40K',133.11),np('b','ELFBAR','ICE KING 40K',133.10),np('c','LOST MARY','MT20000',92.15),np('d','Lost Mary ',' MT20000',92.16),{...np('e','LOST MARY','MT20000',92.15),minimum:7}],
  items:[{product_key:'a',variant_name:'GRAPE ICE',quantity:1,unit_cost:65},{product_key:'b',variant_name:'CHERRY FUSE',quantity:1,unit_cost:65},{product_key:'c',variant_name:'BERRY BURST',quantity:4,unit_cost:45},{product_key:'d',variant_name:'HAWAII JUICE',quantity:1,unit_cost:45},{product_key:'e',variant_name:'NANA COCONUT',quantity:1,unit_cost:45}]});
 const before=(await db.query<{q:string;v:string;items:string;mov:string}>('select (select sum(quantity)::text from variants) q,(select sum(value)::text from variants) v,(select count(*)::text from batch_items) items,(select count(*)::text from movements) mov')).rows[0];
 await db.exec('reset role');await migrate(db,['005_edit_purchase.sql']);await db.exec('set role authenticated');
 const products=(await db.query<{model:string;price:string;n:string}>('select p.model,p.price::text,(select count(*)::text from variants v where v.product_id=p.id) n from products p order by model')).rows;
 assert.deepEqual(products.map(p=>[p.model,+p.price,+p.n]),[['ICE KING 40K',133.11,2],['MT20000',92.16,3]]);
 assert.equal((await db.query<{minimum:number}>("select minimum from products where model='MT20000'")).rows[0].minimum,2);
 const after=(await db.query<{q:string;v:string;items:string;mov:string}>('select (select sum(quantity)::text from variants) q,(select sum(value)::text from variants) v,(select count(*)::text from batch_items) items,(select count(*)::text from movements) mov')).rows[0];
 assert.deepEqual(after,before);
 // nova compra digitando o mesmo produto com outra grafia reaproveita o cadastro
 await rpc(db,'record_purchase',{request_id:rid(),freight:0,new_products:[np('x','elfbar','ice  king 40k',140)],items:[{product_key:'x',variant_name:'MANGO MAGIC',quantity:1,unit_cost:65},{product_key:'x',variant_name:'grape ice',quantity:1,unit_cost:65}]});
 const ice=(await db.query<{n:string;price:string;grape:number}>(`select (select count(*)::text from variants v join products p on p.id=v.product_id where p.model='ICE KING 40K') n,(select price::text from products where model='ICE KING 40K') price,(select quantity from variants where name='GRAPE ICE') grape`)).rows[0];
 assert.equal(+ice.n,3);assert.equal(+ice.price,140);assert.equal(ice.grape,2);assert.equal((await db.query<{n:string}>('select count(*)::text n from products')).rows[0].n,'2');
 await assert.rejects(rpc(db,'save_product',{brand:'ELFBAR',model:'Ice King 40k',category:'x',price:1,minimum:0,variants:['Uva']}),/Já existe/);
 }finally{await db.close();}});
test('editar compra: desfaz e relança com custo médio correto; trava após venda; renomear e excluir',async()=>{const db=await database();try{
 await db.exec('set role authenticated');
 const bid=await rpc(db,'record_purchase',{request_id:rid(),name:'Lote 1',purchase_date:'2026-09-26',freight:10,new_products:[{key:'k',brand:'WAKA',model:'FASTA 46K',price:100,minimum:1}],items:[{product_key:'k',variant_name:'WATERMELON',quantity:2,unit_cost:49},{product_key:'k',variant_name:'PEACH',quantity:1,unit_cost:49}]});
 const vs=(await db.query<{id:string;name:string;product_id:string}>('select id,name,product_id from variants order by name')).rows;const [peach,water]=vs;
 const edit={request_id:rid(),batch_id:bid,name:'Lote 1 corrigido',purchase_date:'2026-09-25',freight:20,items:[{variant_id:water.id,quantity:3,unit_cost:50},{product_id:water.product_id,variant_name:'BLUEMELON',quantity:1,unit_cost:50}]};
 assert.equal(await rpc(db,'update_purchase',edit),bid);assert.equal(await rpc(db,'update_purchase',edit),bid);
 const st=(await db.query<{name:string;quantity:number;value:string}>('select name,quantity,value::text from variants order by name')).rows;
 assert.deepEqual(st.map(v=>[v.name,v.quantity,+v.value]),[['BLUEMELON',1,55],['PEACH',0,0],['WATERMELON',3,165]]);
 const b=(await db.query<{number:string;name:string;d:string;f:string;m:string}>('select number::text,name,purchase_date::text d,freight::text f,merchandise::text m from batches')).rows;assert.deepEqual(b.map(x=>[x.number,x.name,x.d,+x.f,+x.m]),[['1','Lote 1 corrigido','2026-09-25',20,200]]);
 assert.equal((await db.query<{n:string}>("select count(*)::text n from movements where kind='Entrada'")).rows[0].n,'2');
 assert.equal((await db.query<{n:string}>("select count(*)::text n from batch_revisions where action='edit'")).rows[0].n,'1');
 // venda depois da compra: edição completa e exclusão travadas; nome e data continuam editáveis
 await rpc(db,'record_sale',{request_id:rid(),payment:'Pix',items:[{variant_id:water.id,quantity:1,unit_price:100}]});
 await assert.rejects(rpc(db,'update_purchase',{...edit,request_id:rid()}),/movimentações depois/);
 await assert.rejects(rpc(db,'delete_purchase',{request_id:rid(),batch_id:bid}),/movimentações depois/);
 await rpc(db,'rename_purchase',{request_id:rid(),batch_id:bid,name:'Fornecedor X',purchase_date:'2026-09-24'});
 assert.equal((await db.query<{name:string}>('select name from batches')).rows[0].name,'Fornecedor X');
 // excluir compra sem movimentação posterior
 const b2=await rpc(db,'record_purchase',{request_id:rid(),freight:0,items:[{variant_id:peach.id,quantity:4,unit_cost:30}]});
 await rpc(db,'delete_purchase',{request_id:rid(),batch_id:b2});
 const p=(await db.query<{quantity:number;value:string;n:string}>('select quantity,value::text,(select count(*)::text from batches) n from variants where id=$1',[peach.id])).rows[0];assert.equal(p.quantity,0);assert.equal(+p.value,0);assert.equal(p.n,'1');
 // usuário não autorizado
 await db.exec("set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'");await assert.rejects(rpc(db,'delete_purchase',{request_id:rid(),batch_id:bid}),/autorizado/);
 await db.exec('reset role;set role anon');await assert.rejects(rpc(db,'update_purchase',edit),/permission denied/);
 }finally{await db.close();}});

test('006: vendas antigas ganham preço de tabela sem mudar faturamento; desconto em R$ rateado entre itens',async()=>{const db=await database(ALL.slice(0,5));try{
 await db.exec('set role authenticated');
 await rpc(db,'record_purchase',{request_id:rid(),freight:0,new_products:[{key:'k',brand:'ELFBAR',model:'ICE KING 40K',price:133.11,minimum:1},{key:'m',brand:'LOST MARY',model:'MT20000',price:92.16,minimum:1}],
  items:[{product_key:'k',variant_name:'GRAPE ICE',quantity:5,unit_cost:70},{product_key:'k',variant_name:'MANGO',quantity:5,unit_cost:70},{product_key:'m',variant_name:'BLUE RAZZ',quantity:5,unit_cost:48}]});
 const v=Object.fromEntries((await db.query<{id:string;name:string}>('select id,name from variants')).rows.map(r=>[r.name,r.id]));
 const old1=await rpc(db,'record_sale',{request_id:rid(),payment:'Pix',items:[{variant_id:v['GRAPE ICE'],quantity:2,unit_price:100}]});
 const old2=await rpc(db,'record_sale',{request_id:rid(),payment:'Pix',items:[{variant_id:v['BLUE RAZZ'],quantity:1,unit_price:95}]});
 const before=(await db.query<{r:string;c:string}>('select sum(revenue)::text r,sum(cogs)::text c from sales')).rows[0];
 await db.exec('reset role');await migrate(db,['006_sale_discount.sql']);await db.exec('set role authenticated');
 assert.deepEqual((await db.query<{r:string;c:string}>('select sum(revenue)::text r,sum(cogs)::text c from sales')).rows[0],before);
 const items=(await db.query<{list:string;unit:string;disc:string}>('select list_price::text list,unit_price::text unit,discount::text disc from sale_items where sale_id in ($1,$2) order by unit_price',[old1,old2])).rows;
 assert.deepEqual(items.map(i=>[+i.list,+i.unit,+i.disc]),[[92.16,95,0],[133.11,100,0]]);
 // nova venda: tabela 133,11 + 92,16, desconto R$ 25,27
 const sid=await rpc(db,'record_sale',{request_id:rid(),payment:'Pix',discount:25.27,delivery_charged:10,items:[{variant_id:v['MANGO'],quantity:1,unit_price:133.11},{variant_id:v['BLUE RAZZ'],quantity:1,unit_price:92.16}]});
 const s=(await db.query<{revenue:string;discount:string}>('select revenue::text,discount::text from sales where id=$1',[sid])).rows[0];assert.equal(+s.revenue,200);assert.equal(+s.discount,25.27);
 const shares=(await db.query<{d:string}>('select discount::text d from sale_items where sale_id=$1 order by unit_price desc',[sid])).rows.map(r=>+r.d);
 assert.equal(Math.round(shares.reduce((a,b)=>a+b,0)*100),2527);assert.deepEqual(shares,[14.93,10.34]);
 await assert.rejects(rpc(db,'record_sale',{request_id:rid(),payment:'Pix',discount:500,items:[{variant_id:v['MANGO'],quantity:1,unit_price:133.11}]}),/maior que o valor/);
 await assert.rejects(rpc(db,'record_sale',{request_id:rid(),payment:'Pix',discount:-1,items:[{variant_id:v['MANGO'],quantity:1,unit_price:133.11}]}),/negativo/);
 assert.equal((await db.query<{q:number}>('select quantity q from variants where id=$1',[v['MANGO']])).rows[0].q,4);
 }finally{await db.close();}});

test('007: editar venda (financeiro e troca de itens), trava após compra, excluir devolve estoque e remove entrega',async()=>{const db=await database();try{
 await db.exec('set role authenticated');
 await rpc(db,'record_purchase',{request_id:rid(),freight:0,new_products:[{key:'k',brand:'ELFBAR',model:'ICE KING',price:133.11,minimum:0}],items:[{product_key:'k',variant_name:'GRAPE',quantity:5,unit_cost:70},{product_key:'k',variant_name:'MANGO',quantity:5,unit_cost:60}]});
 const v=Object.fromEntries((await db.query<{id:string;name:string}>('select id,name from variants')).rows.map(r=>[r.name,r.id]));
 const sid=await rpc(db,'record_sale',{request_id:rid(),payment:'Pix',delivery_charged:10,items:[{variant_id:v.GRAPE,quantity:1,unit_price:100}]});
 const stock=async()=>Object.fromEntries((await db.query<{name:string;quantity:number;value:string}>('select name,quantity,value::text from variants')).rows.map(r=>[r.name,[r.quantity,+r.value]]));
 // 1) edição financeira: preço, desconto, pagamento, custo de entrega → CMV e estoque intactos, despesa criada
 const e1={request_id:rid(),sale_id:sid,payment:'Crédito',card_fee:3,discount:5,delivery_charged:10,delivery_cost:7,note:'corrigido',items:[{variant_id:v.GRAPE,quantity:1,unit_price:110}]};
 assert.equal(await rpc(db,'update_sale',e1),sid);assert.equal(await rpc(db,'update_sale',e1),sid);
 let s=(await db.query<{revenue:string;cogs:string;payment:string;discount:string;number:string}>('select revenue::text,cogs::text,payment,discount::text,number::text from sales')).rows[0];
 assert.deepEqual([+s.revenue,+s.cogs,s.payment,+s.discount,s.number],[105,70,'Crédito',5,'1']);
 assert.deepEqual((await stock()).GRAPE,[4,280]);
 assert.equal((await db.query<{a:string}>('select amount::text a from expenses where sale_id=$1',[sid])).rows[0].a,'7.00');
 // 2) troca de sabor/quantidade: estorna e relança (mesmo número, preço de tabela preservado)
 await rpc(db,'update_sale',{request_id:rid(),sale_id:sid,payment:'Pix',delivery_charged:10,delivery_cost:0,items:[{variant_id:v.MANGO,quantity:2,unit_price:100}]});
 const st=await stock();assert.deepEqual(st.GRAPE,[5,350]);assert.deepEqual(st.MANGO,[3,180]);
 s=(await db.query<{revenue:string;cogs:string;payment:string;discount:string;number:string}>('select revenue::text,cogs::text,payment,discount::text,number::text from sales')).rows[0];assert.deepEqual([+s.revenue,+s.cogs,s.number],[200,120,'1']);
 assert.equal((await db.query<{n:string}>('select count(*)::text n from expenses')).rows[0].n,'0');
 assert.equal((await db.query<{n:string}>("select count(*)::text n from movements where kind='Venda'")).rows[0].n,'1');
 // 3) compra posterior do sabor: troca de itens travada, edição financeira liberada
 await rpc(db,'record_purchase',{request_id:rid(),freight:0,items:[{variant_id:v.MANGO,quantity:1,unit_cost:90}]});
 await assert.rejects(rpc(db,'update_sale',{request_id:rid(),sale_id:sid,payment:'Pix',items:[{variant_id:v.MANGO,quantity:1,unit_price:100}]}),/compra ou ajuste/);
 await rpc(db,'update_sale',{request_id:rid(),sale_id:sid,payment:'Pix',discount:20,items:[{variant_id:v.MANGO,quantity:2,unit_price:100}]});
 assert.equal((await db.query<{r:string}>('select revenue::text r from sales')).rows[0].r,'180.00');
 // 4) excluir: unidades voltam pelo custo de saída, venda e despesa somem, histórico guardado
 await rpc(db,'update_sale',{request_id:rid(),sale_id:sid,payment:'Pix',delivery_cost:5,items:[{variant_id:v.MANGO,quantity:2,unit_price:100}]});
 await rpc(db,'delete_sale',{request_id:rid(),sale_id:sid});
 assert.deepEqual((await stock()).MANGO,[6,390]);
 assert.equal((await db.query<{n:string}>('select ((select count(*) from sales)+(select count(*) from sale_items)+(select count(*) from expenses)+(select count(*) from movements where kind=\'Venda\'))::text n')).rows[0].n,'0');
 assert.equal((await db.query<{n:string}>('select count(*)::text n from sale_revisions')).rows[0].n,'5');
 await db.exec("set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'");await assert.rejects(rpc(db,'delete_sale',{request_id:rid(),sale_id:sid}),/autorizado/);
 }finally{await db.close();}});

test('008: ajuste de correção não é perda; ajustes antigos com o motivo do erro viram correção',async()=>{const db=await database(ALL.slice(0,7));try{
 await db.exec('set role authenticated');
 await rpc(db,'record_purchase',{request_id:rid(),freight:0,new_products:[{key:'k',brand:'ELFBAR',model:'ICE',price:133.11,minimum:0}],items:[{product_key:'k',variant_name:'PEACH',quantity:2,unit_cost:70}]});
 const vid=(await db.query<{id:string}>('select id from variants')).rows[0].id;
 await rpc(db,'adjust_stock',{request_id:rid(),variant_id:vid,quantity:-1,reason:'Erro lançamento compra'});
 await rpc(db,'adjust_stock',{request_id:rid(),variant_id:vid,quantity:-1,reason:'Avaria'});
 await db.exec('reset role');await migrate(db,['008_adjustment_type.sql']);await db.exec('set role authenticated');
 const types=(await db.query<{reason:string;t:string}>("select reason,adjustment_type t from movements where kind='Ajuste' order by reason")).rows.map(r=>[r.reason,r.t]);
 assert.deepEqual(types,[['Avaria','perda'],['Erro lançamento compra','correcao']]);
 await rpc(db,'adjust_stock',{request_id:rid(),variant_id:vid,quantity:1,unit_cost:70,reason:'Contagem',adjustment_type:'correcao'});
 assert.equal((await db.query<{t:string}>("select adjustment_type t from movements where reason='Contagem'")).rows[0].t,'correcao');
 await assert.rejects(rpc(db,'adjust_stock',{request_id:rid(),variant_id:vid,quantity:1,unit_cost:1,reason:'xxx',adjustment_type:'outro'}),/inválido/);
 }finally{await db.close();}});

test('009: lista pré-preenchida pelo nome do sabor, salva configuração e aparece no snapshot',async()=>{const db=await database(ALL.slice(0,8));try{
 await db.exec('set role authenticated');
 await rpc(db,'record_purchase',{request_id:rid(),freight:0,new_products:[{key:'k',brand:'LOST MARY',model:'MT20000',price:92.16,minimum:0}],items:[{product_key:'k',variant_name:'NANA COCONUT',quantity:1,unit_cost:45},{product_key:'k',variant_name:'BERRY BURST',quantity:1,unit_cost:45},{product_key:'k',variant_name:'NOVO SABOR',quantity:1,unit_cost:45}]});
 await db.exec('reset role');await migrate(db,['009_whatsapp_list.sql']);await db.exec('set role authenticated');
 const p=(await db.query<{list_name:string;list_emoji:string;list_price:string;id:string}>('select id,list_name,list_emoji,list_price::text from products')).rows[0];
 assert.deepEqual([p.list_name,p.list_emoji,+p.list_price],['LOST MARY 20K','💥',80]);
 const vs=Object.fromEntries((await db.query<{name:string;e:string|null;l:string|null;d:string|null}>('select name,list_emoji e,list_label l,list_description d from variants')).rows.map(r=>[r.name,[r.e,r.l,r.d]]));
 assert.deepEqual(vs['NANA COCONUT'],['🍌🥥','Banana Coconut','Banana com coco']);assert.deepEqual(vs['BERRY BURST'],['🫐',null,'Mix de frutas vermelhas']);assert.deepEqual(vs['NOVO SABOR'],[null,null,null]);
 const st=(await db.query<{s:{settings:{list_header:string;list_footer:string}}}>('select public.get_state() s')).rows[0].s.settings;assert.equal(st.list_header,'📣 *LISTA ATUALIZADA*😉🔥');assert.ok(st.list_footer.includes('09h às 02h'));
 const vid=(await db.query<{id:string}>("select id from variants where name='NOVO SABOR'")).rows[0].id;
 await db.query('select public.save_list_settings($1::jsonb)',[JSON.stringify({header:'Topo',footer:'Fim',list_products:[{id:p.id,list_name:'LOST MARY 20K',list_emoji:'💥',list_price:85}],list_variants:[{id:vid,list_emoji:'🍋',list_label:'',list_description:'Limão'}]})]);
 assert.equal((await db.query<{x:string}>('select list_price::text x from products')).rows[0].x,'85.00');
 assert.deepEqual((await db.query<{e:string;d:string}>('select list_emoji e,list_description d from variants where id=$1',[vid])).rows[0],{e:'🍋',d:'Limão'});
 await db.exec("set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'");await assert.rejects(db.query('select public.save_list_settings($1::jsonb)',['{}']),/autorizado/);
 }finally{await db.close();}});

test('010: caixa com empréstimo, pagamento com juros e despesa editável/excluível sem apagar histórico',async()=>{const db=await database();try{
 await db.exec('set role authenticated');const q=(sql:string,p:unknown[]=[])=>db.query(sql,p);
 const cash=async(p:object)=>(await db.query<{id:string}>('select public.record_cash_entry($1::jsonb) id',[JSON.stringify({request_id:rid(),...p})])).rows[0].id;
 const loan=await cash({kind:'emprestimo',amount:553,date:'2026-10-03',description:'Empréstimo'});
 await cash({kind:'pagamento_emprestimo',amount:115,date:'2026-10-03',loan_id:loan});
 const pay=await cash({kind:'pagamento_emprestimo',amount:100,interest:10,date:'2026-10-03',loan_id:loan});
 assert.equal((await q("select amount::text a from expenses where source='caixa'")).rows.length,1);
 await assert.rejects(cash({kind:'pagamento_emprestimo',amount:500,loan_id:loan}),/maior que o saldo/);
 await assert.rejects(q('select public.cancel_cash_entry($1::jsonb)',[JSON.stringify({id:loan})]),/pagamentos registrados/);
 await q('select public.cancel_cash_entry($1::jsonb)',[JSON.stringify({id:pay})]);
 const st=(await q('select public.get_state() s')).rows[0] as {s:{cash:{id:string}[];expenses:unknown[]}};assert.equal(st.s.cash.length,2);assert.equal(st.s.expenses.length,0);
 const eid=await rpc(db,'record_expense',{request_id:rid(),category:'Outros',description:'COMPRA DE MERCADORIA + ESTACIONAMENTO',amount:1703,date:'2026-10-03'});
 await q('select public.update_expense($1::jsonb)',[JSON.stringify({id:eid,category:'Outros',description:'Estacionamento',amount:50,date:'2026-10-03'})]);
 assert.equal(((await q('select amount::text a from expenses where id=$1',[eid])).rows[0] as {a:string}).a,'50.00');
 await q('select public.cancel_expense($1::jsonb)',[JSON.stringify({id:eid})]);
 assert.equal(((await q('select count(*)::text n from expenses where canceled_at is not null')).rows[0] as {n:string}).n,'2');
 await db.exec("set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222'");await assert.rejects(cash({kind:'aporte',amount:1}),/autorizado/);
 }finally{await db.close();}});
