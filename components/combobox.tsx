'use client';
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {Search} from 'lucide-react';

export type ComboOption={value:string;label:string;detail?:string;disabled?:boolean;keywords?:string};
const norm=(s:string)=>s.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();

/** Campo de busca com lista: digite parte do produto ou do sabor e escolha. Teclado: ↑ ↓ Enter Esc. */
export function Combobox({label,options,value,onChange,placeholder='Digite para buscar…',required=false,name,createLabel,onCreate,autoFocus}:{
 label:string;options:ComboOption[];value:string;onChange:(value:string)=>void;placeholder?:string;required?:boolean;name?:string;
 /** Quando o texto não corresponde a nada, oferece criar (ex.: novo sabor). */
 createLabel?:(text:string)=>string;onCreate?:(text:string)=>void;autoFocus?:boolean;
}) {
 const id=useId();const input=useRef<HTMLInputElement>(null);const listRef=useRef<HTMLUListElement>(null);
 const selected=options.find(o=>o.value===value);
 const [text,setText]=useState(selected?.label??'');const [open,setOpen]=useState(false);const [active,setActive]=useState(0);
 useEffect(()=>{if(!open)setText(selected?.label??'');},[selected?.label,open]);
 const terms=norm(text).split(/\s+/).filter(Boolean);
 const typing=open&&text!==(selected?.label??'');
 const filtered=useMemo(()=>!typing?options:options.filter(o=>{const hay=norm(`${o.label} ${o.detail??''} ${o.keywords??''}`);return terms.every(t=>hay.includes(t));}),[options,typing,text]);// eslint-disable-line react-hooks/exhaustive-deps
 const canCreate=!!onCreate&&typing&&text.trim().length>0&&!options.some(o=>norm(o.label)===norm(text.trim()));
 const total=filtered.length+(canCreate?1:0);
 useEffect(()=>{const first=filtered.findIndex(o=>!o.disabled);setActive(first>=0?first:canCreate?filtered.length:0);},[text]);// eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{input.current?.setCustomValidity(required&&!selected&&!open?'Escolha uma opção da lista':'');},[required,selected,open]);
 useEffect(()=>{listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block:'nearest'});},[active]);
 function pick(index:number){if(index<filtered.length){const o=filtered[index];if(o.disabled)return;onChange(o.value);setText(o.label);}else if(canCreate){onCreate!(text.trim());}setOpen(false);}
 function key(e:React.KeyboardEvent<HTMLInputElement>){
  if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);setActive(i=>Math.min(i+1,total-1));}
  else if(e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(i-1,0));}
  else if(e.key==='Enter'&&open){e.preventDefault();pick(active);}
  else if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();setOpen(false);setText(selected?.label??'');}
 }
 return <label className="combobox">{label}
  <span className="combobox-field"><Search size={15} aria-hidden/>
   <input ref={input} role="combobox" aria-expanded={open} aria-controls={id} aria-autocomplete="list" autoComplete="off" autoFocus={autoFocus}
    aria-activedescendant={open&&total?`${id}-${active}`:undefined} placeholder={placeholder} value={text} required={required}
    onFocus={e=>{setOpen(true);e.currentTarget.select();const el=e.currentTarget;if(window.matchMedia('(max-width: 600px)').matches)setTimeout(()=>el.scrollIntoView({block:'start',behavior:'smooth'}),300);}} onChange={e=>{setText(e.target.value);setOpen(true);}} onKeyDown={key}
    onBlur={()=>{setOpen(false);setText(selected?.label??'');}}/>
   {name&&<input type="hidden" name={name} value={value}/>}
  </span>
  {open&&<ul className="combobox-list" id={id} role="listbox" ref={listRef}>
   {filtered.map((o,i)=><li key={o.value} id={`${id}-${i}`} data-index={i} role="option" aria-selected={o.value===value} aria-disabled={o.disabled||undefined}
    className={`${i===active?'active':''}${o.disabled?' disabled':''}`} onMouseDown={e=>{e.preventDefault();pick(i);}} onMouseEnter={()=>setActive(i)}>
    <span>{o.label}</span>{o.detail&&<small>{o.detail}</small>}</li>)}
   {canCreate&&<li id={`${id}-${filtered.length}`} data-index={filtered.length} role="option" aria-selected={false} className={`create${active===filtered.length?' active':''}`}
    onMouseDown={e=>{e.preventDefault();pick(filtered.length);}}>{createLabel?createLabel(text.trim()):`+ Criar "${text.trim()}"`}</li>}
   {!total&&<li className="empty-option" role="presentation">Nada encontrado para “{text}”.</li>}
  </ul>}
 </label>;
}
