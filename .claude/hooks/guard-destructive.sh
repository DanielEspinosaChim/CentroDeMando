#!/usr/bin/env bash
# guard-destructive.sh — PreToolUse (Bash)
# Bloquea comandos que destruyen trabajo o se saltan el flujo de PRs.
# Idea basada en los hooks de trailofbits/claude-code-config; reescrito para este kit.
# Salida 2 = bloquear y mostrarle el motivo a Claude.

if ! command -v jq >/dev/null 2>&1; then
  echo "WARNING [guard-destructive]: jq no está instalado; este guard NO te protege. Instala jq." >&2
  exit 0
fi

CMD=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0

block() {
  echo "BLOQUEADO por guard-destructive: $1" >&2
  echo "Comando: $CMD" >&2
  [ -n "$2" ] && echo "Alternativa: $2" >&2
  exit 2
}

# Separa el comando compuesto en segmentos (; && || |) para revisar cada uno.
SEGMENTS=$(printf '%s\n' "$CMD" | sed -E 's/(\&\&|\|\||;|\|)/\n/g')

while IFS= read -r seg; do
  seg=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//')
  [ -z "$seg" ] && continue

  # rm recursivo + forzado, en cualquier orden de flags (-rf, -fr, -r -f, --recursive --force)
  if printf '%s' "$seg" | grep -qE '^(sudo[[:space:]]+)?rm[[:space:]]'; then
    if printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$)' &&
       printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$)'; then
      block "rm recursivo forzado" "mueve los archivos a .trash/ (está en .gitignore) en lugar de borrarlos"
    fi
  fi

  # git: push directo a main/master, push forzado, reset --hard, clean -f, checkout que descarta cambios
  if printf '%s' "$seg" | grep -qE '^git[[:space:]]+push'; then
    printf '%s' "$seg" | grep -qE '(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$)|[[:space:]]\+[^[:space:]]+)' &&
      block "git push forzado" "haz un commit nuevo que corrija, no reescribas historia publicada"
    printf '%s' "$seg" | grep -qE '([[:space:]:]|^)(main|master)([[:space:]]|$)' &&
      block "push directo a main/master" "trabaja en una rama y abre un PR"
  fi
  # --no-verify en commit/push/merge, o -n combinado en commit (en push, -n es --dry-run y se permite)
  { printf '%s' "$seg" | grep -qE '^git[[:space:]]+(commit|push|merge)[[:space:]](.*[[:space:]])?--no-verify([[:space:]]|$)' ||
    printf '%s' "$seg" | grep -qE '^git[[:space:]]+commit[[:space:]](.*[[:space:]])?-[a-mo-zA-Z]*n[a-zA-Z]*([[:space:]]|$)'; } &&
    block "saltarse los hooks de git (--no-verify)" "arregla lo que reporta pre-commit; si es un falso positivo, dilo y pide al humano"
  printf '%s' "$seg" | grep -qE '^git[[:space:]]+reset[[:space:]].*--hard' &&
    block "git reset --hard descarta trabajo" "usa git stash o un commit"
  printf '%s' "$seg" | grep -qE '^git[[:space:]]+clean[[:space:]].*-[a-zA-Z]*f' &&
    block "git clean -f borra archivos no versionados" "revisa con git clean -n primero y pídeselo al humano"
  printf '%s' "$seg" | grep -qE '^git[[:space:]]+(checkout|restore)[[:space:]]+(--[[:space:]]+)?\.([[:space:]]|$)' &&
    block "descartar todos los cambios del árbol de trabajo" "usa git stash"
  printf '%s' "$seg" | grep -qE '^git[[:space:]]+branch[[:space:]].*-D' &&
    block "borrado forzado de rama" "pídeselo al humano"

  # Sistema
  printf '%s' "$seg" | grep -qE '^sudo([[:space:]]|$)' && block "sudo no está permitido para el agente"
  printf '%s' "$seg" | grep -qE '^(mkfs|fdisk|parted|shutdown|reboot)([[:space:].]|$)' && block "comando de sistema destructivo"
  printf '%s' "$seg" | grep -qE '^dd[[:space:]].*of=' && block "dd escribiendo a disco"
  printf '%s' "$seg" | grep -qE '^chmod[[:space:]]+(-R[[:space:]]+)?777' && block "chmod 777" "da solo los permisos necesarios"
done <<< "$SEGMENTS"

# Descargar y ejecutar en una sola línea (curl/wget ... | sh/bash/python)
printf '%s' "$CMD" | grep -qE '(curl|wget)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh([[:space:]]|$)|(curl|wget)[^|]*\|[[:space:]]*python' &&
  block "descargar y ejecutar código remoto sin revisarlo" "descarga el archivo, revísalo, y pídele al humano que lo ejecute"

exit 0
