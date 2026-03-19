#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Decision Intelligence — Full-Stack Startup Script
#
# Usage:
#   ./scripts/start.sh              # Start all services
#   ./scripts/start.sh --check      # Preflight checks only (dry-run)
#   ./scripts/start.sh --frontend   # Frontend only
#   ./scripts/start.sh --backend    # Backend only
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

# ── Parse flags ───────────────────────────────────────────────────
MODE="all"
for arg in "$@"; do
  case "$arg" in
    --check)    MODE="check" ;;
    --frontend) MODE="frontend" ;;
    --backend)  MODE="backend" ;;
    --help|-h)
      echo "Usage: ./scripts/start.sh [--check|--frontend|--backend]"
      echo "  --check      Run preflight checks only (dry-run)"
      echo "  --frontend   Start frontend only"
      echo "  --backend    Start backend only"
      echo "  (no flag)    Start all services"
      exit 0
      ;;
  esac
done

ERRORS=0

# ── 1. Environment check ─────────────────────────────────────────
echo ""
echo "═══ Preflight Checks ═══"

# Node.js
if command -v node &>/dev/null; then
  ok "Node.js $(node --version)"
else
  fail "Node.js not found"; ERRORS=$((ERRORS + 1))
fi

# Python
if command -v python3 &>/dev/null; then
  ok "Python $(python3 --version 2>&1 | awk '{print $2}')"
elif command -v python &>/dev/null; then
  ok "Python $(python --version 2>&1 | awk '{print $2}')"
else
  fail "Python not found"; ERRORS=$((ERRORS + 1))
fi

# npm dependencies
if [ -d "node_modules" ]; then
  ok "node_modules present"
else
  warn "node_modules missing — running npm install..."
  npm install
  ok "npm install completed"
fi

# .env / .env.local
if [ -f ".env.local" ]; then
  ok ".env.local found"
elif [ -f ".env" ]; then
  ok ".env found"
else
  warn "No .env or .env.local found — services may not connect to Supabase/LLM"
fi

# ── 2. Required env vars ─────────────────────────────────────────
echo ""
echo "═══ Environment Variables ═══"

# Source env files for checking
set -a
[ -f ".env" ] && source ".env" 2>/dev/null || true
[ -f ".env.local" ] && source ".env.local" 2>/dev/null || true
set +a

check_env() {
  local var_name="$1"
  local required="${2:-true}"
  if [ -n "${!var_name:-}" ]; then
    ok "$var_name configured"
  elif [ "$required" = "true" ]; then
    fail "$var_name not set (required)"; ERRORS=$((ERRORS + 1))
  else
    warn "$var_name not set (optional)"
  fi
}

check_env "VITE_SUPABASE_URL"
check_env "VITE_SUPABASE_ANON_KEY"
check_env "VITE_ML_API_URL" "false"
check_env "VITE_DEEPSEEK_API_KEY" "false"

# ── 3. DB migration check ────────────────────────────────────────
echo ""
echo "═══ Database Migration Check ═══"

MIGRATION_DIR="supabase/migrations"
if [ -d "$MIGRATION_DIR" ]; then
  MIGRATION_COUNT=$(ls -1 "$MIGRATION_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ')
  ok "$MIGRATION_COUNT migration files found in $MIGRATION_DIR"

  # Check if supabase CLI is available for live migration status
  if command -v supabase &>/dev/null; then
    echo "  Checking migration status via Supabase CLI..."
    if supabase db diff --linked 2>/dev/null; then
      ok "Migrations are up to date"
    else
      warn "Could not verify migration status — ensure migrations are applied"
    fi
  else
    warn "Supabase CLI not installed — cannot verify applied migrations"
    echo "    Install: npm i -g supabase | brew install supabase/tap/supabase"
    echo "    Apply:   supabase db push"
  fi
else
  fail "Migration directory not found: $MIGRATION_DIR"; ERRORS=$((ERRORS + 1))
fi

# ── 4. Supabase connectivity ─────────────────────────────────────
echo ""
echo "═══ Service Connectivity ═══"

SUPABASE_URL="${VITE_SUPABASE_URL:-}"
SUPABASE_KEY="${VITE_SUPABASE_ANON_KEY:-}"

if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "apikey: $SUPABASE_KEY" \
    "${SUPABASE_URL}/auth/v1/health" \
    --connect-timeout 5 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    ok "Supabase reachable (HTTP $HTTP_CODE)"
  else
    warn "Supabase not reachable (HTTP $HTTP_CODE)"
  fi
else
  warn "Supabase URL/key not set — skipping connectivity check"
fi

# LLM Proxy check
if [ -n "$SUPABASE_URL" ]; then
  PROXY_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X OPTIONS \
    "${SUPABASE_URL}/functions/v1/ai-proxy" \
    --connect-timeout 5 2>/dev/null || echo "000")
  if [ "$PROXY_CODE" = "200" ] || [ "$PROXY_CODE" = "204" ]; then
    ok "AI Proxy reachable (HTTP $PROXY_CODE)"
  else
    warn "AI Proxy not reachable (HTTP $PROXY_CODE) — LLM features may be unavailable"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}Preflight failed with $ERRORS error(s).${NC}"
  echo "Fix the issues above before starting services."
  exit 1
else
  echo -e "${GREEN}All preflight checks passed.${NC}"
fi

if [ "$MODE" = "check" ]; then
  echo ""
  echo "Dry-run complete. Use './scripts/start.sh' to start services."
  exit 0
fi

# ── 5. Start services ────────────────────────────────────────────
echo ""
echo "═══ Starting Services ═══"

cleanup() {
  echo ""
  echo "Shutting down services..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
  wait $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
  echo "Done."
}

BACKEND_PID=""
FRONTEND_PID=""

if [ "$MODE" = "all" ] || [ "$MODE" = "backend" ]; then
  echo "Starting ML API (backend) on port 8000..."
  python3 run_ml_api.py &
  BACKEND_PID=$!
  ok "ML API started (PID $BACKEND_PID)"
fi

if [ "$MODE" = "all" ] || [ "$MODE" = "frontend" ]; then
  echo "Starting Vite dev server (frontend)..."
  npm run dev &
  FRONTEND_PID=$!
  ok "Frontend started (PID $FRONTEND_PID)"
fi

trap cleanup SIGINT SIGTERM

echo ""
echo "═══ Services Running ═══"
[ -n "$BACKEND_PID" ]  && echo "  Backend:  http://127.0.0.1:8000  (PID $BACKEND_PID)"
[ -n "$FRONTEND_PID" ] && echo "  Frontend: http://localhost:5173   (PID $FRONTEND_PID)"
echo ""
echo "  Health:   http://127.0.0.1:8000/readyz"
echo "  Press Ctrl+C to stop all services."
echo ""

wait
