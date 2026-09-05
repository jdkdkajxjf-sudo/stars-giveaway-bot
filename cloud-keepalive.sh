#!/usr/bin/env bash
# Stars Giveaway Bot — 24/7 монитор для Cloud Shell

set -u
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$BOT_DIR/bot.log"
MONITOR_LOG="$BOT_DIR/monitor.log"
HEALTH_URL="http://localhost:3007/health"
CHECK_INTERVAL=30
RESTART_COUNT_FILE="$BOT_DIR/.restart_count"

mkdir -p "$BOT_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$MONITOR_LOG"
}

if [ ! -f "$RESTART_COUNT_FILE" ]; then
  echo "0" > "$RESTART_COUNT_FILE"
fi

get_restart_count() {
  cat "$RESTART_COUNT_FILE" 2>/dev/null || echo "0"
}

inc_restart_count() {
  local count=$(get_restart_count)
  echo $((count + 1)) > "$RESTART_COUNT_FILE"
}

kill_all_bots() {
  pkill -9 -f "bun run index.ts" 2>/dev/null
  pkill -9 -f "bun index.ts" 2>/dev/null
  sleep 1
}

is_bot_alive() {
  pgrep -f "bun run index.ts" > /dev/null 2>&1
}

check_env() {
  if [ ! -f "$BOT_DIR/.env" ]; then
    log "❌ .env файл не найден!"
    return 1
  fi
  if ! grep -q "DATABASE_URL=" "$BOT_DIR/.env"; then
    log "❌ DATABASE_URL не задан в .env"
    return 1
  fi
  return 0
}

update_code() {
  cd "$BOT_DIR"
  log "📥 Проверка обновлений кода..."
  if [ -f ".env" ]; then
    cp .env .env.backup
  fi
  if git pull --rebase origin main 2>&1 | grep -q "Updating\|Fast-forward"; then
    log "✅ Код обновлён"
    bunx prisma generate > /dev/null 2>&1
  else
    log "ℹ️ Код актуален"
  fi
  if [ -f ".env.backup" ]; then
    mv .env.backup .env
  fi
}

start_bot() {
  cd "$BOT_DIR"
  kill_all_bots
  update_code
  if ! check_env; then
    log "❌ Не могу запустить бота — проблемы с .env"
    return 1
  fi
  log "🔧 Применение миграций БД..."
  if ! bunx prisma db push --accept-data-loss >> "$LOG" 2>&1; then
    log "❌ Ошибка миграции БД"
    return 1
  fi
  nohup bun run index.ts >> "$LOG" 2>&1 &
  local PID=$!
  disown $PID 2>/dev/null || true
  log "▶️ Бот запущен, PID=$PID"
  sleep 8
  if is_bot_alive; then
    log "✅ Бот работает"
    inc_restart_count
    log "📊 Всего рестартов: $(get_restart_count)"
    return 0
  else
    log "❌ Бот упал сразу после старта — проверь bot.log"
    tail -20 "$LOG" >> "$MONITOR_LOG"
    return 1
  fi
}

log "========================================"
log "Stars Giveaway Bot — 24/7 монитор"
log "BOT_DIR: $BOT_DIR"
log "========================================"

if ! is_bot_alive; then
  start_bot
else
  log "ℹ️ Бот уже запущен"
fi

while true; do
  sleep "$CHECK_INTERVAL"
  if is_bot_alive; then
    curl -s -m 3 "$HEALTH_URL" > /dev/null 2>&1
    MINUTE=$(date '+%M')
    SECOND=$(date '+%S')
    if [ "$SECOND" -lt 30 ]; then
      if [ "$((MINUTE % 5))" -eq 0 ]; then
        log "💚 Бот работает ($(pgrep -f 'bun run index' | head -1))"
      fi
    fi
  else
    log "🔴 Бот упал — перезапуск..."
    start_bot
  fi
done
