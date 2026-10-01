import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const UID='11111111-1111-4111-8111-111111111111';
async function database(){const db=new PGlite();await db.exec(`create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon; insert into auth.users values('${UID}');`);
 for(const file of ['001_initial.sql','002_snapshot.sql','003_delivery.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
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
