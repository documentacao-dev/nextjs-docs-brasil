#!/usr/bin/env python3
"""Confere as páginas traduzidas da documentação do Next.js contra o inglês.

Para cada docs/**/*.mdx cuja ÚLTIMA linha é `{/* ia-translate: true */}`, compara com o
inglês do commit em tool/traducao/ultimo-sync-upstream.txt (`git show`):

- frontmatter: YAML válido, mesmas chaves; só title, description, nav_title e
  related.title/related.description podem mudar (source, version, related.links idênticos);
- blocos de código cercados idênticos e na mesma ordem (inclui a meta: filename, switcher...);
- linhas de import idênticas;
- tags JSX de componentes (<AppOnly>, <Image .../>, <FixCard .../>...) idênticas e na mesma
  ordem, exceto o texto dos atributos alt, caption, title e summary;
- <details>/<summary> com a mesma contagem e abertura/fechamento balanceados;
- comentários {/* */} idênticos (exceto o marcador);
- URLs de links markdown idênticas e na mesma ordem;
- mesmo número e nível de títulos #;
- título traduzido termina com ` \\{#id}` igual ao slug do título em inglês no nextjs.org
  (ancorar_titulos.py grava);
- código inline que não existe no inglês vira AVISO (não bloqueia).

Uso: python3 tool/traducao/verificar.py [caminhos .mdx...]
Saída: `ERRO arquivo: ...` e `N arquivo(s) traduzido(s), M erro(s)`; exit 1 se houver erro.
"""
import re
import sys
from pathlib import Path

from comum import (MARCADOR, SUFIXO, commit_upstream, id_esperado, ingles, paginas, rel,
                   routers_da_pagina, separar_frontmatter, slugs_do_ingles, texto_do_titulo,
                   titulos, traduzido)

try:
    import yaml
except ImportError:  # o build (js-yaml) também falha com frontmatter inválido
    yaml = None

ATTR_TRADUZIVEIS = ('alt', 'caption', 'title', 'summary')
FRONTMATTER_TRADUZIVEL = ('title', 'description', 'nav_title')


def _neutralizar_fm(d, raiz=True):
    if isinstance(d, dict):
        out = {}
        for k, v in d.items():
            if (k in FRONTMATTER_TRADUZIVEL) and isinstance(v, str):
                out[k] = ''
            else:
                out[k] = _neutralizar_fm(v, False)
        return out
    if isinstance(d, list):
        return [_neutralizar_fm(x, False) for x in d]
    return d


def linhas_fm(fm):
    """Frontmatter sem yaml: chaves/linhas não traduzíveis devem ser idênticas."""
    out = []
    for linha in fm.splitlines():
        m = re.match(r'(\s*)([A-Za-z_][\w-]*):', linha)
        if m and m.group(2) in FRONTMATTER_TRADUZIVEL:
            out.append(f'{m.group(1)}{m.group(2)}:')
        else:
            out.append(linha)
    return out


def extrair_codigo(t):
    """Separa blocos cercados (``` ou ~~~). Devolve (blocos, texto sem os blocos)."""
    blocos, resto, dentro, cerca = [], [], None, None
    for linha in t.split('\n'):
        m = re.match(r'^\s*(`{3,}|~{3,})', linha)
        if dentro is None:
            if m:
                cerca, dentro = m.group(1), [linha]
            else:
                resto.append(linha)
        else:
            dentro.append(linha)
            if m and m.group(1)[0] == cerca[0] and len(m.group(1)) >= len(cerca) and linha.strip() == m.group(1):
                blocos.append('\n'.join(dentro))
                dentro = None
    if dentro is not None:
        blocos.append('\n'.join(dentro))
    return blocos, '\n'.join(resto)


def tags_jsx(t):
    """Tags JSX com maiúscula (abertura e fechamento), inteiras, com espaços normalizados."""
    tags, i, n = [], 0, len(t)
    padrao = re.compile(r'</?[A-Z]')
    while i < n:
        m = padrao.search(t, i)
        if not m:
            break
        j, prof, aspas = m.end(), 0, None
        while j < n:
            c = t[j]
            if aspas:
                if c == '\\':
                    j += 1
                elif c == aspas:
                    aspas = None
            elif c in '"\'`' and prof > 0 or c in '"\'':
                aspas = c
            elif c == '{':
                prof += 1
            elif c == '}':
                prof -= 1
            elif c == '>' and prof <= 0:
                break
            j += 1
        tags.append(re.sub(r'\s+', ' ', t[m.start():j + 1]))
        i = j + 1
    return tags


def neutralizar_atributos(tag):
    nomes = '|'.join(ATTR_TRADUZIVEIS)
    tag = re.sub(rf'\b({nomes})="[^"]*"', r'\1=""', tag)
    tag = re.sub(rf"\b({nomes})='[^']*'", r"\1=''", tag)
    return tag


def codigo_inline(t):
    return {m.group(2).strip() for m in re.finditer(r'(`+)(.+?)\1', t, re.S)}


def conferir(p, commit):
    r = rel(p)
    en = ingles(p, commit)
    if en is None:
        return [f'{r}: não existe no upstream ({commit[:9]})'], []
    pt = p.read_text()
    erros, avisos = [], []

    # frontmatter
    fe, corpo_en = separar_frontmatter(en)
    fp, corpo_pt = separar_frontmatter(pt)
    if yaml is not None:
        try:
            de, dp = yaml.safe_load(fe) or {}, yaml.safe_load(fp) or {}
            if _neutralizar_fm(de) != _neutralizar_fm(dp):
                erros.append('frontmatter: só title, description, nav_title e related.title/description podem mudar')
        except yaml.YAMLError as e:
            erros.append(f'frontmatter não é YAML válido (use aspas se o texto tiver ": "): {str(e).splitlines()[0]}')
    elif linhas_fm(fe) != linhas_fm(fp):
        erros.append('frontmatter: só title, description, nav_title e related.title/description podem mudar')

    # código cercado
    be, se = extrair_codigo(corpo_en)
    bp, sp = extrair_codigo(corpo_pt)
    if be != bp:
        if len(be) != len(bp):
            erros.append(f'blocos de código: {len(be)} no inglês, {len(bp)} na tradução')
        else:
            k = next(i for i, (a, b) in enumerate(zip(be, bp)) if a != b)
            erros.append(f'bloco de código #{k + 1} diferente do inglês: `{bp[k].splitlines()[0][:60]}`')

    # imports
    imp = lambda t: [l.strip() for l in t.splitlines() if re.match(r'import\s', l)]
    if imp(se) != imp(sp):
        erros.append('linhas de import diferentes do inglês')

    # comentários {/* */}
    com = re.compile(r'\{/\*.*?\*/\}', re.S)
    ce = com.findall(se)
    cp = [c for c in com.findall(sp) if c.strip() != MARCADOR]
    if ce != cp:
        erros.append(f'comentários {{/* */}} diferentes do inglês ({len(ce)} no inglês, {len(cp)} na tradução)')

    se2, sp2 = com.sub('', se), com.sub('', sp)
    se3, sp3 = re.sub(r'`[^`\n]*`', '', se2), re.sub(r'`[^`\n]*`', '', sp2)

    # componentes JSX
    te = [neutralizar_atributos(x) for x in tags_jsx(se3)]
    tp = [neutralizar_atributos(x) for x in tags_jsx(sp3)]
    if te != tp:
        if len(te) != len(tp):
            erros.append(f'tags JSX: {len(te)} no inglês, {len(tp)} na tradução')
        else:
            a, b = next((a, b) for a, b in zip(te, tp) if a != b)
            erros.append(f'tag JSX diferente do inglês: `{a[:80]}` -> `{b[:80]}`')

    # <details>/<summary>
    for tag in ('details', 'summary'):
        abre_e, fecha_e = len(re.findall(rf'<{tag}\b', se3)), len(re.findall(rf'</{tag}>', se3))
        abre_p, fecha_p = len(re.findall(rf'<{tag}\b', sp3)), len(re.findall(rf'</{tag}>', sp3))
        if (abre_e, fecha_e) != (abre_p, fecha_p) or abre_p != fecha_p:
            erros.append(f'<{tag}>: {abre_e}/{fecha_e} no inglês, {abre_p}/{fecha_p} na tradução')

    # URLs de links markdown
    url = lambda t: re.findall(r'\]\(([^)\s]+)', t)
    if url(se3) != url(sp3):
        ue, up = url(se3), url(sp3)
        dif = next((f'`{a}` -> `{b}`' for a, b in zip(ue, up) if a != b), f'{len(ue)} no inglês, {len(up)} na tradução')
        erros.append(f'URLs de links markdown diferentes do inglês ({dif})')

    # títulos
    tm_en, tm_pt = titulos(en), titulos(pt)
    if [(n, c) for n, _, _, c in tm_en] != [(n, c) for n, _, _, c in tm_pt]:
        erros.append(f'títulos #: {len(tm_en)} no inglês, {len(tm_pt)} na tradução (ou níveis/AppOnly/PagesOnly diferentes)')
    else:
        routers = routers_da_pagina(p)
        for (_, _, bruto_en, _), (_, _, bruto_pt, _), slugs in zip(tm_en, tm_pt, slugs_do_ingles(en, routers)):
            alvo = id_esperado(slugs, routers)
            if alvo is None:
                continue
            m = SUFIXO.search(bruto_pt)
            mudou = texto_do_titulo(bruto_pt) != texto_do_titulo(bruto_en)
            if m and not re.search(r'\\\{#', bruto_pt):
                erros.append(f'título "{bruto_pt[:50]}": escreva `\\{{#{alvo}}}` com a barra (`{{#id}}` solto quebra o MDX)')
            elif m and m.group(1) != alvo:
                erros.append(f'título "{bruto_pt[:50]}": id `{m.group(1)}`, deveria ser `{alvo}` (rode ancorar_titulos.py)')
            elif not m and mudou:
                erros.append(f'título "{bruto_pt[:50]}": falta ` \\{{#{alvo}}}` (rode ancorar_titulos.py)')

    # código inline novo
    for c in sorted(codigo_inline(sp2) - codigo_inline(se2))[:5]:
        avisos.append(f'{r}: código inline que não existe no inglês (traduzido?): `{c}`')

    return [f'{r}: {e}' for e in erros], avisos


def main():
    args = sys.argv[1:]
    commit = commit_upstream()
    arquivos = [Path(a).resolve() for a in args] if args else [p for p in paginas() if traduzido(p.read_text())]
    todos_erros = []
    for p in arquivos:
        if not traduzido(p.read_text()):
            print(f'AVISO {rel(p)}: sem o marcador `{MARCADOR}` na última linha (o site mostra "ainda em inglês")')
        erros, avisos = conferir(p, commit)
        todos_erros += erros
        for a in avisos:
            print(f'AVISO {a}')
    for e in todos_erros:
        print(f'ERRO {e}')
    print(f'{len(arquivos)} arquivo(s) traduzido(s), {len(todos_erros)} erro(s)')
    sys.exit(1 if todos_erros else 0)


if __name__ == '__main__':
    main()
