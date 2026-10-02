import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const UID='11111111-1111-4111-8111-111111111111';
async function database(){const db=new PGlite();await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon; insert into auth.users values('${UID}');`);
 for(const file of ['001_initial.sql','002_snapshot.sql','003_delivery.sql','004_purchase_flow.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
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
