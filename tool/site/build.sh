#!/usr/bin/env bash
# Gera o site estático em site/ (gitignored): MDX -> HTML (build.mjs) + índice de busca (Pagefind).
# Servir local: npx serve@14 site   (o `serve` faz cleanUrls como o Firebase)
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --no-fund --no-audit
npm run build
