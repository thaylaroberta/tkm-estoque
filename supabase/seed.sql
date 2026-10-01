-- OPCIONAL: papelaria fictícia; executar uma vez após a migration, antes de lançamentos reais.
begin;
do $$
declare pid uuid; vid uuid; bid uuid; spec record; begin
 if exists(select 1 from public.batches) or exists(select 1 from public.products) then
 raise exception 'Seed permitido apenas em banco vazio. Use projeto separado para demonstração.';
 end if;
 insert into public.batches(name,freight,merchandise,request_id) values('Compra demonstrativa',48,480,'00000000-0000-4000-8000-000000000001') returning id into bid;
 for spec in select * from (values
 ('Aurora','Caderno A5','Cadernos',35,3,'Verde sálvia',10,18),
 ('Aurora','Caderno A5','Cadernos',35,3,'Areia',6,18),
 ('Traço','Caneta gel','Escrita',9,5,'Preta',12,4),
 ('Traço','Caneta gel','Escrita',9,5,'Azul',8,4),
 ('Organiza','Estojo','Acessórios',29,2,'Natural',8,14)
 ) as x(brand,model,category,price,minimum,name,qty,cost) loop
 select id into pid from public.products where brand=spec.brand and model=spec.model;
 if not found then insert into public.products(brand,model,category,price,minimum) values(spec.brand,spec.model,spec.category,spec.price,spec.minimum) returning id into pid; end if;
 insert into public.variants(product_id,name,quantity,value) values(pid,spec.name,spec.qty,spec.qty*spec.cost*1.1) returning id into vid;
 insert into public.batch_items(batch_id,variant_id,quantity,unit_cost,freight) values(bid,vid,spec.qty,spec.cost,spec.qty*spec.cost*.1);
 insert into public.movements(variant_id,kind,quantity,value,reference_id,reason) values(vid,'Entrada',spec.qty,spec.qty*spec.cost*1.1,bid,'Saldo demonstrativo');
 end loop;
end $$;
commit;
