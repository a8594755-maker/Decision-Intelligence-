#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Decision Intelligence — Health Check Script
#
# Checks real dependency status: DB, LLM proxy, ML API, frontend.
# Exit code 0 = all critical services healthy, 1 = degraded.
#
# Usage:
#   ./scripts/healthcheck.sh                    # Check all
#   ./scripts/healthcheck.sh --json             # JSON output
#   ./scripts/healthcheck.sh --service mlapi    # Check one service
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Source env
set -a
[ -f ".env" ] && source ".env" 2>/dev/null || true
[ -f ".env.local" ] && source ".env.local" 2>/dev/null || true
set +a

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

JSON_MODE=false
SERVICE_FILTER=""
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=true ;;
    --service) SERVICE_FILTER="next" ;;
    *)
      if [ "$SERVICE_FILTER" = "next" ]; then SERVICE_FILTER="$arg"; fi
      ;;
  esac
done

SUPABASE_URL="${VITE_SUPABASE_URL:-}"
SUPABASE_KEY="${VITE_SUPABASE_ANON_KEY:-}"
ML_API_URL="${VITE_ML_API_URL:-http://127.0.0.1:8000}"

# bash 3.x compatible — use simple variables instead of associative arrays
R_SUPABASE="" R_MLAPI="" R_AI_PROXY="" R_FRONTEND=""

# ── Check functions ───────────────────────────────────────────────

check_supabase() {
  if [ -z "$SUPABASE_URL" ]; then
    R_SUPABASE="not_configured"; return
  fi
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: $SUPABASE_KEY" \
    "${SUPABASE_URL}/auth/v1/health" \
    --connect-timeout 5 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then R_SUPABASE="online"; else R_SUPABASE="offline"; fi
}

check_mlapi() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    "${ML_API_URL}/readyz" \
    --connect-timeout 5 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then R_MLAPI="online"; else R_MLAPI="offline"; fi
}

check_ai_proxy() {
  if [ -z "$SUPABASE_URL" ]; then
    R_AI_PROXY="not_configured"; return
  fi
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X OPTIONS \
    "${SUPABASE_URL}/functions/v1/ai-proxy" \
    --connect-timeout 5 2>/dev/null || echo "000")
  if [ "$code" = "200" ] || [ "$code" = "204" ]; then R_AI_PROXY="online"; else R_AI_PROXY="offline"; fi
}

check_frontend() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://localhost:5173" \
    --connect-timeout 3 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then R_FRONTEND="online"; else R_FRONTEND="offline"; fi
}

# ── Run checks ────────────────────────────────────────────────────

if [ -n "$SERVICE_FILTER" ] && [ "$SERVICE_FILTER" != "next" ]; then
  case "$SERVICE_FILTER" in
    supabase)  check_supabase ;;
    mlapi)     check_mlapi ;;
    ai_proxy)  check_ai_proxy ;;
    frontend)  check_frontend ;;
    *) echo "Unknown service: $SERVICE_FILTER"; exit 1 ;;
  esac
else
  check_supabase
  check_mlapi
  check_ai_proxy
  check_frontend
fi

# ── Determine overall status ──────────────────────────────────────

OVERALL="healthy"
for status in "$R_SUPABASE" "$R_MLAPI" "$R_AI_PROXY" "$R_FRONTEND"; do
  if [ "$status" = "offline" ]; then OVERALL="degraded"; fi
done

# ── Output ────────────────────────────────────────────────────────

SERVICES="supabase mlapi ai_proxy frontend"

get_result() {
  case "$1" in
    supabase)  echo "$R_SUPABASE" ;;
    mlapi)     echo "$R_MLAPI" ;;
    ai_proxy)  echo "$R_AI_PROXY" ;;
    frontend)  echo "$R_FRONTEND" ;;
  esac
}

if $JSON_MODE; then
  echo -n '{"status":"'"$OVERALL"'","services":{'
  first=true
  for svc in $SERVICES; do
    status=$(get_result "$svc")
    if [ -n "$status" ]; then
      $first || echo -n ","
      echo -n "\"$svc\":\"$status\""
      first=false
    fi
  done
  echo -n '},"timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
  echo ""
else
  echo ""
  echo "═══ Health Check ═══"
  for svc in $SERVICES; do
    status=$(get_result "$svc")
    if [ -n "$status" ]; then
      case "$status" in
        online)         echo -e "  ${GREEN}●${NC} $svc: online" ;;
        offline)        echo -e "  ${RED}●${NC} $svc: offline" ;;
        not_configured) echo -e "  ${YELLOW}●${NC} $svc: not configured" ;;
      esac
    fi
  done
  echo ""
  if [ "$OVERALL" = "healthy" ]; then
    echo -e "  Overall: ${GREEN}$OVERALL${NC}"
  else
    echo -e "  Overall: ${RED}$OVERALL${NC}"
  fi
  echo ""
fi

[ "$OVERALL" = "healthy" ] && exit 0 || exit 1
