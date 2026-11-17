#!/usr/bin/env node
// Gera o site estático da tradução PT-BR da documentação do Next.js em site/.
//
// Lê docs/**/*.mdx, monta as mesmas URLs do nextjs.org (/docs/app/..., /docs/pages/...),
// resolve `source:` (páginas do Pages Router que reaproveitam o conteúdo de uma página do
// App Router), compila o MDX com componentes próprios (AppOnly, PagesOnly, Image, Check,
// Cross, FixCard...), realça o código com Shiki e escreve um .html por página.
// A busca (Pagefind) roda depois, no `npm run build`.
//
// Uso: node tool/site/build.mjs   (SAIDA=pasta para mudar o destino; padrão site/)

import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '@mdx-js/mdx';
import * as runtime from 'react/jsx-runtime';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import GithubSlugger from 'github-slugger';
import { createHighlighter } from 'shiki';
import { visit, SKIP } from 'unist-util-visit';
import { toString as hastToString } from 'hast-util-to-string';
import * as yaml from 'js-yaml';

const h = React.createElement;
const AQUI = import.meta.dirname;
const RAIZ = path.resolve(AQUI, '../..');
const DOCS = path.join(RAIZ, 'docs');
const SAIDA = path.resolve(process.env.SAIDA || path.join(RAIZ, 'site'));
const MARCADOR = '{/* ia-translate: true */}';
const ORIGEM = 'https://nextjs.org';
const IMAGENS = 'https://h8DxKfmAPhn8O0p3.public.blob.vercel-storage.com';
const REPO = 'https://github.com/documentacao-dev/nextjs-docs-brasil';
const DOMINIO = 'https://nextjs.documentacao.dev';
const SUFIXO_ID = /\s*\{#([A-Za-z0-9_.:-]+)\}\s*$/;

const inicio = Date.now();

// ---------------------------------------------------------------- páginas

function arquivosMdx(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...arquivosMdx(p));
    else if (e.name.endsWith('.mdx')) out.push(p);
  }
  return out;
}

const semPrefixo = (s) => s.replace(/\.mdx$/, '').replace(/^\d+-/, '');

function separarFrontmatter(texto) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(texto);
  if (!m) return [{}, texto];
  return [yaml.load(m[1]) || {}, texto.slice(m[0].length)];
}

function traduzido(texto) {
  const linhas = texto.split('\n').filter((l) => l.trim());
  return linhas.length > 0 && linhas.at(-1).trim() === MARCADOR;
}

const paginas = new Map(); // rota -> página
for (const arquivo of arquivosMdx(DOCS)) {
  const rel = path.relative(DOCS, arquivo).split(path.sep);
  const segs = rel.map(semPrefixo);
  if (segs.at(-1) === 'index') segs.pop();
  const rota = '/docs' + (segs.length ? '/' + segs.join('/') : '');
  const texto = fs.readFileSync(arquivo, 'utf8');
  const [fm, corpo] = separarFrontmatter(texto);
  paginas.set(rota, {
    rota,
    arquivo,
    rel: 'docs/' + rel.join('/'),
    fm,
    corpo,
    traduzido: traduzido(texto),
    router: rota.startsWith('/docs/pages') ? 'pages' : 'app',
  });
}

// conteúdo: a própria página ou a de `source:`
for (const p of paginas.values()) {
  p.conteudo = p;
  if (p.fm.source) {
    const alvo = paginas.get('/docs/' + String(p.fm.source).replace(/^\/+|\/+$/g, ''));
    if (alvo) p.conteudo = alvo;
    else console.warn(`AVISO ${p.rel}: source "${p.fm.source}" não existe`);
  }
}

const tituloNav = (p) => p.fm.nav_title || p.fm.title || p.rota;

// ---------------------------------------------------------------- árvore (barra lateral)

function chaveOrdem(nome) {
  const m = /^(\d+)-/.exec(nome);
  return [m ? Number(m[1]) : Infinity, semPrefixo(nome)];
}

function arvore(dir) {
  const itens = [];
  const entradas = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || (e.name.endsWith('.mdx') && e.name !== 'index.mdx'))
    .sort((a, b) => {
      const [na, sa] = chaveOrdem(a.name);
      const [nb, sb] = chaveOrdem(b.name);
      return na - nb || sa.localeCompare(sb);
    });
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    const rel = path.relative(DOCS, e.isDirectory() ? path.join(p, 'index.mdx') : p).split(path.sep);
    const segs = rel.map(semPrefixo);
    if (segs.at(-1) === 'index') segs.pop();
    const rota = '/docs/' + segs.join('/');
    const pagina = paginas.get(rota);
    const filhos = e.isDirectory() ? arvore(p) : [];
    if (!pagina && !filhos.length) continue;
    itens.push({ rota: pagina ? rota : null, titulo: pagina ? tituloNav(pagina) : semPrefixo(e.name), filhos });
  }
  return itens;
}

const raizDe = (nome) => fs.readdirSync(DOCS).find((n) => semPrefixo(n) === nome);
const secao = (nome) => {
  const dir = path.join(DOCS, raizDe(nome));
  const rota = '/docs/' + nome;
  return { rota, titulo: tituloNav(paginas.get(rota)), filhos: arvore(dir), secao: true };
};
const ARVORES = {
  app: [secao('app'), secao('architecture'), secao('community')],
  pages: [secao('pages'), secao('architecture'), secao('community')],
};

function achatar(itens, out = []) {
  for (const i of itens) {
    if (i.rota) out.push(i);
    achatar(i.filhos, out);
  }
  return out;
}
const SEQUENCIA = {
  app: [{ rota: '/docs', titulo: tituloNav(paginas.get('/docs')) }, ...achatar(ARVORES.app)],
  pages: [{ rota: '/docs', titulo: tituloNav(paginas.get('/docs')) }, ...achatar(ARVORES.pages)],
};

// ---------------------------------------------------------------- links

function resolverHref(href) {
  if (!href || typeof href !== 'string') return href;
  if (href.startsWith('#') || /^[a-z]+:/i.test(href) || href.startsWith('//')) return href;
  if (!href.startsWith('/')) return href;
  const [semHash, hash = ''] = href.split('#');
  const [caminho, busca = ''] = semHash.split('?');
  const norm = caminho.replace(/\/+$/, '') || '/';
  if (paginas.has(norm)) return norm + (busca ? '?' + busca : '') + (hash ? '#' + hash : '');
  return ORIGEM + href; // /docs/messages, /learn, /blog, páginas que não existem aqui
}

// ---------------------------------------------------------------- MDX: plugins

function parseMeta(meta = '') {
  const out = {};
  const re = /(\w+)(?:=(?:"([^"]*)"|\{([^}]*)\}|(\S+)))?/g;
  let m;
  while ((m = re.exec(meta))) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? true;
  return out;
}

const attr = (name, value) => ({ type: 'mdxJsxAttribute', name, value: String(value) });

// troca cada bloco de código por <Codigo> e agrupa vizinhos com `switcher` ou `package=`
function remarkCodigo() {
  return (tree) => {
    visit(tree, (node) => {
      if (!Array.isArray(node.children)) return;
      const novos = [];
      for (const filho of node.children) {
        if (filho.type !== 'code') {
          novos.push(filho);
          continue;
        }
        const meta = parseMeta(filho.meta || '');
        const el = {
          type: 'mdxJsxFlowElement',
          name: 'Codigo',
          attributes: [attr('lang', filho.lang || 'text'), attr('meta', filho.meta || ''), attr('value', filho.value)],
          children: [],
        };
        const tipo = meta.package ? 'package' : meta.switcher ? 'switcher' : null;
        const anterior = novos.at(-1);
        if (tipo && anterior?.name === 'GrupoCodigo' && anterior.tipo === tipo && (tipo === 'package' || anterior.children.length < 2)) {
          anterior.children.push(el);
        } else if (tipo) {
          novos.push({ type: 'mdxJsxFlowElement', name: 'GrupoCodigo', tipo, attributes: [attr('tipo', tipo)], children: [el] });
        } else {
          novos.push(el);
        }
      }
      node.children = novos;
    });
  };
}

// `## Título traduzido \{#id-em-ingles}`: tira o sufixo do texto e fixa o id
function remarkIdTitulo() {
  return (tree) => {
    visit(tree, 'heading', (node) => {
      const ultimo = node.children.at(-1);
      if (ultimo?.type !== 'text') return;
      const m = SUFIXO_ID.exec(ultimo.value);
      if (!m) return;
      ultimo.value = ultimo.value.slice(0, m.index);
      if (ultimo.value === '') node.children.pop();
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: m[1] } };
    });
  };
}

// remove o bloco do outro router (AppOnly/PagesOnly) antes de gerar os ids, como o nextjs.org
function remarkRouter({ router }) {
  const fora = router === 'app' ? 'PagesOnly' : 'AppOnly';
  return (tree) => {
    visit(tree, (node, i, pai) => {
      if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === fora && pai) {
        pai.children.splice(i, 1);
        return [SKIP, i];
      }
    });
  };
}

// ids dos títulos com github-slugger (o mesmo do nextjs.org), respeitando ids explícitos
function rehypeIds() {
  return (tree) => {
    const slugger = new GithubSlugger();
    visit(tree, 'element', (node) => {
      if (!/^h[1-6]$/.test(node.tagName)) return;
      if (node.properties.id) slugger.occurrences[node.properties.id] = 0;
      else node.properties.id = slugger.slug(hastToString(node));
    });
  };
}

// ---------------------------------------------------------------- componentes

const LINGUAGENS = ['tsx', 'jsx', 'ts', 'js', 'bash', 'json', 'html', 'css', 'go', 'yaml', 'mdx', 'md', 'diff', 'xml', 'scss', 'nginx', 'shellscript', 'typescript', 'javascript'];
const APELIDO = { txt: 'text', plain: 'text', prompt: 'text', sh: 'bash', text: 'text' };
const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: LINGUAGENS });

function faixas(spec) {
  const out = new Set();
  for (const parte of String(spec || '').split(',')) {
    const [a, b] = parte.split('-').map((n) => parseInt(n, 10));
    if (Number.isNaN(a)) continue;
    for (let n = a; n <= (Number.isNaN(b) || b === undefined ? a : b); n++) out.add(n);
  }
  return out;
}

const ROTULO_LINGUAGEM = { tsx: 'TypeScript', ts: 'TypeScript', typescript: 'TypeScript', jsx: 'JavaScript', js: 'JavaScript', javascript: 'JavaScript' };

function Codigo({ lang, meta, value }) {
  const m = parseMeta(meta);
  const linguagem = APELIDO[lang] || (LINGUAGENS.includes(lang) ? lang : 'text');
  const destaque = faixas(m.highlight);
  const html = highlighter.codeToHtml(value.replace(/\n$/, ''), {
    lang: linguagem,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
    transformers: [
      {
        line(no, linha) {
          if (destaque.has(linha)) this.addClassToHast(no, 'destacada');
        },
      },
    ],
  });
  const cabecalho = m.filename
    ? h('div', { className: 'codigo-cab' }, h('span', { className: 'arquivo' }, m.filename))
    : null;
  return h(
    'div',
    { className: 'codigo' + (m.filename ? ' com-cab' : ''), 'data-lang': lang },
    cabecalho,
    h('button', { className: 'copiar', type: 'button', 'aria-label': 'Copiar código', title: 'Copiar' }, 'Copiar'),
    h('div', { dangerouslySetInnerHTML: { __html: html } }),
  );
}

function GrupoCodigo({ tipo, children }) {
  const filhos = React.Children.toArray(children).filter(React.isValidElement);
  const valores = filhos.map((f) => {
    const meta = parseMeta(f.props.meta);
    return tipo === 'package' ? meta.package : ROTULO_LINGUAGEM[f.props.lang] || f.props.lang;
  });
  if (filhos.length < 2) return h(React.Fragment, null, ...filhos);
  const chave = tipo === 'package' ? 'pm' : 'linguagem';
  return h(
    'div',
    { className: 'grupo', 'data-grupo': chave },
    h(
      'div',
      { className: 'abas', role: 'tablist' },
      ...valores.map((v, i) =>
        h('button', { key: v, type: 'button', role: 'tab', className: 'aba', 'data-valor': v, 'aria-selected': i === 0 ? 'true' : 'false' }, v),
      ),
    ),
    ...filhos.map((f, i) => h('div', { key: i, className: 'painel', 'data-valor': valores[i], hidden: i === 0 ? undefined : true }, f)),
  );
}

const urlImagem = (src) => (!src ? src : /^https?:/.test(src) ? src : IMAGENS + src);

function Imagem({ alt = '', srcLight, srcDark, src, width, height }) {
  if (srcLight || srcDark) {
    return h(
      'span',
      { className: 'imagem' },
      h('img', { className: 'so-claro', src: urlImagem(srcLight || srcDark), alt, width, height, loading: 'lazy', decoding: 'async' }),
      h('img', { className: 'so-escuro', src: urlImagem(srcDark || srcLight), alt, width, height, loading: 'lazy', decoding: 'async' }),
    );
  }
  return h('span', { className: 'imagem' }, h('img', { src: urlImagem(src), alt, width, height, loading: 'lazy', decoding: 'async' }));
}

function Video({ src, caption, width, height }) {
  return h(
    'figure',
    { className: 'video' },
    h('video', { src: urlImagem(src), controls: true, preload: 'metadata', playsInline: true, width, height }),
    caption ? h('figcaption', null, caption) : null,
  );
}

const icone = (d, cls, label) => ({ size = 18 }) =>
  h('svg', { className: cls, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round', role: 'img', 'aria-label': label }, h('path', { d }));
const Check = icone('M20 6 9 17l-5-5', 'icone-check', 'Sim');
const Cross = icone('M18 6 6 18M6 6l12 12', 'icone-cross', 'Não');

const ROTULO_FIX = { stream: 'Streaming', dynamic: 'Dinâmico', cache: 'Cache', static: 'Estático' };
function FixCardGrid({ children }) {
  return h('div', { className: 'fix-grade' }, children);
}
function FixCard({ group, title, href, snippets = [] }) {
  return h(
    'a',
    { className: 'fix-card', href: resolverHref(href), 'data-grupo': group },
    group ? h('span', { className: 'fix-grupo' }, ROTULO_FIX[group] || group) : null,
    h('strong', null, title),
    snippets.length
      ? h('pre', { className: 'fix-codigo' }, ...snippets.map((s, i) => h('span', { key: i, className: s.highlight ? 'destacada' : undefined }, s.text + '\n')))
      : null,
  );
}

function titulo(tag) {
  return ({ id, children, ...props }) =>
    h(tag, { id, ...props }, id ? h('a', { className: 'ancora', href: '#' + id }, children) : children);
}

const passa = ({ children }) => h(React.Fragment, null, children);

const COMPONENTES = {
  Codigo,
  GrupoCodigo,
  Image: Imagem,
  Video,
  Check,
  Cross,
  FixCard,
  FixCardGrid,
  AppOnly: passa,
  PagesOnly: passa,
  a: ({ href, children, ...props }) => {
    const r = resolverHref(href);
    const externo = /^https?:/.test(r || '');
    return h('a', { href: r, ...props, ...(externo ? { rel: 'noopener' } : {}) }, children);
  },
  h2: titulo('h2'),
  h3: titulo('h3'),
  h4: titulo('h4'),
  table: (props) => h('div', { className: 'tabela' }, h('table', props)),
};

// ---------------------------------------------------------------- render de uma página

const compilados = new Map();
async function compilar(pagina, router) {
  const chave = pagina.rota + '|' + router;
  if (compilados.has(chave)) return compilados.get(chave);
  const { default: Conteudo } = await evaluate(pagina.corpo, {
    ...runtime,
    development: false,
    remarkPlugins: [remarkGfm, [remarkRouter, { router }], remarkIdTitulo, remarkCodigo],
    rehypePlugins: [rehypeIds],
  });
  compilados.set(chave, Conteudo);
  return Conteudo;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// `código` inline em títulos e descrições do frontmatter
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

function contem(item, rota) {
  return item.rota === rota || item.filhos.some((f) => contem(f, rota));
}

function htmlArvore(itens, rota, nivel = 0) {
  let out = '<ul>';
  for (const i of itens) {
    const atual = i.rota === rota;
    const link = i.rota
      ? `<a href="${i.rota}"${atual ? ' aria-current="page"' : ''}>${inline(i.titulo)}</a>`
      : `<span>${inline(i.titulo)}</span>`;
    if (i.filhos.length) {
      const aberto = i.secao || contem(i, rota);
      out += `<li class="pasta${i.secao ? ' secao' : ''}"><details${aberto ? ' open' : ''}><summary>${link}</summary>${htmlArvore(i.filhos, rota, nivel + 1)}</details></li>`;
    } else {
      out += `<li>${link}</li>`;
    }
  }
  return out + '</ul>';
}

function htmlLateral(pagina) {
  const compartilhada = !pagina.rota.startsWith('/docs/app') && !pagina.rota.startsWith('/docs/pages');
  const arv = (router) =>
    `<nav class="arvore" data-router="${router}" aria-label="Documentação">${htmlArvore(ARVORES[router], pagina.rota)}</nav>`;
  const seletor = `<label class="seletor"><span>Usando</span><select data-seletor-router>
<option value="app"${pagina.router === 'app' ? ' selected' : ''}>App Router</option>
<option value="pages"${pagina.router === 'pages' ? ' selected' : ''}>Pages Router</option></select></label>`;
  const destinos = {
    app: pagina.rota.startsWith('/docs/pages') ? equivalente(pagina.rota, 'app') : '/docs/app',
    pages: pagina.rota.startsWith('/docs/app') ? equivalente(pagina.rota, 'pages') : '/docs/pages',
  };
  return `<aside class="lateral" id="lateral" data-compartilhada="${compartilhada}" data-destino-app="${destinos.app}" data-destino-pages="${destinos.pages}">
${seletor}
${compartilhada ? arv('app') + arv('pages') : arv(pagina.router)}
</aside>`;
}

function equivalente(rota, router) {
  const outra = rota.replace(/^\/docs\/(app|pages)/, '/docs/' + router);
  return paginas.has(outra) ? outra : '/docs/' + router;
}

function htmlToc(conteudoHtml) {
  const itens = [];
  const re = /<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
  let m;
  while ((m = re.exec(conteudoHtml))) {
    itens.push(`<li class="n${m[1]}"><a href="#${m[2]}">${m[3].replace(/<[^>]+>/g, '')}</a></li>`);
  }
  if (!itens.length) return '<aside class="toc"></aside>';
  return `<aside class="toc"><nav aria-label="Nesta página"><p class="toc-titulo">Nesta página</p><ul>${itens.join('')}</ul></nav></aside>`;
}

function htmlRelacionados(pagina) {
  const rel = pagina.fm.related;
  if (!rel?.links?.length) return '';
  const cards = rel.links
    .map((l) => {
      const alvo = paginas.get('/docs/' + String(l).replace(/^\/+|\/+$/g, ''));
      if (!alvo) return '';
      return `<a class="card" href="${alvo.rota}"><strong>${inline(alvo.fm.title)}</strong><span>${inline(alvo.fm.description || '')}</span></a>`;
    })
    .join('');
  return `<section class="relacionados"><h2 id="${new GithubSlugger().slug(String(rel.title || 'next-steps'))}">${inline(rel.title || 'Próximos passos')}</h2>${rel.description ? `<p>${inline(rel.description)}</p>` : ''}<div class="cards">${cards}</div></section>`;
}

function htmlAnteriorProxima(pagina) {
  const seq = SEQUENCIA[pagina.router];
  const i = seq.findIndex((x) => x.rota === pagina.rota);
  if (i < 0) return '';
  const ant = seq[i - 1];
  const prox = seq[i + 1];
  const link = (x, cls, rotulo) =>
    x ? `<a class="${cls}" href="${x.rota}"><span>${rotulo}</span><strong>${inline(x.titulo)}</strong></a>` : '<span></span>';
  return `<nav class="paginacao" aria-label="Paginação">${link(ant, 'anterior', 'Anterior')}${link(prox, 'proxima', 'Próxima')}</nav>`;
}

const SELO_VERSAO = { experimental: 'Experimental', legacy: 'Legado', canary: 'Canary', draft: 'Rascunho', unstable: 'Instável' };

const SCRIPT_TEMA = `<script>try{var t=localStorage.getItem('tema');if(t==='escuro'||(t!=='claro'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('escuro');var r=localStorage.getItem('router');if(r)document.documentElement.dataset.router=r;}catch(e){}</script>`;

function layout({ titulo, descricao, rota, lateral, corpo, toc, extraHead = '' }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descricao)}">
${rota ? `<link rel="canonical" href="${DOMINIO}${rota}">\n<link rel="alternate" hreflang="en" href="${ORIGEM}${rota}">` : ''}
<link rel="icon" href="/assets/icone.svg" type="image/svg+xml">
${SCRIPT_TEMA}
<link rel="stylesheet" href="/assets/site.css">
${extraHead}
</head>
<body>
<a class="pular" href="#conteudo">Pular para o conteúdo</a>
<header class="topo">
  <button class="botao-menu" type="button" aria-label="Abrir menu" aria-controls="lateral" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
  <a class="marca" href="/docs">Documentação do Next.js</a>
  <span class="selo-idioma">PT-BR</span>
  <button class="botao-busca" type="button" data-abrir-busca><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Buscar na documentação…</span><kbd>Ctrl K</kbd></button>
  <nav class="links-topo">
    <a href="https://documentacao.dev">documentacao.dev</a>
    <a href="${REPO}" aria-label="GitHub do projeto">GitHub</a>
    <button class="botao-tema" type="button" aria-label="Alternar tema claro/escuro" data-tema><svg class="sol" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><svg class="lua" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
  </nav>
</header>
<div class="layout">
${lateral}
<main id="conteudo" class="conteudo">
${corpo}
</main>
${toc}
</div>
<dialog class="busca" id="busca" aria-label="Buscar"><div class="busca-caixa"><div id="busca-ui"></div><button class="busca-fechar" type="button" data-fechar-busca>Esc</button></div></dialog>
<script src="/assets/site.js" defer></script>
</body>
</html>
`;
}

function htmlRodape(pagina) {
  const original = ORIGEM + pagina.rota;
  const fonte = pagina.conteudo.rel;
  return `<footer class="rodape">
<p>Tradução para o português feita por IA a partir de <a href="${original}" rel="noopener">${original.replace('https://', '')}</a>. Pode conter erros; na dúvida, confira o original.</p>
<p>Conteúdo original © Vercel, Inc., publicado sob a <a href="https://github.com/vercel/next.js/blob/canary/license.md" rel="noopener">licença MIT</a>. Next.js é marca da Vercel; este site não é oficial nem afiliado à Vercel.</p>
<p>Código-fonte da tradução: <a href="${REPO}">documentacao-dev/nextjs-docs-brasil</a> · <a href="${REPO}/edit/canary/${fonte}">Editar esta página</a> · Parte do <a href="https://documentacao.dev">documentacao.dev</a></p>
</footer>`;
}

async function renderizar(pagina) {
  const Conteudo = await compilar(pagina.conteudo, pagina.router);
  const conteudoHtml = renderToStaticMarkup(h(Conteudo, { components: COMPONENTES }));
  const fm = pagina.fm;
  const emIngles = !pagina.conteudo.traduzido;
  const aviso = emIngles
    ? `<div class="aviso-ingles" role="note"><strong>Esta página ainda está em inglês.</strong> A tradução ainda não foi feita; o conteúdo abaixo é o original de <a href="${ORIGEM}${pagina.rota}" rel="noopener">nextjs.org</a>.</div>`
    : '';
  const selo = fm.version && SELO_VERSAO[fm.version] ? `<span class="selo selo-${esc(fm.version)}">${SELO_VERSAO[fm.version]}</span>` : '';
  const corpo = `${aviso}
<article data-pagefind-body${emIngles ? ' data-pagefind-meta="idioma:en"' : ''}>
<h1 data-pagefind-meta="title">${inline(fm.title)}${selo}</h1>
${conteudoHtml}
${htmlRelacionados(pagina)}
</article>
${htmlAnteriorProxima(pagina)}
${htmlRodape(pagina)}`;
  return layout({
    titulo: `${String(fm.title).replace(/`/g, '')} | Documentação do Next.js`,
    descricao: String(fm.description || '').replace(/`/g, ''),
    rota: pagina.rota,
    lateral: htmlLateral(pagina),
    corpo,
    toc: htmlToc(conteudoHtml),
  });
}

// ---------------------------------------------------------------- escrita

fs.rmSync(SAIDA, { recursive: true, force: true });
fs.mkdirSync(SAIDA, { recursive: true });
fs.cpSync(path.join(AQUI, 'assets'), path.join(SAIDA, 'assets'), { recursive: true });

let erros = 0;
let traduzidas = 0;
const lista = [...paginas.values()];
const LOTE = 16;
for (let i = 0; i < lista.length; i += LOTE) {
  await Promise.all(
    lista.slice(i, i + LOTE).map(async (p) => {
      try {
        const html = await renderizar(p);
        const destino = path.join(SAIDA, p.rota + '.html');
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        fs.writeFileSync(destino, html);
        if (p.conteudo.traduzido) traduzidas++;
      } catch (e) {
        erros++;
        console.error(`ERRO ${p.rel}: ${e.message}`);
      }
    }),
  );
}

fs.writeFileSync(
  path.join(SAIDA, 'index.html'),
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/docs"><link rel="canonical" href="${DOMINIO}/docs"><title>Documentação do Next.js</title></head><body><a href="/docs">Documentação do Next.js</a></body></html>\n`,
);
fs.writeFileSync(
  path.join(SAIDA, '404.html'),
  layout({
    titulo: 'Página não encontrada | Documentação do Next.js',
    descricao: 'Página não encontrada',
    rota: null,
    lateral: htmlLateral({ rota: '/404', router: 'app' }),
    corpo: `<article><h1>Página não encontrada</h1><p>Esta página não existe na tradução. Tente a <a href="/docs">página inicial</a>, a busca, ou o original em <a href="${ORIGEM}/docs">nextjs.org/docs</a>.</p></article>`,
    toc: '<aside class="toc"></aside>',
  }),
);

const seg = ((Date.now() - inicio) / 1000).toFixed(1);
console.log(`${paginas.size} páginas (${traduzidas} traduzidas) em ${seg}s -> ${path.relative(RAIZ, SAIDA)}/` + (erros ? `, ${erros} erro(s)` : ''));
if (erros) process.exit(1);
