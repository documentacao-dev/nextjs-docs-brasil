#!/usr/bin/env python3
"""Acrescenta ` \\{#id}` (id em inglês) aos títulos das páginas traduzidas.

Para cada .mdx com o marcador `{/* ia-translate: true */}` na última linha, lê o inglês
do commit em ultimo-sync-upstream.txt, calcula o slug de cada título # do inglês como o
nextjs.org (github-slugger, com -1, -2 para repetidos, contando App Router e Pages Router
em separado) e grava no título traduzido correspondente (na mesma ordem) o sufixo
` \\{#slug}`; se já houver, corrige. A barra é necessária porque `{...}` solto é uma
expressão no MDX; o site (tool/site/build.mjs) tira o sufixo do texto e usa o id.

Uso: python3 tool/traducao/ancorar_titulos.py [caminhos .mdx...]
"""
import sys
from pathlib import Path

from comum import (SUFIXO, commit_upstream, id_esperado, ingles, paginas, rel,
                   routers_da_pagina, slugs_do_ingles, titulos, traduzido)


def ancorar(p, commit):
    en = ingles(p, commit)
    if en is None:
        print(f'ERRO {rel(p)}: não existe no upstream')
        return False
    pt = p.read_text()
    routers = routers_da_pagina(p)
    se, tp = slugs_do_ingles(en, routers), titulos(pt)
    if len(se) != len(tp):
        print(f'ERRO {rel(p)}: {len(se)} títulos no inglês, {len(tp)} na tradução')
        return False
    linhas = pt.split('\n')
    for slugs, (_, i, bruto, _) in zip(se, tp):
        alvo = id_esperado(slugs, routers)
        if alvo is None:
            continue
        if len(set(slugs.values())) > 1:
            print(f'AVISO {rel(p)}: "{bruto[:50]}" tem id diferente em cada router {slugs}; gravado {alvo}')
        linhas[i] = linhas[i].replace(bruto, SUFIXO.sub('', bruto) + ' \\{#' + alvo + '}', 1)
    novo = '\n'.join(linhas)
    if novo != pt:
        p.write_text(novo)
        print(f'ancorado {rel(p)}')
    return True


def main():
    commit = commit_upstream()
    args = sys.argv[1:]
    arquivos = [Path(a).resolve() for a in args] if args else [p for p in paginas() if traduzido(p.read_text())]
    ok = all([ancorar(p, commit) for p in arquivos])
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
