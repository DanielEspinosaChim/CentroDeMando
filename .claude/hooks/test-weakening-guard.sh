#!/usr/bin/env bash
# test-weakening-guard.sh — PreToolUse (Edit|MultiEdit|Write)
# Detecta la trampa más común de un agente: hacer pasar los tests debilitándolos
# (quitar asserts, saltar tests, marcar xfail, dejar it.only). No bloquea a ciegas:
# le pide confirmación al humano con el motivo, porque a veces un test sí estaba mal.

command -v jq >/dev/null 2>&1 || exit 0
INPUT=$(cat)
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0

# ¿Es un archivo de tests?
printf '%s' "$FILE" | grep -qE '(^|/)(tests?|__tests__)/|(^|/)test_[^/]*\.py$|_test\.py$|\.(test|spec)\.(t|j)sx?$' || exit 0

case "$TOOL" in
  Edit)
    OLD=$(printf '%s' "$INPUT" | jq -r '.tool_input.old_string // ""')
    NEW=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // ""') ;;
  MultiEdit)
    OLD=$(printf '%s' "$INPUT" | jq -r '[.tool_input.edits[]?.old_string] | join("\n")')
    NEW=$(printf '%s' "$INPUT" | jq -r '[.tool_input.edits[]?.new_string] | join("\n")') ;;
  Write)
    OLD=$([ -f "$FILE" ] && cat "$FILE" || true)
    NEW=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // ""') ;;
  *) exit 0 ;;
esac

contar() { printf '%s\n' "$1" | grep -cE "$2" || true; }
ASSERT_RE='(^|[^a-zA-Z_])assert[ (]|self\.assert[A-Z]|pytest\.raises|expect\(|assert\.|toThrow|toEqual|toBe\('
SKIP_RE='pytest\.mark\.(skip|xfail)|pytest\.skip\(|unittest\.skip|\b(it|test|describe)\.(skip|only)\(|\bx(it|describe|test)\('

# Peso de las verificaciones: cada assert/expect cuenta, y también cada condición
# dentro de ellos (==, !=, <, >, in, is, and, isinstance, .toX), para detectar
# cuando se deja el assert pero se le quitan condiciones.
peso() {
  printf '%s\n' "$1" | grep -E "$ASSERT_RE" | python3 -c '
import re, sys
t = sys.stdin.read()
lineas = [l for l in t.splitlines() if l.strip()]
cond = re.findall(r"==|!=|<=|>=|(?<![<>=-])[<>](?![=>])|\bin\b|\bis\b|\band\b|isinstance\(|\.to[A-Z]\w*\(", t)
print(len(lineas) + len(cond))' 2>/dev/null || echo 0
}

A_OLD=$(peso "$OLD"); A_NEW=$(peso "$NEW")
S_OLD=$(contar "$OLD" "$SKIP_RE");   S_NEW=$(contar "$NEW" "$SKIP_RE")

# Valores esperados cambiados en asserts de un test que ya está commiteado:
# los tests escritos en esta sesión se pueden ajustar libremente; los que ya
# estaban en git representan la spec y cambiarlos requiere confirmación.
VALOR_CAMBIADO=0
if [ "$TOOL" != "Write" ] || [ -f "$FILE" ]; then
  if git -C "$(dirname "$FILE")" ls-files --error-unmatch "$FILE" >/dev/null 2>&1 \
     && git -C "$(dirname "$FILE")" cat-file -e "HEAD:./$(basename "$FILE")" 2>/dev/null; then
    VALOR_CAMBIADO=$(OLD="$OLD" NEW="$NEW" python3 "$(dirname "$0")/_valores_asserts.py" 2>/dev/null || echo 0)
  fi
fi

MOTIVO=""
[ "$VALOR_CAMBIADO" = 1 ] && MOTIVO="El cambio en $FILE modifica valores esperados de asserts en un test ya commiteado. ¿Cambió la spec? Si no, el que está mal es el código."
[ "$A_NEW" -lt "$A_OLD" ] && MOTIVO="$MOTIVO El cambio en $FILE debilita verificaciones (peso de asserts/condiciones $A_OLD → $A_NEW)."
[ "$S_NEW" -gt "$S_OLD" ] && MOTIVO="$MOTIVO El cambio en $FILE salta o aísla tests (skip/xfail/only)."
[ -z "$MOTIVO" ] && exit 0

jq -n --arg r "$MOTIVO Si el test estaba mal, explica por qué antes de aprobar; si no, arregla el código en lugar del test." \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r}}'
exit 0
