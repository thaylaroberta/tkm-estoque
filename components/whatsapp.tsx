'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Check,Copy,MessageCircle,X} from 'lucide-react';
import {Action,Data,Payload,brl,flavorLabel,listPrice,suggestFlavor,titleCase,whatsappList} from '@/lib/domain';

type ProductEdit={list_name:string;list_emoji:string;list_price:string};
type VariantEdit={list_emoji:string;list_label:string;list_description:string};

/** Lista de estoque para o grupo: prévia ao vivo, copiar, abrir no WhatsApp e personalizar emojis/descrições. */
export function WhatsappList({data,onSave,onClose,busy,error}:{data:Data;onSave:(a:Action,p:Payload)=>Promise<boolean>;onClose:()=>void;busy:boolean;error:string}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 const [header,setHeader]=useState(data.settings?.list_header??'');const [footer,setFooter]=useState(data.settings?.list_footer??'');
 const [products,setProducts]=useState<Record<string,ProductEdit>>(()=>Object.fromEntries(data.products.map(p=>[p.id,{list_name:p.list_name??'',list_emoji:p.list_emoji??'',list_price:p.list_price==null?'':String(p.list_price)}])));
 // Sabores sem emoji/descrição recebem uma sugestão automática pelo nome (você confere e salva).
 const [suggested]=useState<Set<string>>(()=>new Set(data.variants.filter(v=>!v.list_emoji&&!v.list_description&&suggestFlavor(v.name)).map(v=>v.id)));
 const [variants,setVariants]=useState<Record<string,VariantEdit>>(()=>Object.fromEntries(data.variants.map(v=>{const sug=suggested.has(v.id)?suggestFlavor(v.name):null;
  return [v.id,{list_emoji:v.list_emoji??sug?.emoji??'',list_label:v.list_label??'',list_description:v.list_description??sug?.description??''}];})));
 const [onlyInStock,setOnlyInStock]=useState(true);const [showQuantity,setShowQuantity]=useState(false);const [copied,setCopied]=useState(false);const [dirty,setDirty]=useState(()=>data.variants.some(v=>v.quantity>0&&suggested.has(v.id)));
 const preview=useMemo(()=>({...data,
  products:data.products.map(p=>{const e=products[p.id];return {...p,list_name:e.list_name||null,list_emoji:e.list_emoji||null,list_price:e.list_price===''?null:Number(e.list_price)};}),
  variants:data.variants.map(v=>{const e=variants[v.id];return {...v,list_emoji:e.list_emoji||null,list_label:e.list_label||null,list_description:e.list_description||null};})}),[data,products,variants]);
 const text=useMemo(()=>whatsappList(preview,{onlyInStock,showQuantity,header,footer}),[preview,onlyInStock,showQuantity,header,footer]);
 const editP=(id:string,k:keyof ProductEdit,v:string)=>{setProducts(s=>({...s,[id]:{...s[id],[k]:v}}));setDirty(true);};
 const editV=(id:string,k:keyof VariantEdit,v:string)=>{setVariants(s=>({...s,[id]:{...s[id],[k]:v}}));setDirty(true);};
 const missing=preview.variants.filter(v=>v.quantity>0&&(!v.list_emoji||!v.list_description)).length;
 const suggestedInStock=data.variants.filter(v=>v.quantity>0&&suggested.has(v.id)).length;
 async function copy(){try{await navigator.clipboard.writeText(text);}catch{const t=document.createElement('textarea');t.value=text;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();}setCopied(true);setTimeout(()=>setCopied(false),2500);}
 function save(){onSave('save_list_settings',{header,footer,
  list_products:Object.entries(products).map(([id,e])=>({id,list_name:e.list_name,list_emoji:e.list_emoji,list_price:e.list_price===''?null:Number(e.list_price)})),
  list_variants:Object.entries(variants).map(([id,e])=>({id,...e}))});}
 const ordered=[...preview.products].sort((a,b)=>listPrice(a)-listPrice(b));
 return <dialog ref={dialog} className="modal list-modal" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} aria-labelledby="list-title">
  <div className="modal-head"><div><span className="eyebrow">ESTOQUE ATUALIZADO · AGORA</span><h2 id="list-title">Lista para o grupo</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Fechar"><X size={20}/></button></div>
  <div className="list-layout">
   <section className="list-preview">
    <div className="list-options"><label className="check-filter"><input type="checkbox" checked={onlyInStock} onChange={e=>setOnlyInStock(e.target.checked)}/>Só sabores com estoque</label><label className="check-filter"><input type="checkbox" checked={showQuantity} onChange={e=>setShowQuantity(e.target.checked)}/>Mostrar quantidade</label></div>
    <div className="wa-bubble" aria-label="Prévia da mensagem"><WaText text={text}/></div>
    <div className="list-actions"><button type="button" className="button" onClick={copy}>{copied?<><Check size={16}/>Copiado!</>:<><Copy size={16}/>Copiar texto</>}</button>
     <a className="button secondary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer"><MessageCircle size={16}/>Enviar no WhatsApp</a></div>
    <p className="hint">Copie e cole no grupo. "Enviar no WhatsApp" abre o app para você escolher o grupo.</p>
   </section>
   <section className="list-editor">
    <h3>Personalizar {missing>0&&<span className="badge warning">{missing} sabor{missing>1?'es':''} em estoque sem emoji ou descrição</span>}{suggestedInStock>0&&<span className="badge neutral">{suggestedInStock} sugest{suggestedInStock>1?'ões automáticas':'ão automática'} · confira e salve</span>}</h3>
    <label>Cabeçalho<textarea rows={2} value={header} onChange={e=>{setHeader(e.target.value);setDirty(true);}}/></label>
    {ordered.map(p=>{const e=products[p.id];const flavors=data.variants.filter(v=>v.product_id===p.id).sort((a,b)=>(b.quantity>0?1:0)-(a.quantity>0?1:0)||flavorLabel(a).localeCompare(flavorLabel(b),'pt-BR'));
     return <details className="list-product" key={p.id} open={flavors.some(v=>v.quantity>0&&(suggested.has(v.id)||!variants[v.id].list_emoji||!variants[v.id].list_description))}>
      <summary><span>{e.list_emoji} <strong>{e.list_name||`${p.brand} ${p.model}`}</strong></span><small>{brl(listPrice({...p,list_price:e.list_price===''?null:Number(e.list_price)}))} · {flavors.filter(v=>v.quantity>0).length} sabores com estoque</small></summary>
      <div className="list-product-fields"><label>Emoji<input value={e.list_emoji} onChange={x=>editP(p.id,'list_emoji',x.target.value)} placeholder="Ex.: 🔥"/></label>
       <label>Nome na lista<input value={e.list_name} onChange={x=>editP(p.id,'list_name',x.target.value)} placeholder={`${p.brand} ${p.model}`}/></label>
       <label>Preço na lista (R$)<input type="number" min="0" step="0.01" value={e.list_price} onChange={x=>editP(p.id,'list_price',x.target.value)} placeholder={String(p.price)}/><small>Tabela do sistema: {brl(p.price)}</small></label></div>
      <div className="list-flavors">{flavors.map(v=>{const ve=variants[v.id];return <div className={`list-flavor${v.quantity>0?'':' out'}`} key={v.id}>
       <input aria-label={`Emoji de ${v.name}`} className="emoji-input" value={ve.list_emoji} onChange={x=>editV(v.id,'list_emoji',x.target.value)} placeholder="emoji"/>
       <input aria-label={`Nome de ${v.name} na lista`} value={ve.list_label} onChange={x=>editV(v.id,'list_label',x.target.value)} placeholder={titleCase(v.name)}/>
       <input aria-label={`Descrição de ${v.name}`} value={ve.list_description} onChange={x=>editV(v.id,'list_description',x.target.value)} placeholder="Descrição (ex.: Uva gelada)"/>
       <small>{suggested.has(v.id)&&<span className="suggest-tag">sugestão</span>}{v.quantity>0?`${v.quantity} un.`:'esgotado'}</small></div>;})}</div>
     </details>;})}
    <label>Rodapé (informações fixas)<textarea rows={8} value={footer} onChange={e=>{setFooter(e.target.value);setDirty(true);}}/></label>
   </section>
  </div>
  {error&&<p className="error" role="alert">{error}</p>}
  <div className="modal-footer"><span className="hint">{dirty?'Você tem alterações não salvas na personalização.':'Emojis, descrições, preços e textos ficam salvos para as próximas listas.'}</span><span className="footer-spacer"/>
   <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Fechar</button><button type="button" className="button" disabled={busy||!dirty} onClick={save}>{busy?'Salvando…':'Salvar personalização'}</button></div>
 </dialog>;
}

/** Mostra o texto como o WhatsApp exibe: *negrito* e _itálico_. */
function WaText({text}:{text:string}) {
 return <>{text.split('\n').map((line,i)=><p key={i}>{line?line.split(/(\*[^*\n]+\*|_[^_\n]+_)/g).map((part,j)=>part.startsWith('*')&&part.endsWith('*')&&part.length>2?<strong key={j}>{part.slice(1,-1)}</strong>:part.startsWith('_')&&part.endsWith('_')&&part.length>2?<em key={j}>{part.slice(1,-1)}</em>:part):' '}</p>)}</>;
}
