'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Plus,Sparkles,Trash2,X} from 'lucide-react';
import {Action,Data,NewProduct,Payload,TARGET_MARGIN,brl,day,num,purchaseBreakdown,round} from '@/lib/domain';

type DraftProduct={key:string;brand:string;model:string;category:string;minimum:number};
type DraftLine={uid:string;product:string;variant:string;variantName:string;quantity:number;unitCost:number};
type PriceState={value:number;touched:boolean};
type Draft={name:string;date:string;freight:number;other:number;products:DraftProduct[];lines:DraftLine[];prices:Record<string,PriceState>};
const NEW='__new__';
const uid=()=>crypto.randomUUID();
const blankLine=():DraftLine=>({uid:uid(),product:'',variant:'',variantName:'',quantity:1,unitCost:0});
const blankDraft=(data:Data):Draft=>({name:`Lote ${data.batches.length+1}`,date:day(),freight:0,other:0,products:[],lines:[blankLine()],prices:{}});
const storage={get(key:string){try{return localStorage.getItem(key);}catch{return null;}},set(key:string,value:string){try{localStorage.setItem(key,value);}catch{}},remove(key:string){try{localStorage.removeItem(key);}catch{}}};

export function PurchaseForm({data,mode,onSave,onClose,busy,error}:{data:Data;mode:string;onSave:(a:Action,p:Payload)=>Promise<boolean>;onClose:()=>void;busy:boolean;error:string}) {
 const dialog=useRef<HTMLDialogElement>(null);const draftKey=`tkm-purchase-draft-${mode}`;
 const [draft,setDraft]=useState<Draft>(()=>blankDraft(data));const [restored,setRestored]=useState(false);const [ready,setReady]=useState(false);
 useEffect(()=>{dialog.current?.showModal();const saved=storage.get(draftKey);if(saved){try{const parsed=JSON.parse(saved) as Draft;if(parsed.lines?.some(l=>l.product||l.unitCost)){setDraft(parsed);setRestored(true);}}catch{}}setReady(true);return()=>dialog.current?.close();},[draftKey]);
 useEffect(()=>{if(ready)storage.set(draftKey,JSON.stringify(draft));},[draft,draftKey,ready]);
 const patch=(next:Partial<Draft>)=>setDraft(d=>({...d,...next}));
 const setLine=(id:string,next:Partial<DraftLine>)=>setDraft(d=>({...d,lines:d.lines.map(l=>l.uid===id?{...l,...next}:l)}));
 const setProduct=(key:string,next:Partial<DraftProduct>)=>setDraft(d=>({...d,products:d.products.map(p=>p.key===key?{...p,...next}:p)}));

 const productInfo=(ref:string)=>{if(ref.startsWith('new:')){const p=draft.products.find(x=>'new:'+x.key===ref);return p?{name:`${p.brand||'Nova marca'} · ${p.model||'Novo modelo'}`,current:null as number|null,isNew:true}:null;}
  const p=data.products.find(x=>'id:'+x.id===ref);return p?{name:`${p.brand} · ${p.model}`,current:p.price,isNew:false}:null;};
 const breakdown=useMemo(()=>purchaseBreakdown(draft.lines.map(l=>({quantity:l.quantity,unit_cost:l.unitCost})),draft.freight,draft.other),[draft.lines,draft.freight,draft.other]);
 // Sugestão por produto: a maior sugestão entre os sabores da compra (protege a margem do sabor mais caro).
 const suggestionFor=(ref:string)=>Math.max(0,...draft.lines.map((l,i)=>l.product===ref?breakdown.lines[i].suggested:0));
 const priceFor=(ref:string)=>{const info=productInfo(ref),state=draft.prices[ref];if(state?.touched)return state.value;if(info?.isNew)return suggestionFor(ref);return info?.current??0;};
 const setPrice=(ref:string,value:number)=>setDraft(d=>({...d,prices:{...d.prices,[ref]:{value,touched:true}}}));

 function chooseProduct(line:DraftLine,value:string){
  if(value===NEW){const key=uid().slice(0,8);setDraft(d=>({...d,products:[...d.products,{key,brand:'',model:'',category:'',minimum:2}],lines:d.lines.map(l=>l.uid===line.uid?{...l,product:'new:'+key,variant:NEW,variantName:''}:l)}));return;}
  const variants=value.startsWith('id:')?data.variants.filter(v=>'id:'+v.product_id===value):[];
  setLine(line.uid,{product:value,variant:variants.length?'':NEW,variantName:''});
 }
 function removeLine(line:DraftLine){setDraft(d=>{const lines=d.lines.filter(l=>l.uid!==line.uid);const used=new Set(lines.map(l=>l.product));return {...d,lines,products:d.products.filter(p=>used.has('new:'+p.key))};});}
 function discard(){storage.remove(draftKey);setDraft(blankDraft(data));setRestored(false);}

 async function submit(e:React.FormEvent){e.preventDefault();
  const used=new Set(draft.lines.map(l=>l.product));
  const new_products:NewProduct[]=draft.products.filter(p=>used.has('new:'+p.key)).map(p=>({key:p.key,brand:p.brand,model:p.model,category:p.category,minimum:p.minimum,price:round(priceFor('new:'+p.key))}));
  const price_updates=[...used].filter(ref=>ref.startsWith('id:')).map(ref=>({product_id:ref.slice(3),price:round(priceFor(ref))})).filter(u=>u.price!==data.products.find(p=>p.id===u.product_id)?.price);
  const items=draft.lines.map(l=>{const existing=l.variant&&l.variant!==NEW;const base={quantity:l.quantity,unit_cost:l.unitCost,variant_id:existing?l.variant.slice(3):''};
   if(existing)return base;return l.product.startsWith('new:')?{...base,product_key:l.product.slice(4),variant_name:l.variantName}:{...base,product_id:l.product.slice(3),variant_name:l.variantName};});
  const ok=await onSave('record_purchase',{name:draft.name,purchase_date:draft.date,freight:draft.freight,other_costs:draft.other,new_products,price_updates,items});
  if(ok)storage.remove(draftKey);
 }

 const productOptions=[...data.products].sort((a,b)=>(a.brand+a.model).localeCompare(b.brand+b.model));
 const hasCosts=breakdown.merchandise>0;
 return <dialog ref={dialog} className="modal purchase-modal" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} aria-labelledby="purchase-title"><form onSubmit={submit}>
  <div className="modal-head"><div><span className="eyebrow">COMPRA → PRODUTOS → ESTOQUE</span><h2 id="purchase-title">Nova compra</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Fechar"><X size={20}/></button></div>
  {restored&&<div className="draft-note"><span>Rascunho recuperado. Nada foi lançado no estoque ainda.</span><button type="button" className="text-button" onClick={discard}>Descartar rascunho</button></div>}
  <fieldset disabled={busy}>
   <div className="form-grid purchase-head">
    <label>Identificação do lote<input required maxLength={80} value={draft.name} onChange={e=>patch({name:e.target.value})}/></label>
    <label>Data da compra<input type="date" required max={day()} value={draft.date} onChange={e=>patch({date:e.target.value})}/></label>
    <label>Frete total (R$)<input type="number" min="0" step="0.01" required value={draft.freight} onChange={e=>patch({freight:Number(e.target.value)})}/></label>
    <label>Outros custos de aquisição (R$)<input type="number" min="0" step="0.01" value={draft.other} onChange={e=>patch({other:Number(e.target.value)})}/></label>
   </div>
   <p className="hint purchase-hint">Frete e outros custos são informados uma vez e rateados pelo valor de cada item. O estoque só muda quando você finalizar a compra.</p>
   <div className="purchase-lines">{draft.lines.map((line,i)=>{
    const c=breakdown.lines[i];const isNew=line.product.startsWith('new:');const np=isNew?draft.products.find(p=>'new:'+p.key===line.product):undefined;
    const variants=line.product.startsWith('id:')?data.variants.filter(v=>'id:'+v.product_id===line.product):[];
    const info=productInfo(line.product);const price=line.product?priceFor(line.product):0;const sharedWith=draft.lines.filter(l=>l.product===line.product).length;
    const margin=price>0&&c.unit?(price-c.unit)/price*100:null;
    return <section className="purchase-line" key={line.uid} aria-label={`Item ${i+1}`}>
     <div className="purchase-line-head"><strong>Item {i+1}</strong><button className="icon-button" type="button" aria-label={`Remover item ${i+1}`} disabled={draft.lines.length===1} onClick={()=>removeLine(line)}><Trash2 size={16}/></button></div>
     <div className="form-grid">
      <label>Produto<select required value={line.product} onChange={e=>chooseProduct(line,e.target.value)}><option value="" disabled>Selecione</option>
       {draft.products.map(p=><option key={p.key} value={'new:'+p.key}>Novo: {p.brand||'Marca'} · {p.model||'Modelo'}</option>)}
       {productOptions.map(p=><option key={p.id} value={'id:'+p.id}>{p.brand} · {p.model}</option>)}
       <option value={NEW}>+ Cadastrar novo produto</option></select></label>
      {line.product&&(isNew||!variants.length?<label>Sabor / variedade<input required maxLength={80} placeholder="Ex.: Menta" value={line.variantName} onChange={e=>setLine(line.uid,{variantName:e.target.value})}/></label>:
       line.variant===NEW?<label>Nova variedade<span className="input-with-action"><input required autoFocus maxLength={80} placeholder="Ex.: Uva gelada" value={line.variantName} onChange={e=>setLine(line.uid,{variantName:e.target.value})}/><button type="button" className="text-button" onClick={()=>setLine(line.uid,{variant:'',variantName:''})}>Escolher existente</button></span></label>:
       <label>Sabor / variedade<select required value={line.variant} onChange={e=>setLine(line.uid,{variant:e.target.value,variantName:''})}><option value="" disabled>Selecione</option>{variants.map(v=><option key={v.id} value={'id:'+v.id}>{v.name} ({v.quantity} em estoque)</option>)}<option value={NEW}>+ Nova variedade</option></select></label>)}
     </div>
     {np&&<div className="new-product"><span className="badge neutral"><Sparkles size={13}/>Novo produto</span><div className="form-grid">
      <label>Marca<input required maxLength={80} value={np.brand} onChange={e=>setProduct(np.key,{brand:e.target.value})}/></label>
      <label>Modelo<input required maxLength={100} value={np.model} onChange={e=>setProduct(np.key,{model:e.target.value})}/></label>
      <label>Categoria (opcional)<input maxLength={80} placeholder="Geral" value={np.category} onChange={e=>setProduct(np.key,{category:e.target.value})}/></label>
      <label>Estoque mínimo por sabor<input type="number" min="0" step="1" value={np.minimum} onChange={e=>setProduct(np.key,{minimum:Number(e.target.value)})}/></label>
     </div><p className="hint">O cadastro não gera estoque sozinho: as unidades entram quando a compra for finalizada.</p></div>}
     <div className="form-grid">
      <label>Quantidade comprada<input type="number" min="1" step="1" required value={line.quantity} onChange={e=>setLine(line.uid,{quantity:Number(e.target.value)})}/></label>
      <label>Custo unitário da mercadoria (R$)<input type="number" min="0.01" step="0.01" required value={line.unitCost||''} onChange={e=>setLine(line.uid,{unitCost:Number(e.target.value)})}/></label>
     </div>
     <div className="cost-breakdown" aria-live="polite">
      <div><span>Custo mercadoria</span><strong>{c.unit?brl(line.unitCost):'—'}</strong><small>por unidade</small></div>
      <div><span>Frete rateado</span><strong>{c.unit?brl(c.freight/line.quantity):'—'}</strong><small>{c.unit?`${brl(c.freight)} no item`:'aguardando custos'}</small></div>
      {draft.other>0&&<div><span>Outros custos</span><strong>{c.unit?brl(c.other/line.quantity):'—'}</strong><small>{c.unit?`${brl(c.other)} no item`:''}</small></div>}
      <div><span>Custo efetivo</span><strong>{c.unit?brl(c.unit):'—'}</strong><small>{c.unit?`${brl(c.effective)} no item`:''}</small></div>
      <div className="suggested"><span>Preço sugerido ({num(TARGET_MARGIN*100)}%)</span><strong>{c.suggested?brl(c.suggested):'—'}</strong><small>margem sobre a venda</small></div>
     </div>
     {line.product&&<div className="sale-price">
      <label>Preço de venda (R$){info&&!info.isNew&&<small> · atual {brl(info.current??0)}</small>}<input type="number" min="0" step="0.01" required value={price||''} onChange={e=>setPrice(line.product,Number(e.target.value))}/></label>
      <div className="sale-price-meta">{c.suggested>0&&Math.abs(price-suggestionFor(line.product))>=0.005&&<button type="button" className="text-button" onClick={()=>setPrice(line.product,suggestionFor(line.product))}>Usar sugerido {brl(suggestionFor(line.product))}</button>}
       {margin!==null&&<span className={margin>=TARGET_MARGIN*100-0.05?'positive':'negative'}>Margem com este preço: {num(margin)}%</span>}
       {sharedWith>1&&<span className="muted">Vale para todos os sabores de {info?.name}.</span>}
       {info&&!info.isNew&&<span className="muted">O preço atual só muda se você alterar este campo.</span>}</div>
     </div>}
    </section>;})}</div>
   <button type="button" className="button secondary" onClick={()=>patch({lines:[...draft.lines,blankLine()]})}><Plus size={16}/>Adicionar produto</button>
   <div className="purchase-summary"><div><span>Mercadorias</span><strong>{brl(breakdown.merchandise)}</strong></div><div><span>Frete</span><strong>{brl(draft.freight)}</strong></div>{draft.other>0&&<div><span>Outros custos</span><strong>{brl(draft.other)}</strong></div>}<div className="total"><span>Custo total da compra</span><strong>{brl(breakdown.total)}</strong></div></div>
   {!hasCosts&&<p className="hint">Informe quantidade e custo para ver o rateio, o custo efetivo e o preço sugerido.</p>}
  </fieldset>{error&&<p className="error" role="alert">{error}</p>}
  <div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Fechar (mantém rascunho)</button><button className="button" disabled={busy||!hasCosts}>{busy?'Finalizando…':'Finalizar compra'}</button></div>
 </form></dialog>;
}
