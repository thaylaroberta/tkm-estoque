# Clara — Estoque e financeiro, V1

Aplicação genérica para comércio de produtos não restritos. Demonstração com papelaria fictícia. Next.js App Router, React, TypeScript, Supabase Auth e Postgres. Interface em português, BRL e datas no fuso America/Sao_Paulo.

## O que está pronto

- Login por e-mail e senha com conta compartilhada, autorizada explicitamente no banco.
- Dashboard com faturamento, CMV/capital recuperado, lucro bruto, despesas, perdas, resultado e margem líquida, unidades vendidas, estoque, capital, venda/lucro potencial, mais vendidos e estoque baixo.
- Produtos com marca, modelo, categoria, preço padrão, mínimo por variedade; cadastro e edição de produtos, adição de variedades.
- Compras por lote, vários itens, custo variável e frete proporcional, com detalhamento do rateio.
- Vendas com vários itens, preços editáveis, Pix/Dinheiro/Débito/Crédito e taxa repassada em reais.
- Entrega cobrada do cliente e custo real na venda, despesa automática vinculada e resultado do transporte positivo ou negativo.
- Despesas manuais por categoria e data; campos de origem/identificador externo preparados para integração futura.
- Relatório de produtos com ranking, giro, variedade líder, última venda, dias sem venda e CSV.
- Histórico imutável de entradas, vendas e ajustes com motivo.
- Modo demo local funcional, separado do Supabase. Reiniciar demo restaura apenas os dados fictícios desse navegador.

## Executar localmente

Requer Node.js 22 ou superior. As dependências exatas estão em `pnpm-lock.yaml`.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Abra http://localhost:3000. Para explorar apenas a demo, não crie `.env.local` ou deixe ambas as variáveis vazias. Não use os valores de exemplo como credenciais reais.

Alternativa com npm: `npm install` e `npm run dev`. O arquivo de lock entregue é do pnpm; mantenha apenas um gerenciador por projeto.

## Configurar Supabase

1. Crie um projeto Supabase para o negócio.
2. Execute, nesta ordem, no SQL Editor:
   - `supabase/migrations/001_initial.sql`
   - `supabase/migrations/002_snapshot.sql`
   - `supabase/migrations/003_delivery.sql`
3. No painel Authentication, desative o cadastro público de novos usuários. Crie manualmente o usuário compartilhado com e-mail e senha, confirmado. A aplicação não possui formulário de cadastro.
4. Copie o UUID desse usuário e autorize no SQL Editor:

```sql
insert into public.app_users (user_id)
values ('UUID-DO-USUARIO-DO-AUTH');
```

5. Para um ambiente de teste, execute `supabase/seed.sql`. Ele só aceita banco vazio e cria 44 unidades fictícias de papelaria: R$ 480 em mercadorias + R$ 48 em frete = R$ 528 de custo. Venda potencial R$ 972 e lucro bruto potencial R$ 444. Não execute o seed no ambiente real se quiser começar com estoque vazio.
6. Preencha `.env.local` com a URL do projeto e a chave pública anon/publishable:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://SEU-PROJETO.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=SUA-CHAVE-PUBLICA
```

Não use `service_role` no frontend. O acesso não depende do segredo da chave pública: depende de Supabase Auth, da lista `app_users`, RLS e permissões SQL.

7. Reinicie a aplicação e entre. Para recuperar acesso à conta compartilhada nesta V1, use a administração de usuários do Supabase. Não há recuperação de senha por e-mail na interface.

## Deploy na Vercel

1. Coloque o conteúdo desta pasta em um repositório privado.
2. Importe o repositório na Vercel. Se a pasta estiver dentro de outro repositório, escolha `controle-v1` como **Root Directory**.
3. Selecione Next.js e Node.js 22 (ou versão superior suportada), com build `pnpm build` e instalação `pnpm install --frozen-lockfile`.
4. Configure as duas variáveis `NEXT_PUBLIC_SUPABASE_*` no ambiente de produção e nos ambientes de preview que devam acessar esse banco. Use banco separado para testes.
5. Faça o deploy. As variáveis públicas são incorporadas na compilação; mudanças exigem novo deploy.
6. No Supabase Auth, configure a Site URL com o endereço publicado. Cadastros públicos devem permanecer desativados.
7. Entre pela conta autorizada e valide uma operação de teste em banco de teste antes de lançar dados reais.

Nenhuma conta Supabase/Vercel foi criada e nenhum deploy público foi executado nesta entrega. O código está pronto para essas etapas, que dependem das suas contas e configurações.

## Regras financeiras

- **Frete:** cada linha recebe `frete × valor da mercadoria da linha / total da mercadoria`. Rateio em centavos, com o restante no último item e limite ao saldo de frete. A soma das parcelas é exata. O detalhamento fica preservado no lote.
- **Custo médio por variedade:** valor contábil atual ÷ quantidade atual. Novas compras somam quantidade e custo com frete. O banco mantém valor de estoque/CMV em decimal com seis casas; a tela exibe duas.
- **CMV:** custo médio vigente na gravação × quantidade vendida. Fica congelado em cada item da venda. A última unidade retira todo o valor restante, sem saldo residual.
- **Preço promocional:** preço unitário final por item; pode ser zero para uma saída promocional. O CMV continua sendo reconhecido.
- **Taxa de cartão:** valor informado já em reais, acrescido ao total cobrado. Não compõe receita, lucro ou despesas; o sistema não calcula a taxa da adquirente nem a liquidação bancária.
- **Capital recuperado:** CMV das unidades vendidas no período. Não é saldo de caixa, lucro acumulado ou conciliação de recebimentos.
- **Entrega:** a venda guarda `delivery_charged` (cobrança) e `delivery_cost` (custo). O faturamento total soma produtos e entrega cobrada. O custo gera uma única despesa de categoria Entrega e origem Venda, ligada por `sale_id`, na mesma transação. Não lançar esse custo novamente manualmente. Cobrar R$ 10 com custo R$ 7 gera R$ 3 de resultado de transporte; custo R$ 15 gera −R$ 5. Entrega grátis aceita cobrança zero com custo positivo.
- **Lucro bruto:** faturamento (produtos + entrega cobrada, sem taxas repassadas) − CMV. O custo da entrega entra abaixo, como despesa, para chegar ao líquido. O relatório de produtos continua considerando só receita/CMV dos produtos.
- **Total cobrado do cliente:** produtos + entrega cobrada + taxa de cartão repassada.
- **Lucro líquido gerencial:** lucro bruto − despesas − perdas por ajustes negativos. Margem líquida = lucro líquido / faturamento; com faturamento zero, mostra 0%.
- **Ajuste negativo:** retira estoque ao custo médio; valor aparece como perda no resultado. Ajuste positivo exige custo informado, aumenta o capital e não representa receita. Compras devem ser registradas como lotes.
- **Giro:** unidades vendidas no período ÷ média do estoque de abertura e encerramento, em unidades. A abertura corresponde ao saldo anterior à data inicial. Sem data inicial, considera abertura zero. Média zero aparece como “—”. É uma aproximação por saldos, não média diária.
- **Filtros:** resultado usa vendas e despesas do período inclusive, em Brasília. Estoque e capital são atuais; última venda/dias sem venda usam todo o histórico. Potencial usa os preços padrão atuais.
- **Datas de estoque:** compras, vendas e ajustes recebem data/hora do servidor, por ordem de lançamento. Esta V1 não permite retroagir esses lançamentos para não recalcular o custo histórico. Despesas permitem informar a data.
- Valores de custo arredondados em linhas podem diferir em um centavo da soma visual; os totais usam a precisão interna.

## Integridade e acesso

Operações de estoque são funções transacionais no Postgres. Um bloqueio transacional serializa as escritas desse negócio, impedindo disputas de saldo. Qualquer erro desfaz a operação inteira. Uma chave de requisição evita duplicar vendas, compras, despesas e ajustes em tentativas repetidas. Cadastro de produto não tem garantia de idempotência em caso de interrupção da rede; atualize e confira antes de repetir.

Tabelas de negócio permitem apenas leitura ao usuário autorizado. Escritas diretas e acesso anônimo são bloqueados. Funções `security definer` têm caminho de busca fixo e conferem a lista autorizada antes de ler ou gravar. O snapshot obtém dados consistentes em uma chamada, sem o limite padrão de mil linhas das consultas REST.

A conta compartilhada significa que o histórico identifica a conta, não a pessoa física. Não há separação de empresas ou múltiplos perfis. Produtos e lançamentos não são excluídos pela interface. Ajustes de estoque não estornam uma venda nem revertem receita.

## Limites desta V1

- Sem cancelamento/estorno de vendas ou despesas, contas a pagar/receber, parcelas, conciliação bancária ou emissão fiscal.
- Sem integração ativa com anúncios. `expenses.source` e `external_id` (únicos em conjunto) permitem futura ingestão por backend autorizado, com deduplicação. Nunca exponha chaves de anúncios no navegador.
- Demonstração em `localStorage` não deve guardar dados reais nem servir como backup. O seed SQL contém apenas estoque inicial; a demo visual acrescenta duas vendas, uma despesa de embalagem e uma de entrega vinculada fictícias para ilustrar os relatórios.
- A V1 carrega o histórico completo em memória. Adequada para operação pequena; maior volume exige relatórios SQL agregados e paginação.
- Atualização entre navegadores é manual pelo botão Atualizar; o banco continua validando o saldo real. Configure backups e recuperação conforme seu plano Supabase.

## Verificação

```sh
pnpm typecheck
pnpm test
pnpm build
```

Os testes usam Postgres embarcado (PGlite) para executar as migrations e as funções reais, além do motor local. Cobrem autorização/RLS, bloqueio de escrita direta, rateio, CMV, congelamento do custo histórico, rollback, idempotência, ajustes, transporte com ganho/perda sem duplicação de despesa e separação entre período, estoque e taxa. Não substituem a validação da autenticação e da conexão na sua instância Supabase.

## Estrutura

- `app/`: página, layout e estilos responsivos.
- `components/`: navegação, telas e formulários.
- `lib/domain.ts`: tipos, demonstração, indicadores e exportação.
- `lib/supabase.ts`: cliente público autenticado.
- `supabase/`: migrations e seed fictício opcional.
- `tests/`: testes de regras e banco.

Referências: [Next.js — instalação](https://nextjs.org/docs/app/getting-started/installation), [Supabase — RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Supabase — funções RPC](https://supabase.com/docs/reference/javascript/rpc).

### Atualizar uma instalação anterior

Se as migrations 001 e 002 já foram aplicadas, execute somente `003_delivery.sql` e publique a versão atualizada do frontend. Vendas anteriores recebem cobrança/custo de entrega zero. Nenhuma despesa anterior é reclassificada automaticamente. O custo da entrega deve ser informado ao registrar a venda; a V1 ainda não tem edição posterior de vendas.
