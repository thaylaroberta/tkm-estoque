export type Product = {id:string;brand:string;model:string;category:string;price:number;minimum:number};
export type Variant = {id:string;product_id:string;name:string;quantity:number;value:number};
export type Batch = {id:string;number:number;name:string;freight:number;other_costs?:number;merchandise:number;purchase_date?:string;updated_at?:string|null;created_at:string;request_id:string};
export type BatchItem = {id:string;batch_id:string;variant_id:string;quantity:number;unit_cost:number;freight:number;other_costs?:number;effective_unit_cost?:number|null;avg_cost_after?:number|null;suggested_price?:number|null;sale_price?:number|null};
export type Sale = {id:string;number:number;payment:string;revenue:number;cogs:number;card_fee:number;delivery_charged:number;delivery_cost:number;note:string;created_at:string;request_id:string};
export type SaleItem = {id:string;sale_id:string;variant_id:string;quantity:number;unit_price:number;cogs:number};
export type Expense = {id:string;category:string;description:string;amount:number;date:string;source:string;sale_id?:string;request_id:string};
export type Movement = {id:string;variant_id:string;kind:'Entrada'|'Venda'|'Ajuste';quantity:number;value:number;reference_id:string;reason:string;created_at:string};
export type Data = {batch_revisions?:string[];products:Product[];variants:Variant[];batches:Batch[];batch_items:BatchItem[];sales:Sale[];sale_items:SaleItem[];expenses:Expense[];movements:Movement[]};
export type Line = {variant_id?:string;quantity:number;unit_cost?:number;unit_price?:number;product_id?:string;product_key?:string;variant_name?:string};
export type NewProduct = {key:string;brand:string;model:string;category?:string;price:number;minimum?:number};
export type Payload = {id?:string;request_id?:string;brand?:string;model?:string;category?:string;price?:number;minimum?:number;variants?:string[];items?:Line[];name?:string;freight?:number;payment?:string;card_fee?:number;delivery_charged?:number;delivery_cost?:number;note?:string;description?:string;amount?:number;date?:string;variant_id?:string;quantity?:number;reason?:string;unit_cost?:number;purchase_date?:string;other_costs?:number;new_products?:NewProduct[];price_updates?:{product_id:string;price:number}[];batch_id?:string};
export type Action = 'save_product'|'record_batch'|'record_purchase'|'update_purchase'|'rename_purchase'|'delete_purchase'|'record_sale'|'record_expense'|'adjust_stock';
export const emptyData = ():Data => ({products:[],variants:[],batches:[],batch_items:[],sales:[],sale_items:[],expenses:[],movements:[]});
export const brl = (value:number) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
export const num = (value:number) => new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2}).format(value);
export const day = (value:string|Date=new Date()) => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export const dateBR = (value:string) => new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo'}).format(new Date(value.length===10?value+'T12:00:00Z':value));
/** Compara categorias ignorando maiúsculas, acentos e espaços extras: "Pod", " pod" e "Pód" são a mesma categoria. */
export const categoryKey = (value:string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();
/** Categorias existentes, sem duplicatas de grafia, em ordem alfabética, com a quantidade de produtos. */
export function categories(products:{category:string}[]) {
 const map=new Map<string,{name:string;count:number}>();
 for(const p of products){const key=categoryKey(p.category||'Geral');const item=map.get(key);if(item)item.count++;else map.set(key,{name:(p.category||'Geral').trim(),count:1});}
 return [...map.values()].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
}
/** Usa a grafia já cadastrada quando a categoria digitada é a mesma com outra caixa/acento. */
export const canonicalCategory = (value:string,products:{category:string}[]) => {const key=categoryKey(value);if(!key)return '';return categories(products).find(c=>categoryKey(c.name)===key)?.name??value.trim().replace(/\s+/g,' ');};
const clean = (value:string) => value.trim().replace(/\s+/g,' ');
/** Mesmo produto = mesma marca + modelo, ignorando maiúsculas e espaços extras (igual ao banco). */
export const productKey = (brand:string,model:string) => clean(brand).toLowerCase()+'|'+clean(model).toLowerCase();
/** Sabores desta compra que tiveram venda, ajuste ou outra compra depois dela (trava de edição). */
export function purchaseBlockers(d:Data,batchId:string):string[] {
 const batch=d.batches.find(b=>b.id===batchId);if(!batch)return [];const vids=new Set(d.batch_items.filter(i=>i.batch_id===batchId).map(i=>i.variant_id));
 return [...new Set(d.movements.filter(m=>vids.has(m.variant_id)&&m.reference_id!==batchId&&m.created_at>=batch.created_at).map(m=>{const v=d.variants.find(x=>x.id===m.variant_id),p=d.products.find(x=>x.id===v?.product_id);return `${p?.model??''} · ${v?.name??''} (${m.kind.toLowerCase()})`;}))];
}
export const round = (n:number, digits=2) => Math.round((n+Number.EPSILON)*10**digits)/10**digits;
const id = () => crypto.randomUUID();
/** Margem bruta desejada sobre o preço de venda (não é markup sobre o custo). */
export const TARGET_MARGIN = 0.47;
export const suggestedPrice = (effectiveUnitCost:number) => round(effectiveUnitCost/(1-TARGET_MARGIN));
/** Rateio proporcional ao valor de cada item; o último item recebe o restante, fechando no centavo. */
export function allocateCost(values:number[],amount:number):number[] {
 const total=values.reduce((a,v)=>a+v,0);const cents=Math.round(amount*100);let allocated=0;
 if(total<=0||cents<0)return values.map(()=>0);
 return values.map((v,i)=>{const share=i===values.length-1?cents-allocated:Math.min(cents-allocated,Math.round(cents*v/total));allocated+=share;return share/100;});
}
/** Custos de cada linha da compra, com a mesma regra usada no banco. */
export function purchaseBreakdown(items:{quantity:number;unit_cost:number}[],freight:number,other=0) {
 const values=items.map(i=>i.quantity>0&&i.unit_cost>0?i.quantity*round(i.unit_cost):0);
 const merchandise=values.reduce((a,v)=>a+v,0);const f=allocateCost(values,round(freight)),o=allocateCost(values,round(other));
 return {merchandise,total:merchandise+round(freight)+round(other),lines:items.map((i,k)=>{const effective=values[k]+f[k]+o[k];const unit=i.quantity>0&&values[k]>0?round(effective/i.quantity,6):0;return {value:values[k],freight:f[k],other:o[k],effective,unit,suggested:unit?suggestedPrice(unit):0};})};
}
export function allocateFreight(items:Line[],freight:number):number[] {
 const total=items.reduce((a,i)=>a+i.quantity*round(i.unit_cost??0),0);
 if(total<=0 || freight<0 || !Number.isFinite(freight)) throw Error('Informe custos positivos e frete válido.');
 let allocated=0; const cents=Math.round(freight*100);
 return items.map((i,index)=>{ const value=index===items.length-1?cents-allocated:Math.min(cents-allocated,Math.round(cents*i.quantity*round(i.unit_cost??0)/total)); allocated+=value;return value/100; });
}
// Motor local somente para demonstração. Em produção, o Postgres executa as operações atomicamente.
export function applyAction(original:Data,action:Action,p:Payload,now=new Date().toISOString()):Data {
 const d=structuredClone(original); const rid=p.request_id??id();
 if([...d.sales,...d.batches,...d.expenses].some(x=>x.request_id===rid)||d.movements.some(x=>x.kind==='Ajuste'&&x.reference_id===rid)) return d;
 const positive=(n:number|undefined,zero=false)=>{if(n===undefined||!Number.isFinite(n)||(zero?n<0:n<=0))throw Error('Valor inválido.');return n;};
 const integer=(n:number|undefined)=>{positive(n);if(!Number.isInteger(n))throw Error('Use quantidades inteiras.');return n!;};
 const variant=(vid:string|undefined)=>{const v=d.variants.find(x=>x.id===vid);if(!v)throw Error('Variedade não encontrada.');return v;};
 const move=(v:Variant,kind:Movement['kind'],quantity:number,value:number,reference_id:string,reason:string)=>d.movements.push({id:id(),variant_id:v.id,kind,quantity,value,reference_id,reason,created_at:now});
 if(action==='save_product') {
  if(!p.brand?.trim()||!p.model?.trim()||!p.category?.trim())throw Error('Preencha marca, modelo e categoria.');
  positive(p.price,true);positive(p.minimum,true);if(!Number.isInteger(p.minimum))throw Error('Estoque mínimo deve ser inteiro.');
  if(d.products.some(x=>x.id!==p.id&&productKey(x.brand,x.model)===productKey(p.brand!,p.model!)))throw Error(`Já existe um produto ${p.brand.trim()} · ${p.model.trim()}. Edite esse produto para adicionar sabores.`);
  const product:Product={id:p.id??id(),brand:p.brand.trim(),model:p.model.trim(),category:p.category.trim(),price:round(p.price!),minimum:p.minimum!};
  const existing=d.products.findIndex(x=>x.id===product.id);if(existing>=0)d.products[existing]=product;else d.products.push(product);
  for(const name of p.variants??[])if(name.trim()&&!d.variants.some(v=>v.product_id===product.id&&v.name===name.trim()))d.variants.push({id:id(),product_id:product.id,name:name.trim(),quantity:0,value:0});
  if(!d.variants.some(v=>v.product_id===product.id))throw Error('Adicione uma variedade.');
 } else if(action==='record_batch') {
  if(!p.items?.length)throw Error('Adicione itens.');positive(p.freight,true);
  for(const l of p.items){integer(l.quantity);positive(l.unit_cost);variant(l.variant_id);}
  const shares=allocateFreight(p.items,p.freight!);const bid=id();
  d.batches.push({id:bid,number:d.batches.length+1,name:p.name?.trim()||'Compra',freight:round(p.freight!),merchandise:round(p.items.reduce((a,l)=>a+l.quantity*round(l.unit_cost!),0)),created_at:now,request_id:rid});
  p.items.forEach((l,i)=>{const v=variant(l.variant_id),value=round(l.quantity*round(l.unit_cost!)+shares[i]);v.quantity+=l.quantity;v.value=round(v.value+value,6);d.batch_items.push({id:id(),batch_id:bid,variant_id:v.id,quantity:l.quantity,unit_cost:round(l.unit_cost!),freight:shares[i]});move(v,'Entrada',l.quantity,value,bid,'Compra com frete rateado');});
 } else if(action==='record_purchase'||action==='update_purchase'||action==='rename_purchase'||action==='delete_purchase') {
  if(action!=='record_purchase'){
   if((d.batch_revisions??[]).includes(rid))return d;const batch=d.batches.find(b=>b.id===p.batch_id);if(!batch)throw Error('Compra não encontrada.');
   d.batch_revisions=[...(d.batch_revisions??[]),rid];
   if(action==='rename_purchase'){const date=p.purchase_date||batch.purchase_date||day(batch.created_at);if(date>day(now))throw Error('A data da compra não pode ser futura.');batch.name=p.name?.trim()||batch.name;batch.purchase_date=date;batch.updated_at=now;return d;}
   const blockers=purchaseBlockers(d,batch.id);if(blockers.length)throw Error(`Esta compra já teve movimentações depois dela (${blockers.join(', ')}). ${action==='delete_purchase'?'Não é possível excluir; use ajuste de estoque.':'Só é possível alterar nome e data.'}`);
   for(const i of d.batch_items.filter(i=>i.batch_id===batch.id)){const v=variant(i.variant_id);v.quantity-=i.quantity;v.value=v.quantity===0?0:Math.max(0,round(v.value-(i.quantity*i.unit_cost+i.freight+(i.other_costs??0)),6));}
   d.batch_items=d.batch_items.filter(i=>i.batch_id!==batch.id);d.movements=d.movements.filter(m=>!(m.kind==='Entrada'&&m.reference_id===batch.id));
   if(action==='delete_purchase'){d.batches=d.batches.filter(b=>b.id!==batch.id);return d;}
  }
  if(!p.items?.length)throw Error('Adicione pelo menos um produto à compra.');const freight=round(positive(p.freight??0,true)),other=round(positive(p.other_costs??0,true));
  const today=day(now),date=p.purchase_date||today;if(date>today)throw Error('A data da compra não pode ser futura.');
  const keys=new Map<string,string>();
  for(const np of p.new_products??[]){if(!np.brand?.trim()||!np.model?.trim())throw Error('Informe marca e modelo do novo produto.');positive(np.price,true);
   const same=d.products.find(x=>productKey(x.brand,x.model)===productKey(np.brand,np.model));
   if(same){same.price=round(np.price);keys.set(np.key,same.id);continue;}
   const pid=id();keys.set(np.key,pid);d.products.push({id:pid,brand:clean(np.brand),model:clean(np.model),category:np.category?.trim()||'Geral',price:round(np.price),minimum:np.minimum??0});}
  for(const u of p.price_updates??[]){const product=d.products.find(x=>x.id===u.product_id);if(!product)throw Error('Produto não encontrado.');product.price=round(positive(u.price,true));}
  const vids=p.items.map((l,i)=>{integer(l.quantity);positive(l.unit_cost);if(l.variant_id)return variant(l.variant_id).id;const pid=l.product_id||keys.get(l.product_key??'');if(!pid||!d.products.some(x=>x.id===pid))throw Error(`Selecione ou cadastre o produto do item ${i+1}.`);const name=clean(l.variant_name??'');if(!name)throw Error(`Informe o sabor/variedade do item ${i+1}.`);let v=d.variants.find(x=>x.product_id===pid&&x.name.toLowerCase()===name.toLowerCase());if(!v){v={id:id(),product_id:pid,name,quantity:0,value:0};d.variants.push(v);}return v.id;});
  const b=purchaseBreakdown(p.items.map(l=>({quantity:l.quantity,unit_cost:l.unit_cost!})),freight,other);
  let batch=action==='update_purchase'?d.batches.find(x=>x.id===p.batch_id)!:undefined;
  if(batch)Object.assign(batch,{name:p.name?.trim()||'Compra',freight,other_costs:other,merchandise:round(b.merchandise),purchase_date:date,updated_at:now});
  else{batch={id:id(),number:Math.max(0,...d.batches.map(x=>x.number))+1,name:p.name?.trim()||'Compra',freight,other_costs:other,merchandise:round(b.merchandise),purchase_date:date,created_at:now,request_id:rid};d.batches.push(batch);}
  const stamp=batch.created_at;
  p.items.forEach((l,i)=>{const v=variant(vids[i]),c=b.lines[i];v.quantity+=l.quantity;v.value=round(v.value+c.effective,6);const price=d.products.find(x=>x.id===v.product_id)!.price;d.batch_items.push({id:id(),batch_id:batch!.id,variant_id:v.id,quantity:l.quantity,unit_cost:round(l.unit_cost!),freight:c.freight,other_costs:c.other,effective_unit_cost:c.unit,avg_cost_after:round(v.value/v.quantity,6),suggested_price:c.suggested,sale_price:price});d.movements.push({id:id(),variant_id:v.id,kind:'Entrada',quantity:l.quantity,value:c.effective,reference_id:batch!.id,reason:'Compra com frete rateado',created_at:stamp});});
 } else if(action==='record_sale') {
  if(!p.items?.length)throw Error('Adicione itens.');if(!['Pix','Dinheiro','Débito','Crédito'].includes(p.payment??''))throw Error('Pagamento inválido.');
  const fee=round(positive(p.card_fee??0,true));if(fee>0&&!['Débito','Crédito'].includes(p.payment!))throw Error('Taxa disponível apenas para cartão.');
  const charged=round(positive(p.delivery_charged??0,true)),delivery=round(positive(p.delivery_cost??0,true));
  const sid=id();let revenue=0,cogs=0;
  for(const l of p.items){const q=integer(l.quantity),price=round(positive(l.unit_price,true)),v=variant(l.variant_id);if(v.quantity<q)throw Error(`Estoque insuficiente para ${v.name}.`);const cost=q===v.quantity?v.value:round(v.value*q/v.quantity,6);v.quantity-=q;v.value=round(v.value-cost,6);revenue+=q*price;cogs+=cost;d.sale_items.push({id:id(),sale_id:sid,variant_id:v.id,quantity:q,unit_price:price,cogs:cost});move(v,'Venda',-q,-cost,sid,'Venda registrada');}
  d.sales.push({id:sid,number:d.sales.length+1,payment:p.payment!,revenue:round(revenue),cogs:round(cogs,6),card_fee:fee,delivery_charged:charged,delivery_cost:delivery,note:p.note??'',created_at:now,request_id:rid});
  if(delivery>0)d.expenses.push({id:id(),category:'Entrega',description:`Entrega da venda #${d.sales.length}`,amount:delivery,date:day(now),source:'venda',sale_id:sid,request_id:rid});
 } else if(action==='record_expense') {
  if(!['Anúncios','Entrega','Embalagem','Ferramentas/sistemas','Outros'].includes(p.category??'')||!p.description?.trim()||!p.date)throw Error('Preencha os dados da despesa.');
  d.expenses.push({id:id(),category:p.category!,description:p.description.trim(),amount:round(positive(p.amount)),date:p.date,source:'manual',request_id:rid});
 } else {
  const v=variant(p.variant_id),q=p.quantity!;if(!Number.isInteger(q)||q===0||!p.reason||p.reason.trim().length<3)throw Error('Informe quantidade e motivo do ajuste.');if(v.quantity+q<0)throw Error('O ajuste excede o estoque.');const delta=q>0?round(positive(p.unit_cost,true))*q:(v.quantity===-q?-v.value:round(v.value*q/v.quantity,6));v.quantity+=q;v.value=round(v.value+delta,6);move(v,'Ajuste',q,delta,rid,p.reason.trim());
 }
 return d;
}
export function demoData():Data {
 let d=emptyData();const now=new Date();now.setDate(now.getDate()-12);const date=now.toISOString();
 const specs=[{brand:'Aurora',model:'Caderno A5',category:'Cadernos',price:35,minimum:3,variants:['Verde sálvia','Areia']},{brand:'Traço',model:'Caneta gel',category:'Escrita',price:9,minimum:5,variants:['Preta','Azul']},{brand:'Organiza',model:'Estojo',category:'Acessórios',price:29,minimum:2,variants:['Natural']}];
 specs.forEach(p=>{d=applyAction(d,'save_product',p,date);});
 d=applyAction(d,'record_batch',{name:'Compra demonstrativa',freight:48,items:d.variants.map((v,i)=>({variant_id:v.id,quantity:[10,6,12,8,8][i],unit_cost:[18,18,4,4,14][i]}))},date);
 now.setDate(now.getDate()+4);
 d=applyAction(d,'record_sale',{payment:'Pix',items:[{variant_id:d.variants[0].id,quantity:3,unit_price:35},{variant_id:d.variants[2].id,quantity:5,unit_price:9}]},now.toISOString());
 now.setDate(now.getDate()+4);
 d=applyAction(d,'record_sale',{payment:'Crédito',card_fee:4.5,delivery_charged:10,delivery_cost:7,items:[{variant_id:d.variants[1].id,quantity:3,unit_price:32},{variant_id:d.variants[4].id,quantity:2,unit_price:29}]},now.toISOString());
 d=applyAction(d,'record_expense',{category:'Embalagem',description:'Sacolas de papel — demonstração',amount:18,date:day(now)},now.toISOString());
 return d;
}
export function label(d:Data,vid:string) {const v=d.variants.find(v=>v.id===vid),p=d.products.find(p=>p.id===v?.product_id);return `${p?.model??'Produto'} · ${v?.name??'Variedade'}`;}
export function report(d:Data,from:string,to:string) {
 const within=(date:string)=>{const key=date.length===10?date:day(date);return (!from||key>=from)&&(!to||key<=to);};
 const sales=d.sales.filter(s=>within(s.created_at)),ids=new Set(sales.map(s=>s.id)),items=d.sale_items.filter(i=>ids.has(i.sale_id));
 const expenses=d.expenses.filter(e=>within(e.date));const productRevenue=sales.reduce((a,s)=>a+s.revenue,0),deliveryRevenue=sales.reduce((a,s)=>a+(s.delivery_charged??0),0),deliveryCost=sales.reduce((a,s)=>a+(s.delivery_cost??0),0),revenue=productRevenue+deliveryRevenue,cogs=sales.reduce((a,s)=>a+s.cogs,0),expense=expenses.reduce((a,e)=>a+e.amount,0);
 const loss=-d.movements.filter(m=>m.kind==='Ajuste'&&m.value<0&&within(m.created_at)).reduce((a,m)=>a+m.value,0);
 const stock=d.variants.reduce((a,v)=>a+v.quantity,0),capital=d.variants.reduce((a,v)=>a+v.value,0),potential=d.variants.reduce((a,v)=>a+v.quantity*(d.products.find(p=>p.id===v.product_id)?.price??0),0);
 const rows=d.products.map(p=>{
  const variants=d.variants.filter(v=>v.product_id===p.id),vids=new Set(variants.map(v=>v.id)),pi=items.filter(i=>vids.has(i.variant_id));const units=pi.reduce((a,i)=>a+i.quantity,0),rev=pi.reduce((a,i)=>a+i.quantity*i.unit_price,0),cost=pi.reduce((a,i)=>a+i.cogs,0);
  const last=d.sales.filter(s=>d.sale_items.some(i=>i.sale_id===s.id&&vids.has(i.variant_id))).map(s=>s.created_at).sort().at(-1);
  const best=variants.map(v=>({name:v.name,units:pi.filter(i=>i.variant_id===v.id).reduce((a,i)=>a+i.quantity,0)})).sort((a,b)=>b.units-a.units)[0];
  const movements=d.movements.filter(m=>vids.has(m.variant_id));
  const opening=from?movements.filter(m=>day(m.created_at)<from).reduce((a,m)=>a+m.quantity,0):0;
  const closing=movements.filter(m=>!to||day(m.created_at)<=to).reduce((a,m)=>a+m.quantity,0);const average=(opening+closing)/2;
  return {...p,units,revenue:rev,profit:rev-cost,margin:rev?(rev-cost)/rev*100:0,stock:variants.reduce((a,v)=>a+v.quantity,0),best:best?.units?best.name:'—',last,days:last?Math.floor((Date.parse(day()+'T12:00:00Z')-Date.parse(day(last)+'T12:00:00Z'))/86400000):null,turnover:average>0?units/average:null};
 });
 return {within,sales,items,expenses,revenue,productRevenue,deliveryRevenue,deliveryCost,deliveryProfit:deliveryRevenue-deliveryCost,cogs,expense,loss,stock,capital,potential,gross:revenue-cogs,net:revenue-cogs-expense-loss,units:items.reduce((a,i)=>a+i.quantity,0),rows,low:d.variants.filter(v=>v.quantity<=(d.products.find(p=>p.id===v.product_id)?.minimum??0))};
}
export function exportCSV(rows:Record<string,unknown>[],filename:string) {
 if(!rows.length)return;const keys=Object.keys(rows[0]);const cell=(v:unknown)=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 const blob=new Blob(['\uFEFF'+[keys.map(cell).join(';'),...rows.map(r=>keys.map(k=>cell(r[k])).join(';'))].join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}
