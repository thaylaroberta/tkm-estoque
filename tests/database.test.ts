import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const UID='11111111-1111-4111-8111-111111111111';
const ALL=['001_initial.sql','002_snapshot.sql','003_delivery.sql','004_purchase_flow.sql','005_edit_purchase.sql','006_sale_discount.sql'];
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
