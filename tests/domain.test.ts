import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateFreight,applyAction,demoData,emptyData,report} from '../lib/domain';
test('frete fecha em centavos mesmo com muitos itens e arredondamento',()=>{
 const items=Array.from({length:8},()=>({variant_id:'x',quantity:1,unit_cost:1}));
 const shares=allocateFreight(items,.05);assert.equal(Math.round(shares.reduce((a,b)=>a+b,0)*100),5);assert.ok(shares.every(x=>x>=0));
});
test('custo médio ponderado e baixa integral não deixam saldo residual',()=>{
 let d=applyAction(emptyData(),'save_product',{brand:'Teste',model:'Caderno',category:'Papelaria',price:50,minimum:1,variants:['Azul']});const v=d.variants[0].id;
 d=applyAction(d,'record_batch',{freight:10,items:[{variant_id:v,quantity:3,unit_cost:10}]});
 d=applyAction(d,'record_batch',{freight:0,items:[{variant_id:v,quantity:2,unit_cost:20}]});
 assert.equal(d.variants[0].value,80);assert.equal(d.variants[0].quantity,5);
 d=applyAction(d,'record_sale',{payment:'Pix',items:[{variant_id:v,quantity:1,unit_price:30}]});assert.equal(d.sales[0].cogs,16);
 d=applyAction(d,'record_sale',{payment:'Pix',items:[{variant_id:v,quantity:4,unit_price:30}]});assert.equal(d.variants[0].quantity,0);assert.equal(d.variants[0].value,0);
});
test('venda inválida não altera dados; idempotência evita duplicação',()=>{
 const d=demoData();const before=JSON.stringify(d);const v=d.variants[0];
 assert.throws(()=>applyAction(d,'record_sale',{payment:'Pix',items:[{variant_id:v.id,quantity:v.quantity+1,unit_price:1}]}),/Estoque/);assert.equal(JSON.stringify(d),before);
 const p={request_id:crypto.randomUUID(),payment:'Pix',items:[{variant_id:v.id,quantity:1,unit_price:20}]};const next=applyAction(d,'record_sale',p);assert.deepEqual(applyAction(next,'record_sale',p),next);
});
test('indicadores separam taxa, período e estoque atual; perdas reduzem resultado',()=>{
 let d=demoData();let r=report(d,'','');assert.equal(r.revenue,314);assert.equal(r.stock,31);assert.equal(r.capital,356.4);assert.ok(Math.abs(r.cogs-171.6)<.000001);assert.ok(Math.abs(r.net-117.4)<.00001);
 const empty=report(d,'2000-01-01','2000-01-31');assert.equal(empty.revenue,0);assert.equal(empty.stock,31);
 d=applyAction(d,'adjust_stock',{variant_id:d.variants[0].id,quantity:-1,reason:'Avaria'});r=report(d,'','');assert.equal(r.loss,19.8);assert.ok(Math.abs(r.net-97.6)<.00001);
});
test('entrega cobrada 10: custo 7 gera +3; custo 15 gera -5 sem dupla despesa',()=>{
 let d=applyAction(emptyData(),'save_product',{brand:'Papel',model:'Agenda',category:'Papelaria',price:20,minimum:0,variants:['Azul']});const vid=d.variants[0].id;
 d=applyAction(d,'record_batch',{freight:0,items:[{variant_id:vid,quantity:2,unit_cost:5}]});
 d=applyAction(d,'record_sale',{request_id:'delivery-1',payment:'Pix',delivery_charged:10,delivery_cost:7,items:[{variant_id:vid,quantity:1,unit_price:20}]});
 let r=report(d,'','');assert.equal(r.deliveryProfit,3);assert.equal(r.revenue,30);assert.equal(r.expense,7);assert.equal(r.net,18);
 const p={request_id:'delivery-2',payment:'Pix',delivery_charged:10,delivery_cost:15,items:[{variant_id:vid,quantity:1,unit_price:20}]};d=applyAction(d,'record_sale',p);d=applyAction(d,'record_sale',p);
 r=report(d,'','');assert.equal(d.expenses.length,2);assert.equal(r.deliveryProfit,-2);assert.equal(r.expense,22);assert.equal(r.net,28);assert.equal(r.rows[0].revenue,40);assert.ok(d.expenses.every(e=>e.source==='venda'&&e.sale_id));
});
