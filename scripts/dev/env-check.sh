#!/usr/bin/env bash
# Vérifie que .env et .env.example ont les mêmes clés (même ensemble).
# Optionnellement le même ordre de clés (ALIGN_ORDER=1).
# Ne lit / n’affiche jamais les valeurs secrètes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EX="$ROOT/.env.example"
ENVF="$ROOT/.env"

keys_sorted() {
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | cut -d= -f1 | sort -u
}

keys_ordered() {
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | cut -d= -f1
}

if [[ ! -f "$EX" ]]; then
  echo "❌ Manque $EX" >&2
  exit 1
fi
if [[ ! -f "$ENVF" ]]; then
  echo "⚠️  Pas de .env — copie : cp .env.example .env" >&2
  exit 1
fi

tmp_ex="$(mktemp)"
tmp_env="$(mktemp)"
keys_sorted "$EX" >"$tmp_ex"
keys_sorted "$ENVF" >"$tmp_env"

only_ex="$(comm -23 "$tmp_ex" "$tmp_env" || true)"
only_env="$(comm -13 "$tmp_ex" "$tmp_env" || true)"
rm -f "$tmp_ex" "$tmp_env"

ok=1
if [[ -n "$only_ex" ]]; then
  echo "❌ Clés dans .env.example absentes de .env :"
  echo "$only_ex" | sed 's/^/   - /'
  ok=0
fi
if [[ -n "$only_env" ]]; then
  echo "❌ Clés dans .env absentes de .env.example :"
  echo "$only_env" | sed 's/^/   - /'
  ok=0
fi

if [[ "${ALIGN_ORDER:-1}" == "1" ]]; then
  order_ex="$(keys_ordered "$EX" | tr '\n' ' ')"
  order_env="$(keys_ordered "$ENVF" | tr '\n' ' ')"
  if [[ "$order_ex" != "$order_env" ]]; then
    echo "⚠️  Ordre des clés différent entre .env et .env.example (ensemble OK)."
    echo "   Aligne les lignes pour faciliter la relecture (secrets restent dans .env)."
  fi
fi

if [[ "$ok" -eq 1 ]]; then
  n="$(keys_sorted "$EX" | wc -l | tr -d ' ')"
  echo "✅ .env et .env.example alignés ($n clés) — aucune valeur affichée"
  exit 0
fi
exit 1
