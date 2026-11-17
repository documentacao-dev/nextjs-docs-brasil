"""Funções comuns às ferramentas de tradução da documentação do Next.js.

- slug de título igual ao do nextjs.org (github-slugger 2.0.0; a expressão de caracteres
  removidos vem de github-slugger-regex.txt, cópia de github-slugger/regex.js, MIT);
- títulos # de um .mdx, com o contexto de router (<AppOnly>, <PagesOnly> ou os dois);
- páginas, marcador de tradução e leitura do inglês no commit de ultimo-sync-upstream.txt.

O nextjs.org remove o bloco do outro router ANTES de gerar os ids (confirmado em
/docs/app/guides/lazy-loading e /docs/pages/guides/lazy-loading: `## Examples` dentro de
<AppOnly> e de <PagesOnly> vira `#examples` nas duas). Por isso os slugs são contados
separadamente para o App Router e para o Pages Router.
"""
import html
import os
import re
import subprocess
from pathlib import Path

AQUI = Path(__file__).resolve().parent
GIT_ROOT = AQUI.parents[1]
ROOT = Path(os.environ.get('VERIFICAR_RAIZ') or GIT_ROOT)
DOCS = ROOT / 'docs'
MARCADOR = '{/* ia-translate: true */}'

_REGEX = re.compile((AQUI / 'github-slugger-regex.txt').read_text().strip().replace(r'\/', '/'))
SUFIXO = re.compile(r'\s*\\?\{#([A-Za-z0-9_.:-]+)\}\s*$')
CERCA = re.compile(r'^\s*(`{3,}|~{3,})')


# ------------------------------------------------------------------ páginas

def paginas():
    yield from sorted(DOCS.rglob('*.mdx'))


def traduzido(texto):
    linhas = [l for l in texto.splitlines() if l.strip()]
    return bool(linhas) and linhas[-1].strip() == MARCADOR


def commit_upstream():
    return (AQUI / 'ultimo-sync-upstream.txt').read_text().strip()


def rel(p):
    return Path(p).resolve().relative_to(ROOT).as_posix()


def ingles(p, commit):
    r = subprocess.run(['git', '-C', str(GIT_ROOT), 'show', f'{commit}:{rel(p)}'],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def separar_frontmatter(t):
    m = re.match(r'---\n(.*?)\n---\n?', t, re.S)
    return (m.group(1), t[m.end():]) if m else ('', t)


def rota(p):
    """docs/01-app/01-getting-started/01-installation.mdx -> app/getting-started/installation"""
    partes = [re.sub(r'^\d+-', '', x.removesuffix('.mdx')) for x in Path(p).resolve().relative_to(DOCS).parts]
    if partes and partes[-1] == 'index':
        partes.pop()
    return '/'.join(partes)


def routers_da_pagina(p):
    """Routers em que o conteúdo deste arquivo é renderizado: o dele e, se alguma página do
    Pages Router aponta para ele com `source:`, também 'pages'."""
    r = rota(p)
    out = {'pages'} if r.startswith('pages') else {'app'}
    if not r.startswith('pages'):
        for q in DOCS.glob('02-pages/**/*.mdx'):
            fm, _ = separar_frontmatter(q.read_text())
            m = re.search(r'^source:\s*(\S+)', fm, re.M)
            if m and m.group(1).strip('/') == r:
                out.add('pages')
                break
    return out


# ------------------------------------------------------------------ slug (github-slugger)

def _utf16(s):
    b = s.encode('utf-16-le', 'surrogatepass')
    return ''.join(chr(int.from_bytes(b[i:i + 2], 'little')) for i in range(0, len(b), 2))


def _de_utf16(s):
    b = b''.join(ord(c).to_bytes(2, 'little') for c in s)
    return b.decode('utf-16-le', 'surrogatepass')


def slug(texto):
    t = _utf16(texto.lower())
    t = _REGEX.sub('', t).replace(' ', '-')
    return _de_utf16(t)


class GithubSlugger:
    def __init__(self):
        self.ocorrencias = {}

    def slug(self, texto):
        original = resultado = slug(texto)
        while resultado in self.ocorrencias:
            self.ocorrencias[original] += 1
            resultado = f'{original}-{self.ocorrencias[original]}'
        self.ocorrencias[resultado] = 0
        return resultado


def _sem_marcacao(t):
    t = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', t)                       # imagens: sem texto
    t = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', t)                   # links: só o texto
    t = re.sub(r'<[A-Za-z][^>]*/>|</?[A-Za-z][^>]*>', '', t)         # tags e componentes inline
    t = re.sub(r'\\([!-/:-@\[-`{-~])', lambda m: '\x00%d\x00' % ord(m.group(1)), t)  # escapes
    t = re.sub(r'(\*\*|__|\*|(?<!\w)_|_(?!\w)|~~)', '', t)           # ênfase
    t = re.sub('\x00(\\d+)\x00', lambda m: chr(int(m.group(1))), t)
    return html.unescape(t)


def texto_do_titulo(md):
    """Texto puro de um título markdown (como o hast `toString`)."""
    t = SUFIXO.sub('', md).strip()
    partes, pos = [], 0
    for m in re.finditer(r'(`+)(.+?)\1', t):
        partes.append(_sem_marcacao(t[pos:m.start()]))
        c = m.group(2)
        partes.append(c.strip(' ') if c.strip() else c)
        pos = m.end()
    partes.append(_sem_marcacao(t[pos:]))
    return ''.join(partes)


# ------------------------------------------------------------------ títulos

def titulos(texto):
    """[(nível, linha_index, texto_bruto, contexto)] dos títulos # fora de blocos cercados.
    contexto: 'app' (dentro de <AppOnly>), 'pages' (dentro de <PagesOnly>) ou 'ambos'."""
    out, cerca, contexto = [], None, 'ambos'
    # comentários {/* ... */} viram linhas em branco (mantém os índices de linha)
    texto = re.sub(r'\{/\*.*?\*/\}', lambda m: '\n' * m.group(0).count('\n'), texto, flags=re.S)
    linhas = texto.split('\n')
    if linhas and linhas[0] == '---':  # frontmatter
        for j in range(1, len(linhas)):
            if linhas[j] == '---':
                linhas = [''] * (j + 1) + linhas[j + 1:]
                break
    for i, linha in enumerate(linhas):
        m = CERCA.match(linha)
        if cerca is None:
            if m:
                cerca = m.group(1)
                continue
            sem_codigo = re.sub(r'`[^`]*`', '', linha)
            for tag in re.finditer(r'<(/?)(AppOnly|PagesOnly)\s*>', sem_codigo):
                if tag.group(1):
                    contexto = 'ambos'
                else:
                    contexto = 'app' if tag.group(2) == 'AppOnly' else 'pages'
            h = re.match(r'^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$', linha)
            if h:
                out.append((len(h.group(1)), i, h.group(2), contexto))
        elif m and m.group(1)[0] == cerca[0] and len(m.group(1)) >= len(cerca) and linha.strip() == m.group(1):
            cerca = None
    return out


def slugs_do_ingles(texto, routers):
    """Para cada título do inglês, {router: slug} nos routers em que ele aparece."""
    ts = titulos(texto)
    out = [dict() for _ in ts]
    for router in ('app', 'pages'):
        if router not in routers:
            continue
        s = GithubSlugger()
        for k, (_, _, bruto, ctx) in enumerate(ts):
            if ctx in ('ambos', router):
                out[k][router] = s.slug(texto_do_titulo(bruto))
    return out


def id_esperado(slugs, routers):
    """O id gravado no título traduzido: o do router principal da página (app se ela aparece
    no App Router), ou o único router em que o título aparece."""
    for r in ('app', 'pages'):
        if r in routers and r in slugs:
            return slugs[r]
    return next(iter(slugs.values()), None)
