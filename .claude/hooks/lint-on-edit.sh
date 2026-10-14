#!/usr/bin/env bash
# lint-on-edit.sh — PostToolUse (Write|Edit|MultiEdit)
# Corre ruff sobre el archivo Python que Claude acaba de editar.
# Si hay errores, sale con 2: Claude ve el error y lo corrige en el siguiente paso.
# No modifica el archivo (sin --fix) para no desincronizar lo que Claude cree que escribió.

command -v jq >/dev/null 2>&1 || exit 0
FILE=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *.py|*.pyi) ;;
  *) exit 0 ;;
esac
[ -f "$FILE" ] || exit 0

if command -v ruff >/dev/null 2>&1; then
  RUFF=(ruff)
elif command -v uvx >/dev/null 2>&1; then
  RUFF=(uvx ruff)
else
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
OUT=$("${RUFF[@]}" check --output-format concise "$FILE" 2>&1)
STATUS=$?
"${RUFF[@]}" format --check "$FILE" >/dev/null 2>&1
FMT_STATUS=$?

if [ $STATUS -ne 0 ] || [ $FMT_STATUS -ne 0 ]; then
  echo "ruff encontró problemas en $FILE. Corrígelos antes de seguir:" >&2
  [ $STATUS -ne 0 ] && printf '%s\n' "$OUT" | head -40 >&2
  [ $FMT_STATUS -ne 0 ] && echo "Formato: corre 'ruff format $FILE'." >&2
  exit 2
fi
exit 0
