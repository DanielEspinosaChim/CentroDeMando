#!/usr/bin/env bash
# tests-must-pass.sh — Stop
# No deja que Claude termine el turno con tests en rojo si cambió código.
# - Solo corre si hay cambios sin commit en archivos de código (no gasta tiempo en preguntas).
# - Comando de tests: la primera línea de .claude/test-command, o se detecta (uv/pytest).
# - Tope de 3 bloqueos seguidos por sesión; después avisa y deja terminar para que tú decidas.

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
INPUT=$(cat)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "nosession"' 2>/dev/null)
COUNTER_DIR="${TMPDIR:-/tmp}/claude-tests-must-pass"
mkdir -p "$COUNTER_DIR"
COUNTER="$COUNTER_DIR/$SESSION"

# ¿Hay cambios de código? (si no es repo git, se asume que sí)
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CHANGED=$(git status --porcelain --untracked-files=all | awk '{print $NF}' |
    grep -E '\.(py|pyi|ipynb|js|jsx|ts|tsx|go|rs|java|sql|toml|cfg|yaml|yml)$' | head -1)
  if [ -z "$CHANGED" ]; then
    rm -f "$COUNTER"
    exit 0
  fi
fi

if [ -f .claude/test-command ]; then
  TEST_CMD=$(head -1 .claude/test-command)
elif [ -f package.json ] && jq -e '.scripts.test' package.json >/dev/null 2>&1 \
     && ! jq -r '.scripts.test' package.json | grep -q 'no test specified'; then
  TEST_CMD="npm test --silent"
elif [ -f uv.lock ] && command -v uv >/dev/null 2>&1; then
  TEST_CMD="uv run pytest -q -x"
elif command -v pytest >/dev/null 2>&1 && { [ -d tests ] || [ -d test ]; }; then
  TEST_CMD="pytest -q -x"
else
  exit 0   # no hay suite de tests detectable
fi

LOG="$COUNTER_DIR/$SESSION.log"
if PYTHONDONTWRITEBYTECODE=1 bash -c "$TEST_CMD" >"$LOG" 2>&1; then
  rm -f "$COUNTER"
  exit 0
fi

# pytest sale con 5 cuando no encontró tests: no es un fallo del código
grep -q "no tests ran" "$LOG" && exit 0

N=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
echo "$N" >"$COUNTER"
if [ "$N" -gt 3 ]; then
  echo "AVISO [tests-must-pass]: los tests siguen fallando después de 3 intentos. Se deja terminar; reporta al humano qué falla y por qué, con la salida." >&2
  rm -f "$COUNTER"
  exit 0
fi

{
  echo "Los tests fallan ($TEST_CMD). No termines todavía: arréglalos (el código, no los tests, salvo que el test esté mal)."
  echo "Últimas líneas:"
  tail -40 "$LOG"
} >&2
exit 2
