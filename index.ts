/**
 * Stars Giveaway Bot — entry point with self-healing.
 * Polls AltGram for updates + runs cron to finalize ended giveaways.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { altgram } from './src/altgram'
import { handleUpdate, checkEndedGiveaways, handleCallbackDataWithDuration } from './src/handlers'
import { db } from './src/db'
import type { TgUpdate, TgUser } from './src/types'

const PORT = Number(process.env.PORT) || 3007
const POLL_TIMEOUT = 30
const RETRY_MS = 2000
const OFFSET_FILE = `${import.meta.dir}/.offset.json`
const CRON_INTERVAL_MS = 30_000  // каждые 30 сек проверяем завершённые розыгрыши

let cronRunning = true

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* Offset persistence */
function readPersistedOffset(): number {
  try {
    if (!existsSync(OFFSET_FILE)) return 0
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8')) as { offset?: string | number }
    const offset = typeof raw.offset === 'string' ? Number(raw.offset) : raw.offset
    if (typeof offset === 'number' && offset > 0) return offset
  } catch {
    return 0
  }
  return 0
}

function persistOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_FILE, JSON.stringify({ offset: String(offset) }))
  } catch { /* ignore */ }
}

/* Health-check server */
const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/' || path === '/health') {
      return new Response('OK: giveaway-bot running\n', {
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    return new Response('Not Found', { status: 404 })
  },
})
console.log(`[giveaway-bot] health-check server listening on port ${server.port}`)

/* Main function */
async function main() {
  if (!process.env.BOT_TOKEN) {
    console.error('[giveaway-bot] FATAL: BOT_TOKEN is not set (check .env)')
    process.exit(1)
  }

  // Authorize
  let me: TgUser | null = null
  for (let i = 0; i < 10; i++) {
    const res = await altgram.getMe()
    if (res.ok && res.result) {
      me = res.result
      break
    }
    console.error(`[giveaway-bot] getMe failed (attempt ${i + 1}), retrying...`)
    await sleep(RETRY_MS)
  }
  if (!me) {
    console.error('[giveaway-bot] Could not authorize after 10 attempts')
    return
  }
  console.log(`[giveaway-bot] authorized as @${me.username} (id=${me.id})`)

  // Delete webhook
  try {
    await altgram.deleteWebhook()
  } catch { /* ignore */ }
  console.log(`[giveaway-bot] deleteWebhook ok`)

  // Set commands
  await altgram.setMyCommands([
    { command: 'start', description: 'Запустить бота' },
    { command: 'newgiveaway', description: 'Создать розыгрыш' },
    { command: 'mygiveaways', description: 'Мои розыгрыши' },
    { command: 'mywins', description: 'Мои победы' },
    { command: 'mytickets', description: 'Где участвую' },
    { command: 'active', description: 'Активные розыгрыши' },
    { command: 'cancel', description: 'Отменить создание' },
    { command: 'help', description: 'Помощь' },
  ])
  console.log(`[giveaway-bot] setMyCommands ok`)

  console.log(`Bot started as @${me.username}, polling AltGram…`)

  // ПРОВЕРКА БД
  try {
    const userCount = await db.user.count()
    const giveawayCount = await db.giveaway.count()
    console.log(`[db] Подключено. Юзеров: ${userCount}, розыгрышей: ${giveawayCount}`)
  } catch (e) {
    console.error(`[db] ОШИБКА подключения к БД:`, e)
    throw e
  }

  // Long polling loop
  let offsetStr = String(readPersistedOffset())
  console.log(`[giveaway-bot] polling from offset=${offsetStr}`)

  let handled = 0

  // Параллельно запускаем cron для завершения розыгрышей
  ;(async () => {
    while (cronRunning) {
      try {
        await checkEndedGiveaways()
      } catch (e) {
        console.error('[cron] error:', e)
      }
      await sleep(CRON_INTERVAL_MS)
    }
  })()

  while (true) {
    try {
      const apiUrl = `${process.env.ALTGRAM_API_URL || 'http://188.134.95.254:2610'}/bot${process.env.BOT_TOKEN}/getUpdates`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"offset":${offsetStr},"timeout":${POLL_TIMEOUT},"allowed_updates":["message","callback_query","edited_message","channel_post"]}`,
      })

      if (!res.ok) {
        console.error(`[poll] HTTP ${res.status}, retrying...`)
        await sleep(RETRY_MS)
        continue
      }

      const data = await res.json() as { ok: boolean; result?: TgUpdate[]; error_code?: number; description?: string }

      if (!data.ok) {
        const errorCode = data.error_code || 0
        if (errorCode === 409) {
          console.log('[poll] 409 Conflict — another instance running. Waiting 60s...')
          await sleep(60_000)
        } else {
          console.error('[poll] getUpdates failed:', data.error_code, data.description)
          await sleep(RETRY_MS)
        }
        continue
      }

      const updates: TgUpdate[] = data.result ?? []
      for (const u of updates) {
        try {
          // Special handling for duration buttons (dur_N)
          if (u.callback_query && u.callback_query.data?.startsWith('dur_')) {
            try { await altgram.answerCallbackQuery({ callback_query_id: u.callback_query.id }) } catch {}
            await handleCallbackDataWithDuration(u.callback_query)
          } else {
            offsetStr = String(BigInt(u.update_id) + 1n)
            persistOffset(Number(offsetStr))
            handled++
            await handleUpdate(u)
          }
        } catch (e) {
          console.error('[poll] handler error for update', u.update_id, e)
        }
      }

      // Update offset even for special handlers
      if (updates.length > 0) {
        const lastUpdate = updates[updates.length - 1]
        offsetStr = String(BigInt(lastUpdate.update_id) + 1n)
        persistOffset(Number(offsetStr))
        console.log(`[poll] processed ${updates.length} update(s), offset=${offsetStr}, total=${handled}`)
      }
    } catch (e) {
      const errorMsg = String(e)
      if (errorMsg.includes('ConnectionRefused') || errorMsg.includes('ECONNRESET') || errorMsg.includes('Unable to connect')) {
        console.error('[poll] AltGram server unreachable, waiting 15s...')
        await sleep(15_000)
      } else {
        console.error('[poll] unexpected error:', e)
        await sleep(RETRY_MS * 2)
      }
    }
  }
}

// Graceful shutdown
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[giveaway-bot] received ${signal}, shutting down…`)
  server.stop(true)
  cronRunning = false
  setTimeout(() => process.exit(0), 500).unref?.()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGPIPE', () => {})

// Auto-restart on fatal
main().catch(async (e) => {
  console.error('[giveaway-bot] fatal error:', e)
  console.log('[giveaway-bot] restarting in 10 seconds...')
  await sleep(10_000)
  main().catch((e2) => {
    console.error('[giveaway-bot] second fatal, giving up:', e2)
    process.exit(1)
  })
})

process.on('unhandledRejection', (reason) => {
  console.error('[giveaway-bot] unhandledRejection:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[giveaway-bot] uncaughtException:', err)
})
