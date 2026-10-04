'use client';
import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {Action,CashKind,Data,Payload,brl,day,loanOpen} from '@/lib/domain';

type Kind=CashKind|'despesa';
const GROUPS:{title:string;items:{k:Kind;label:string;hint:string}[]}[]=[
 {title:'💸 Saiu dinheiro',items:[
  {k:'despesa',label:'Despesa',hint:'Gasto do negócio: embalagem, anúncio, estacionamento, ferramenta… Abate do resultado. Compra de mercadoria não é despesa: use Entradas / Lotes → Nova compra.'},
  {k:'pagamento_emprestimo',label:'Pagamento de empréstimo',hint:'Sai do caixa e abate a dívida. Só os juros (se houver) entram como despesa.'},
  {k:'retirada',label:'Retirada',hint:'Dinheiro que você tirou da empresa para uso pessoal. Sai do caixa, mas não é despesa do negócio.'}]},
 {title:'💰 Entrou dinheiro',items:[
  {k:'emprestimo',label:'Empréstimo recebido',hint:'Dinheiro emprestado para a empresa. Entra no caixa e vira dívida em aberto; não é faturamento.'},
  {k:'aporte',label:'Aporte (dinheiro seu)',hint:'Dinheiro que você colocou na empresa, como pagar algo do próprio bolso.'}]},
 {title:'⚙️ Ajuste',items:[
  {k:'saldo_inicial',label:'Saldo inicial',hint:'Quanto dinheiro a empresa tinha no começo do dia escolhido. O caixa passa a contar a partir dessa data.'}]}];
const ALL=GROUPS.flatMap(g=>g.items);
const CATEGORIES=['Anúncios','Entrega','Embalagem','Ferramentas/sistemas','Outros'];

export function CashForm({data,initialKind,loanId,onSave,onClose,busy,error}:{data:Data;initialKind?:CashKind;loanId?:string;onSave:(a:Action,p:Payload)=>Promise<boolean>;onClose:()=>void;busy:boolean;error:string}) {
 const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 const openLoans=(data.cash??[]).filter(c=>c.kind==='emprestimo'&&loanOpen(data,c.id)>0);
 const [kind,setKind]=useState<Kind>(initialKind??'despesa');const [amount,setAmount]=useState('');const [interest,setInterest]=useState('');
 const [date,setDate]=useState(day());const [description,setDescription]=useState('');const [category,setCategory]=useState('Outros');const [loan,setLoan]=useState(loanId??openLoans[0]?.id??'');
 const info=ALL.find(x=>x.k===kind)!;const open=loan?loanOpen(data,loan):0;
 async function submit(e:React.FormEvent){e.preventDefault();
  if(kind==='despesa'){await onSave('record_expense',{category,description,amount:Number(amount),date});return;}
  await onSave('record_cash_entry',{kind,amount:Number(amount),date,description,loan_id:kind==='pagamento_emprestimo'?loan:undefined,interest:kind==='pagamento_emprestimo'?Number(interest||0):0});}
 return <dialog ref={dialog} className="modal cash-modal" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} aria-labelledby="cash-title"><form onSubmit={submit}>
  <div className="modal-head"><div><span className="eyebrow">FINANCEIRO</span><h2 id="cash-title">Novo lançamento</h2></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Fechar"><X size={20}/></button></div>
  <fieldset disabled={busy}>
   <div className="kind-groups" role="radiogroup" aria-label="O que aconteceu?">{GROUPS.map(g=><div key={g.title} className="kind-group"><span>{g.title}</span><div>{g.items.map(x=>{const disabled=x.k==='pagamento_emprestimo'&&!openLoans.length;
    return <label key={x.k} className={`kind-option${kind===x.k?' active':''}${disabled?' disabled':''}`}><input type="radio" name="cash-kind" checked={kind===x.k} disabled={disabled} onChange={()=>setKind(x.k)}/>{x.label}</label>;})}</div></div>)}</div>
   <p className="hint cash-hint">{info.hint}</p>
   {kind==='pagamento_emprestimo'&&<label>Empréstimo<select required value={loan} onChange={e=>setLoan(e.target.value)}>{openLoans.map(l=><option key={l.id} value={l.id}>{l.description||'Empréstimo'} · {l.date.split('-').reverse().join('/')} · em aberto {brl(loanOpen(data,l.id))}</option>)}</select></label>}
   {kind==='despesa'&&<label>Categoria<select value={category} onChange={e=>setCategory(e.target.value)}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></label>}
   <div className="form-grid"><label>{kind==='pagamento_emprestimo'?'Valor pago (R$)':'Valor (R$)'}<input type="number" min="0.01" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)}/></label>
    <label>Data<input type="date" required max={day()} value={date} onChange={e=>setDate(e.target.value)}/></label></div>
   {kind==='pagamento_emprestimo'&&<><label>Dos quais juros (R$) · opcional<input type="number" min="0" step="0.01" value={interest} onChange={e=>setInterest(e.target.value)} placeholder="0,00"/></label>
    <p className="hint">Abate da dívida: <strong>{brl(Math.max(0,Number(amount||0)-Number(interest||0)))}</strong> · saldo em aberto depois: <strong>{brl(Math.max(0,open-Math.max(0,Number(amount||0)-Number(interest||0))))}</strong></p></>}
   {kind!=='pagamento_emprestimo'&&<label>Descrição{kind==='despesa'||kind==='emprestimo'?'':' (opcional)'}<input maxLength={200} required={kind==='despesa'||kind==='emprestimo'} value={description} onChange={e=>setDescription(e.target.value)} placeholder={kind==='despesa'?'Ex.: Estacionamento na compra do lote':kind==='emprestimo'?'Ex.: Empréstimo para a compra do Lote 2':''}/></label>}
  </fieldset>{error&&<p className="error" role="alert">{error}</p>}
  <div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button" disabled={busy}>{busy?'Salvando…':'Confirmar lançamento'}</button></div>
 </form></dialog>;
}
