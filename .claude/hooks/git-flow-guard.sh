#!/usr/bin/env bash
# git-flow-guard.sh — PreToolUse (Bash)
# Hace cumplir "una rama por feature" (sección Git del CLAUDE.md):
#   - Integrar una rama a main/master  -> pide el OK del humano para ESE merge.
#   - Commit directo en main/master    -> pide el OK (solo se justifica el commit inicial).
#   - git merge --squash               -> bloquea (pierde el historial de la rama).
# Traer main a la rama (git merge main estando en feat/...) pasa sin preguntar.

command -v jq >/dev/null 2>&1 || { echo "WARNING [git-flow-guard]: falta jq; este guard NO te protege." >&2; exit 0; }

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$CMD" ] && exit 0
printf '%s' "$CMD" | grep -qE '(^|[^[:alnum:]_-])git[[:space:]]' || exit 0

DIR=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$DIR" ] && DIR="${CLAUDE_PROJECT_DIR:-.}"
RAMA=$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)

es_main() { printf '%s' "$1" | grep -qE '^(origin/)?(main|master)$'; }

ask() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
  exit 0
}
block() { echo "BLOQUEADO por git-flow-guard: $1" >&2; [ -n "$2" ] && echo "Alternativa: $2" >&2; exit 2; }

SEGMENTS=$(printf '%s\n' "$CMD" | sed -E 's/(\&\&|\|\||;|\|)/\n/g')
while IFS= read -r seg; do
  seg=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/^git[[:space:]]+-C[[:space:]]+[^[:space:]]+/git/')
  [ -z "$seg" ] && continue

  # Sigue en qué rama queda el comando compuesto (git checkout main && git merge ...)
  if printf '%s' "$seg" | grep -qE '^git[[:space:]]+(checkout|switch)[[:space:]]'; then
    destino=$(printf '%s' "$seg" | awk '{for(i=3;i<=NF;i++) if ($i !~ /^-/) {print $i; exit}}')
    if printf '%s' "$seg" | grep -qE '[[:space:]](-b|-B|-c|-C|--orphan)[[:space:]]'; then
      destino=$(printf '%s' "$seg" | awk '{for(i=3;i<=NF;i++) if ($i ~ /^-(b|B|c|C)$|^--orphan$/) {print $(i+1); exit}}')
    fi
    [ -n "$destino" ] && [ "$destino" != "--" ] && RAMA="$destino"
    continue
  fi

  if printf '%s' "$seg" | grep -qE '^git[[:space:]]+merge([[:space:]]|$)'; then
    printf '%s' "$seg" | grep -qE '[[:space:]]--(abort|continue|quit)([[:space:]]|$)' && continue
    printf '%s' "$seg" | grep -qE '[[:space:]]--squash([[:space:]]|$)' &&
      block "git merge --squash pierde el detalle de commits de la rama" "integra con git merge --no-ff <rama>"
    origen=$(printf '%s' "$seg" | awk '{for(i=3;i<=NF;i++) if ($i !~ /^-/ && $(i-1) != "-m") {print $i; exit}}')
    if es_main "$RAMA" && ! es_main "$origen"; then
      ask "Integrar '${origen:-?}' a $RAMA necesita tu OK explícito para ESTE merge (aunque los tests estén en verde). Antes: criterios cumplidos, tests en verde, auditoría hecha y main ya traído a la rama."
    fi
    continue
  fi

  if printf '%s' "$seg" | grep -qE '^git[[:space:]]+commit([[:space:]]|$)' && es_main "$RAMA"; then
    ask "Commit directo en $RAMA. Solo se justifica para el commit inicial del proyecto; el trabajo de una feature va en su rama feat/NNN-nombre."
  fi
done <<< "$SEGMENTS"

exit 0
