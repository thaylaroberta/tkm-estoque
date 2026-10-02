import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateFreight,applyAction,demoData,emptyData,purchaseBreakdown,report,suggestedPrice} from '../lib/domain';
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

test('rateio do caso real fecha em R$ 1.252 e preço sugerido usa margem de 47% sobre a venda',()=>{
 const b=purchaseBreakdown([{quantity:6,unit_cost:66},{quantity:10,unit_cost:46},{quantity:4,unit_cost:49},{quantity:4,unit_cost:20}],120);
 assert.equal(b.merchandise,1132);assert.equal(b.total,1252);assert.equal(Math.round(b.lines.reduce((a,l)=>a+l.freight,0)*100),12000);
 assert.deepEqual(b.lines.map(l=>Math.round(l.unit*100)/100),[73,50.88,54.2,22.12]);
 assert.equal(suggestedPrice(50),94.34);assert.equal(suggestedPrice(55),103.77);
 const withOther=purchaseBreakdown([{quantity:1,unit_cost:30},{quantity:1,unit_cost:10}],10,4);assert.deepEqual(withOther.lines.map(l=>l.other),[3,1]);assert.equal(withOther.total,54);
});
test('compra cria produto do zero, só movimenta estoque ao finalizar e recalcula custo médio na 2ª compra',()=>{
 let d=applyAction(emptyData(),'save_product',{brand:'TKM',model:'Cadastro solto',category:'Geral',price:10,minimum:0,variants:['Menta']});assert.equal(report(d,'','').stock,0);
 d=applyAction(d,'record_purchase',{freight:10,new_products:[{key:'n',brand:'Marca',model:'Pod',price:100,minimum:2}],items:[{product_key:'n',variant_name:'Uva',quantity:4,unit_cost:20},{variant_id:d.variants[0].id,quantity:2,unit_cost:10}]});
 const uva=d.variants.find(v=>v.name==='Uva')!;assert.equal(uva.quantity,4);assert.ok(Math.abs(uva.value-88)<1e-9);assert.equal(d.batch_items[0].suggested_price,suggestedPrice(22));
 assert.equal(report(d,'','').capital,110);assert.equal(d.expenses.length,0);
 d=applyAction(d,'record_sale',{payment:'Pix',items:[{variant_id:uva.id,quantity:1,unit_price:100}]});const cogs=d.sales[0].cogs;
 d=applyAction(d,'record_purchase',{freight:0,items:[{product_id:uva.product_id,variant_name:'Uva',quantity:3,unit_cost:40}]});
 const u2=d.variants.find(v=>v.id===uva.id)!;assert.equal(u2.quantity,6);assert.ok(Math.abs(u2.value/u2.quantity-(66+120)/6)<1e-9);assert.equal(d.sales[0].cogs,cogs);assert.equal(d.products.find(p=>p.model==='Pod')!.price,100);
 assert.equal(d.movements.filter(m=>m.kind==='Entrada').length,3);
});
test('categorias: mesma categoria com outra grafia não duplica o filtro',async()=>{
 const {categories,canonicalCategory,categoryKey}=await import('../lib/domain');
 const list=categories([{category:'Pod'},{category:' pod '},{category:'Pód'},{category:'Essência'},{category:''}]);
 assert.deepEqual(list.map(c=>[c.name,c.count]),[['Essência',1],['Geral',1],['Pod',3]]);
 assert.equal(canonicalCategory('  POD ',[{category:'Pod'}]),'Pod');assert.equal(canonicalCategory('Narguilé  novo',[{category:'Pod'}]),'Narguilé novo');
 assert.equal(categoryKey('Essência'),categoryKey('essencia'));
});
test('desconto na venda: rateio, faturamento líquido, desconto exibido e lucro por produto',async()=>{
 const {itemDiscount}=await import('../lib/domain');
 let d=applyAction(emptyData(),'record_purchase',{freight:0,new_products:[{key:'a',brand:'ELFBAR',model:'ICE KING',price:133.11,minimum:0},{key:'b',brand:'LOST MARY',model:'MT',price:92.16,minimum:0}],items:[{product_key:'a',variant_name:'GRAPE',quantity:3,unit_cost:70},{product_key:'b',variant_name:'RAZZ',quantity:3,unit_cost:48}]});
 const [g,r]=d.variants;
 d=applyAction(d,'record_sale',{payment:'Pix',discount:25.27,items:[{variant_id:g.id,quantity:1,unit_price:133.11},{variant_id:r.id,quantity:1,unit_price:92.16}]});
 d=applyAction(d,'record_sale',{payment:'Pix',items:[{variant_id:g.id,quantity:1,unit_price:100}]});
 assert.deepEqual(d.sale_items.map(i=>i.discount),[14.93,10.34,0]);
 const rep=report(d,'','');assert.equal(rep.productRevenue,300);assert.ok(Math.abs(rep.discounts-(25.27+33.11))<1e-9);assert.ok(Math.abs(rep.grossProducts-358.38)<1e-9);
 const ice=rep.rows.find(x=>x.model==='ICE KING')!;assert.ok(Math.abs(ice.revenue-(133.11-14.93+100))<1e-9);assert.ok(Math.abs(ice.profit-(ice.revenue-140))<1e-9);
 assert.equal(itemDiscount({quantity:1,unit_price:95,list_price:92.16}),0);
 assert.throws(()=>applyAction(d,'record_sale',{payment:'Pix',discount:999,items:[{variant_id:g.id,quantity:1,unit_price:100}]}),/maior que o valor/);
});
