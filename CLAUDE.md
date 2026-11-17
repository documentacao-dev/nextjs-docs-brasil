# CLAUDE.md

Tradução PT-BR da documentação do **Next.js**, fork de `vercel/next.js` (branch `canary`, só `docs/`), parte da org [`documentacao-dev`](https://github.com/documentacao-dev). Original: https://nextjs.org/docs. Publicado em https://nextjs.documentacao.dev (site Firebase `nextjs-documentacao`, projeto `transliteradu`). Licença: MIT (a do upstream), com atribuição à Vercel e link para a página original no rodapé de cada página.

O `AGENTS.md` da raiz é do upstream (desenvolvimento do framework Next.js) e **não vale aqui**: neste fork só se traduz a documentação e se mantém o site.

- Conteúdo traduzível: `docs/**/*.mdx` (480 arquivos), traduzido no lugar. Pastas numeradas viram URLs sem número: `docs/01-app/01-getting-started/01-installation.mdx` -> `/docs/app/getting-started/installation`.
- Páginas do Pages Router com `source: app/...` no frontmatter reaproveitam o corpo da página do App Router. Nelas só se traduz o frontmatter; o corpo (o comentário "DO NOT EDIT") fica igual.
- O clone é parcial (`--filter=blob:none`) com sparse checkout (`docs`, `.github`, `tool`, `.claude/agents`). **Não dê checkout do repositório inteiro.** Arquivos novos fora disso entram com `git add --sparse`; para uma pasta nova, `git sparse-checkout add <pasta>`.
- Comandos `gh` sempre com `-R documentacao-dev/nextjs-docs-brasil`. Nunca abra PR, issue ou nada no `vercel/next.js`.
- Sync: merge de `upstream/canary`, retradução só do que mudou em `docs/`, atualização de `tool/traducao/ultimo-sync-upstream.txt` com o sha do upstream. Os workflows do upstream estão desligados no fork (via API); se o merge trouxer workflow novo, desligue também.

## Modelo da tradução: sempre Haiku

Toda tradução e retradução de página roda no **Haiku** (`model: haiku`), local ou na nuvem. O agente `.claude/agents/traduzir-pt-br.md` já declara isso; não troque. Orquestrador que dispara subagentes passa `model: "haiku"`. O modelo principal só orquestra (merge, scripts, commits). Revisão de tradução: subagente de contexto limpo que lê 100% lado a lado e declara `COBERTURA`; lote grande num revisor só vira amostragem.

## Site

Gerador próprio em `tool/site/` (o site do nextjs.org não é open source):

- `tool/site/build.sh` (ou `npm run build` em `tool/site/`) gera `site/` (gitignored) em ~25 s: `build.mjs` compila cada .mdx com `@mdx-js/mdx` + `remark-gfm`, renderiza com React no servidor e escreve um `.html` por página; depois o Pagefind indexa a busca (em pt-BR, local, sem serviço externo). Servir local: `npx serve@14 site` (faz cleanUrls como o Firebase).
- URLs iguais às do nextjs.org, então os links internos `/docs/...` funcionam sem reescrita. Link para página que não existe aqui (`/docs/messages/...`, `/learn`, `/blog`) vai para `https://nextjs.org/...`.
- Barra lateral na ordem dos prefixos numéricos (sem prefixo: ordem alfabética), título `nav_title` > `title` do frontmatter: **traduzir o frontmatter traduz o menu**.
- `<AppOnly>`/`<PagesOnly>`: o bloco do outro router é removido antes de gerar os ids (como o nextjs.org). Seletor App Router/Pages Router na barra lateral.
- Código: Shiki (github-light/dark); `switcher` junta o par TS/JS em abas, `package="npm"` etc. viram abas npm/pnpm/yarn/bun (preferência salva no navegador), `filename`, `highlight={...}`.
- Imagens e vídeos (`<Image srcLight srcDark>`, `<Video>`) apontam para o blob da Vercel (`https://h8DxKfmAPhn8O0p3.public.blob.vercel-storage.com`), o mesmo host que o nextjs.org usa.
- Componentes suportados: AppOnly, PagesOnly, Image, Video, Check, Cross, FixCardGrid, FixCard, e HTML `<details>`/`<summary>`. Componente novo no upstream quebra o build ("Expected component `X` to be defined"): implemente em `COMPONENTES` no `build.mjs`.
- Deploy: `.github/workflows/deploy-firebase.yml` roda `verificar.py`, o `build.sh` e publica no push para `canary` que toque `docs/`, `tool/` ou `firebase.json`.

## Convenções das páginas (MDX)

- **Marcador de página traduzida:** a **última linha** do .mdx é `{/* ia-translate: true */}`. Sem ele, a página mostra a faixa "Esta página ainda está em inglês". Página do Pages Router com `source:` herda o estado da página de origem.
- Frontmatter: traduza `title`, `description`, `nav_title` e, dentro de `related`, `title` e `description`. `source`, `version`, `related.links` ficam idênticos. Texto com `: ` precisa de aspas (YAML).
- Blocos de código (inclusive comentários e saídas, e a linha de abertura com `filename=`, `switcher`, `package=`), comentários `{/* */}`, tags e props de componentes JSX, URLs de links e código inline ficam idênticos ao inglês. Em `<Image>`, `<Video>`, `<FixCard>` e `<details>` só o texto de `alt`, `caption`, `title` e `summary` pode mudar.
- `> **Good to know:**` vira `> **Bom saber:**`.
- **Âncoras:** o título traduzido carrega o id do original no fim: `## Início rápido \{#quick-start}` (a barra é obrigatória: `{#id}` solto é expressão no MDX e quebra o build). **O tradutor não escreve o id**: depois de traduzir, rode `python3 tool/traducao/ancorar_titulos.py <arquivos>`. Ele calcula o slug do inglês como o nextjs.org (github-slugger, com -1, -2 para repetidos, contando App Router e Pages Router em separado; conferido contra as 480 páginas do build e contra o nextjs.org) e grava nos títulos na mesma ordem.
- `python3 tool/traducao/verificar.py [arquivos]` confere cada página com marcador contra o inglês do commit em `tool/traducao/ultimo-sync-upstream.txt` (via `git show`) e falha o deploy se houver `ERRO`. `AVISO` não bloqueia.

## Política de termos

Ficam em inglês: Server Components, Client Components, Server Actions, Server Functions, App Router, Pages Router, route handler, middleware, proxy, layout, cache, caching, prerendering, streaming, hydration, build, deploy, runtime, Edge Runtime, bundle, bundler, Turbopack, webpack, Cache Components, Partial Prerendering (PPR), Static/Dynamic Rendering quando nome de recurso, Suspense, props, hook, dev server, CLI, codemod, framework, plugin, script, commit, branch.

- **"app" nunca vira "aplicativo"**: é sempre "app" ("crie um app Next.js"). O diretório `app` e `pages` são código.
- getting started = Primeiros passos, learn more = Saiba mais, see also = Veja também, next steps = Próximos passos, good to know = Bom saber, API reference = Referência da API.
- Títulos em sentence case (só a primeira palavra e nomes próprios em maiúscula). "Você", tom direto. Evite "certifique-se", "você pode querer", "suportar" (support) e travessão onde o português usaria vírgula.

## Sem rastreamento

O site não carrega nada de terceiros além das imagens/vídeos do blob da Vercel: sem analytics, sem fonte externa, sem CDN de script. A busca é Pagefind local. Preferências (tema, router, abas) ficam no `localStorage`. Não reintroduza.
