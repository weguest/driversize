# DriverSize

Analisador de uso de disco (Electron + Angular 20 + TypeScript).

## Funcionalidades (MVP)

- **Janela sem moldura** com barra de título própria (ícone, nome, subtítulo) e os botões nativos
  do Windows desenhados pelo `titleBarOverlay` (minimizar/maximizar/fechar, snap layouts).
- **Tela de abertura (splash)** com a arte do produto enquanto o renderer carrega: aparece já pintada,
  fica no ar pelo menos ~1,2 s e se desfaz em fade quando a janela principal está pronta — e pode ser
  desligada em Opções ▸ Exibir.
- **Pasta inicial**: ao abrir, entra na pasta **Documentos do usuário logado** (caminho conhecido do
  shell, então um Documentos redirecionado para OneDrive/outro drive é respeitado) e lista o conteúdo
  sem varrer — a varredura só começa quando o usuário clica em **Escanear**.
- Barra de ações: campo de caminho (com histórico de pastas recentes), botão dividido **Escanear**
  (que fica **vermelho com "Parar"** durante a varredura, para interrompê-la), **Filtros**,
  **Monitorar**, **Resscanear**, os atalhos **Duplicados** e **Limpeza segura** (também no menu
  **⋮ ▸ Ferramentas**) e o menu **⋮** (Arquivo | Varredura | Ferramentas | Exibir | Ajuda).
- **⋮ ▸ Ferramentas ▸ Inspecionar elemento…**: arma um seletor (cursor em cruz) e, no clique
  seguinte, abre o DevTools já apontando para o elemento escolhido — útil para diagnóstico de
  layout/tema. **Esc** cancela.
- **Barra lateral**: Visão geral (a árvore da pasta analisada ou, sem análise, as unidades no estilo
  "Este computador"), Pastas favoritas (pastas do sistema + favoritas do usuário), Unidades com barra
  de espaço livre e atalhos para Configurações/Sobre.
- Cabeçalho da pasta: ícone, nome, caminho, tamanho total, nº de arquivos/pastas e data da última análise.
- **Arquivos e pastas**: tabela ordenável (Nome, Tamanho com barra proporcional, **No disco**, %, Itens,
  Tipo, Modificado), busca instantânea, visualização em lista ou grade e seleção múltipla. A coluna
  **No disco** mostra o espaço realmente alocado (tamanho de alocação do Windows, não apenas o tamanho
  lógico) e pode ser ocultada em Opções ▸ Exibir.
- **Busca global** (**Ctrl+Shift+F** ou ⋮ ▸ Ferramentas ▸ Busca global…): procura por nome em **todos**
  os arquivos e pastas da área analisada, com resultados ordenados por tamanho; **Enter** ou clique
  abre o item já selecionado na pasta de origem.
- **Tipos de arquivo**: tabela de extensões (tamanho, %, nº de arquivos); clicar numa linha filtra
  a lista inteira pela extensão.
- **Painel direito** com abas Gráfico (donut por categoria de arquivo + card "Maiores arquivos"),
  Tipos (categorias) e Extensões (detalhe por extensão). O card "Maiores arquivos" tem dois atalhos:
  **Ver todos** (a subárvore aberta) e **Da unidade** (os 500 maiores de toda a área analisada, com
  abrir/mostrar na pasta e menu do Windows).
- **Duplicados**: procura arquivos idênticos dentro da área analisada. Agrupa por tamanho, compara
  início/fim dos arquivos e confirma com hash completo num `worker_threads` (progresso em duas fases,
  cancelável). A lista mostra os grupos, o espaço recuperável, mantém sempre uma cópia por grupo
  (checkbox travado) e envia as cópias marcadas para a **Lixeira**.
- **Limpeza segura**: mede no processo principal (em segundo plano) os locais que costumam acumular
  espaço — temporários do usuário e do Windows, cache do Windows Update, Lixeira, Downloads sem
  alteração há 90 dias, caches de Chrome/Edge/Brave/Firefox, cache de miniaturas e o arquivo de
  hibernação (informativo). Nada é apagado sem duas confirmações; Downloads vão para a Lixeira e os
  itens protegidos são marcados como "administrador".
- **Aparência**: tema **claro, escuro ou do sistema** (o padrão acompanha o Windows ao vivo, inclusive o
  overlay nativo dos botões da janela, as barras de rolagem e os popups de `<select>`), densidade
  **normal/compacta** e coluna **No disco**, em Opções ▸ Aparência, persistidos.
- **Exclusões de varredura** (Opções ▸ Varredura): uma regra por linha — caminho absoluto (prefixo) ou
  nome/máscara (`node_modules`, `*.iso`) — aplicada à raiz e aos `worker_threads`, útil para ignorar
  caches e pastas de projeto.
- Atalhos: **F5** refaz a varredura, **Enter** abre a pasta/arquivo, **Delete** manda para a Lixeira,
  **F2** renomeia, **Ctrl+A** seleciona tudo, **Ctrl+F** foca a busca da pasta, **Ctrl+Shift+F** abre a
  busca global, **Backspace** sobe um nível, **Esc** fecha diálogos, **Alt+←/→/↑** navegam.
- **Barra de status**: estado, arquivos, pastas, tamanho, tempo e uso da unidade atual. Durante a
  varredura, mostra também a **pasta que está sendo lida naquele instante** (inclusive subpastas,
  atualizada ~2×/s, com o caminho abreviado no meio e o caminho completo no tooltip) e a **velocidade**
  em arquivos por segundo, para se saber exatamente onde o trabalho está e quanto falta.
- **Progresso na barra de tarefas**: varredura e limpeza ficam em andamento (indeterminado) e os
  duplicados mostram o avanço real das duas fases (45% + 55%), voltando ao normal ao terminar/cancelar.
- **Histórico da limpeza segura**: cada limpeza grava um registro JSON em
  `%APPDATA%\DriverSize\logs\` (data, itens, total liberado, erros) e o diálogo mostra a **última
  limpeza** com o atalho **Abrir registro**.
- **Unidades plug-and-play**: pendrive, HD externo ou volume montado aparece (ou desaparece) na lateral e
  na Visão geral em ~3 s, com aviso na barra de status; se a unidade aberta for removida, o app volta para
  Documentos em vez de continuar num caminho inexistente.
- Varredura com **pool de `worker_threads`** (paralelismo por subpasta) e **cancelamento** por flag
  atômica compartilhada entre os workers.
- **Menu de contexto nativo** do Windows (addon) no botão direito — em arquivos, pastas e **unidades**
  (Formatar..., Ejetar, BitLocker, Propriedades/Ferramentas de disco, extensões instaladas), no idioma do
  Windows; o menu próprio do app continua como alternativa quando o addon não está disponível.
- **Filtro** por máscara, tamanho, atributos e datas, aplicado à análise já concluída.
- Export **CSV**/**XML**, relatório **HTML**, impressão da árvore/lista, sessões salvas/abertas.
- Unidades de tamanho B/KB/MB/GB/AUTO, monitoramento de mudanças (`fs.watch`), bandeja do sistema.
- Interface em **português, inglês, espanhol e francês** (números/datas por locale).

## Como rodar

```powershell
npm install          # se necessário
npm run build        # compila o Angular -> dist/driversize/browser
npm run build:electron   # compila o main/preload/worker -> dist-electron
npm run electron     # abre o app
```

Ou tudo de uma vez:

```powershell
npm start            # build + build:electron + electron
```

Modo desenvolvimento (Angular dev-server + Electron):

```powershell
npm run dev          # ng serve em :4200 + electron apontando para ele
```

## Empacotar (electron-builder)

```powershell
npm run pack            # pasta release/win-unpacked (rápido, sem instalador)
npm run dist            # instalador NSIS + executável portátil
npm run dist:portable   # só o portátil
```

Os artefatos saem em `release/` (`DriverSize-<versão>-setup.exe`, `DriverSize-<versão>-portable.exe`).
O Electron usado é o de `node_modules/electron/dist` (sem download), o addon nativo
(`native/shellmenu/build/Release/shellmenu.node`) é mantido fora do `.asar` e o idioma/pasta inicial
vêm das mesmas configurações de `%APPDATA%\DriverSize`.

## Versões

### 1.2.1

- **Pastas primeiro ao ordenar por tamanho**: nas colunas **Tamanho**, **No disco** e **%**, as pastas
  ficam sempre agrupadas no topo e os arquivos vêm depois, mantendo a ordenação crescente/decrescente
  dentro de cada grupo. As demais colunas (Nome, Modificado, Itens, Tipo) continuam misturando pastas e
  arquivos normalmente, e a ordenação por nome segue alfabética.

### 1.2.0

- **Tema do sistema**: nova opção **Sistema** (agora o padrão) segue o modo claro/escuro do Windows ao
  vivo, sem reiniciar; **Claro** e **Escuro** continuam disponíveis. Os botões nativos da janela, as
  barras de rolagem e os popups de `<select>` acompanham o tema efetivo.
- **Progresso na barra de tarefas**: varredura e limpeza aparecem como andamento indeterminado; os
  duplicados mostram o avanço real (45% na triagem + 55% no hash), limpo ao terminar ou cancelar.
- **Velocidade da varredura** na barra de status (`19.735 arq/s`), com média móvel.
- **Busca global** (**Ctrl+Shift+F** ou ⋮ ▸ Ferramentas ▸ Busca global…): pesquisa em todos os arquivos e
  pastas analisados, até 400 resultados ordenados por tamanho; **Enter**/clique abre o item selecionado.
  Não empilha diálogos: o atalho é ignorado enquanto outro diálogo está aberto.
- **Exclusões de varredura** (Opções ▸ Varredura): uma regra por linha, caminho absoluto (prefixo) ou
  nome/máscara sem diferenciar maiúsculas (`node_modules`, `*.iso`, `?`). Aplicadas na raiz e dentro dos
  `worker_threads`; exemplo real: Documentos caiu de 100.821 para 1.117 arquivos ignorando
  `node_modules`.
- **Coluna "No disco"**: mostra o espaço realmente alocado por arquivo/pasta (tamanho de alocação
  informado pelo Windows, via `st.blocks * 512`), ao lado do tamanho lógico; pode ser ocultada em
  Opções ▸ Exibir. Arquivos residentes na MFT aparecem legitimamente com 0.
- **Histórico da limpeza segura**: cada execução grava um JSON em
  `%APPDATA%\DriverSize\logs\cleanup-AAAA-MM-DD_HH-MM-SS.json` e o diálogo exibe a **última limpeza**
  (data, total liberado) com **Abrir registro**. O registro sobrevive ao reinício.
- **Desempenho**: formatadores `Intl` passaram a ser cacheados por locale (eram 58% do CPU do renderer),
  as atualizações de tela são agrupadas (no máximo uma a cada 120 ms) e o fim da varredura força o
  desenho final. Documentos (~100 mil arquivos) caiu de 14–15 s para **~5,5 s**, e a interface deixou de
  travar durante o scan (pior latência de 2,9 s para menos de 100 ms; perfil 99% ocioso).
- **Atalhos**: **Ctrl+F** foca a busca da pasta, **Ctrl+Shift+F** abre a busca global e **Backspace**
  sobe um nível (além de F5/Esc/Alt+←→↑ já existentes).
- **Opções reorganizadas**: grade de duas colunas, uma configuração por linha (Tema, Densidade, Idioma,
  Unidade de tamanho, Exibir, Segundo plano) e seção própria para as exclusões, com dica de formato.
- **Visualização em grade**: os cartões voltaram a ter altura compacta (105 px) e ficam alinhados ao
  topo, em vez de esticarem para preencher a janela.
- README e textos nos quatro idiomas (pt/en/es/fr) atualizados.

### 1.1.3

- **Barras de rolagem no tema escuro**: deixaram de aparecer brancas. Agora são desenhadas com as
  cores do tema (polegar `#4a515b` no escuro e `#c9cfd6` no claro, trilho transparente, 12 px com
  cantos arredondados), em todas as listas — tabela, barra lateral e diálogos. O `color-scheme`
  também acompanha o tema, então popups de `<select>`, checkboxes e barras nativas seguem o mesmo
  contraste.

### 1.1.2

- **Barra de status durante a varredura**: mostra a pasta que está sendo lida naquele instante,
  inclusive quando desce para subpastas (`C:\…\node_modules\rxjs\_esm2015\internal\observable`).
  Os workers do scan passaram a informar o diretório corrente nos ticks de progresso (200 ms, com
  repasse limitado a 120 ms no processo principal) e o rótulo é escrito direto no DOM, para continuar
  andando mesmo quando a interface está ocupada processando lotes de arquivos. O tooltip tem o caminho
  completo e o texto some ao terminar a varredura.
- **Barra de ações** com 4 px de respiro no topo, separando-a da barra de título.
- README atualizado.

### 1.1.1

- **⋮ ▸ Ferramentas ▸ Inspecionar elemento…**: novo item de menu que arma um seletor de elemento
  (cursor em cruz com dica na tela); o clique seguinte chama `webContents.inspectElement` e abre o
  DevTools do Electron já focado no elemento escolhido. **Esc** cancela a seleção. Textos nos quatro
  idiomas (pt/en/es/fr).

### 1.1.0

- **Duplicados** (novo ícone na barra de ações, ou **⋮ ▸ Ferramentas ▸ Duplicados**): procura
  arquivos idênticos na área analisada com
  filtro de tamanho mínimo (100 KB a 100 MB). O processo principal roda um `worker_threads`
  (`electron/dupes/worker.ts`): agrupa por tamanho, compara os primeiros/últimos 64 KB e só então faz o
  hash completo — progresso em duas fases, cancelável e sem travar a interface. O diálogo mostra os
  grupos, o total recuperável, mantém sempre uma cópia por grupo (checkbox desabilitado, marcada como
  "manter") e envia as cópias selecionadas para a **Lixeira**; a árvore é atualizada na hora.
- **Limpeza segura** (novo ícone, ou **⋮ ▸ Ferramentas ▸ Limpeza segura**): mede em segundo plano os
  temporários do usuário e do Windows, o cache
  do Windows Update, a Lixeira, os Downloads sem alteração há mais de 90 dias, os caches de
  Chrome/Edge/Brave/Firefox, o cache de miniaturas e o arquivo de hibernação (somente informativo).
  Tamanhos aparecem linha a linha conforme são calculados; a limpeza exige **duas confirmações**, avisa
  o que é permanente, marca o que precisa de administrador e informa o total liberado e o que não pôde
  ser removido (em uso). Downloads vão para a Lixeira; o resto é apagado direto.
- **Maiores arquivos da unidade**: o card do painel direito ganhou o atalho **Da unidade**, que lista os
  500 maiores arquivos de toda a varredura (não só da pasta aberta), com tamanho, %, tipo, pasta de
  origem, abrir, mostrar na pasta e menu de contexto do Windows.
- **Aparência**: tema **claro/escuro** e densidade **normal/compacta** em Opções ▸ Aparência, ambos
  persistidos; no tema escuro o `titleBarOverlay` (botões nativos da janela) e a cor de fundo da janela
  são repintados pelo processo principal. Os gráficos (donut) e todos os painéis usam os novos tokens de
  cor — auditoria automática de contraste sem nenhum texto abaixo de 3:1.
- **Vitórias rápidas**: **F5** refaz a varredura (consta na lista de atalhos da Ajuda) e o botão
  **Mostrar na pasta** (`shell.showItemInFolder`) aparece nos diálogos de maiores arquivos e duplicados.
- **Menu ⋮**: novo grupo **Ferramentas** com **Duplicados...** e **Limpeza segura...**, nos quatro
  idiomas, espelhando os dois novos botões da barra de ações.
- README, dicas da interface e os quatro idiomas (pt/en/es/fr) foram atualizados com todos os textos
  novos.

### 1.0.2

- **Visão geral** sem análise passa a mostrar **"Este computador"**: as unidades em cartões, com barra de
  uso e espaço livre (clicar abre a unidade, sem varrer); com análise, continua mostrando a árvore.
- Cabeçalho da **Visão geral** descreve a própria tela (caminho "Este computador" e espaço somado das
  unidades quando não há análise; totais da pasta analisada quando há), em vez dos números da pasta aberta.
- **Unidades plug-and-play**: o processo principal passa a observar as letras de unidade e envia
  `drives:changed` ao renderer quando um pendrive/HD externo é conectado ou removido (detecção em ~3 s,
  leitura assíncrona para nunca travar a interface). A tela é atualizada na hora e a barra de status avisa;
  se a unidade aberta desaparecer, o app cancela a análise e volta para Documentos.
- **Botão direito nas unidades** (lateral, "Este computador" e cartões) abre o menu real do Windows da
  unidade — Formatar..., Ejetar, BitLocker, Propriedades (com as ferramentas de disco), extensões
  instaladas. O addon passou a fixar o idioma do Windows (`SetThreadUILanguage`) e a chamar
  `SetForegroundWindow` antes do `TrackPopupMenu`, para o menu não fechar sozinho.

### 1.0.1

- Abre na pasta **Documentos** do usuário logado, apenas listando o conteúdo (sem varrer).
- Clicar em pasta do sistema, favorita ou unidade na barra lateral **não inicia mais varredura** — só abre
  a pasta; a varredura continua nos botões **Escanear**, **Resscanear** e em Varredura ▸ Analisar unidade.
- Destaque da barra lateral segue a pasta atual (não mais a raiz varrida).
- Combo **Ordenar por** mostra a ordenação real; árvore da **Visão geral** passa a respeitar a ordenação
  ativa, com cabeçalhos Nome/Tamanho clicáveis.
- Empacotamento com `electron-builder` (instalador NSIS + portátil).

### 1.0.0

- Versão inicial do MVP (varredura com pool de workers, árvore, ordenação, filtros, gráficos, exportação,
  impressão, monitoramento, bandeja, i18n pt/en/es/fr).

## Arquitetura

```
assets/                arte do produto (ícone .ico/.png e splash.jpg)
electron/
  main.ts              processo principal: janela, splash, IPC, orquestra o pool de workers
  preload.ts           contextBridge -> window.driversize
  types.ts             tipos compartilhados
  scanner/worker.ts    worker_threads: varredura recursiva de uma subárvore
  dupes/worker.ts      worker_threads: hash em duas fases (duplicados)
src/                   app Angular (standalone)
  app/app.ts|html|css  UI (barra de título, barra lateral, tabela, gráficos, status)
  app/scan.service.ts  recebe os lotes, agrega tamanhos, expõe signals
  app/models.ts        tipos do renderer
```

### Como o tamanho é calculado

- `scanner/worker.ts` faz a enumeração recursiva e soma `st.size` dos arquivos
  usando o tamanho real de 64 bits.
- `allocated` (tamanho em disco) = `ceil(size / clusterSize) * clusterSize`, com
  `clusterSize` obtido de `fs.statfsSync()` (equivalente ao `GetDiskFreeSpaceW` do Windows).
- A agregação por pasta é feita no renderer (`scan.service.ts`), subindo a árvore a cada arquivo.
- Junction/symlink (reparse points) são ignorados para evitar ciclos.

### Notas de implementação

- A raiz de volume sempre percorre a árvore, em vez de usar o atalho “total − livre”
  (mais preciso para “tamanho de arquivos”).
- Memoização persistente/cache entre varreduras é item de “paridade total” (não incluído no MVP).
- Sem filtros, relatórios (Largest/Oldest/Newest/Empty), gráficos e múltiplos locais (próximos passos).
