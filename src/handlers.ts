/**
 * Stars Giveaway Bot — command & button handlers.
 *
 * Only channel OWNERS can create giveaways.
 * Anyone can participate. Winners picked via crypto random.
 */

import { db } from './db'
import { altgram, md, type TgInlineKeyboardMarkup, type TgEntity } from './altgram'
import { randomInt } from 'crypto'
import type { TgCallbackQuery, TgMessage, TgUpdate, TgUser } from './types'

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'xyz').toLowerCase()

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(
  chatId: number | string,
  text: string,
  replyMarkup?: TgInlineKeyboardMarkup,
  replyTo?: number
) {
  const { text: plain, entities } = md(text)
  return altgram.sendMessage({
    chat_id: chatId,
    text: plain,
    entities,
    reply_markup: replyMarkup,
    reply_to_message_id: replyTo,
  })
}

function isPrivate(msg: TgMessage): boolean {
  return msg.chat.type === 'private'
}

async function upsertUser(from: TgUser) {
  const isAdminFlag = from.username?.toLowerCase() === ADMIN_USERNAME
  const existing = await db.user.findUnique({ where: { tgId: String(from.id) } })
  if (!existing) {
    const user = await db.user.create({
      data: {
        tgId: String(from.id),
        username: from.username?.toLowerCase() ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        isAdmin: isAdminFlag,
      },
    })
    return user
  }
  return db.user.update({
    where: { tgId: String(from.id) },
    data: {
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      ...(isAdminFlag || existing.isAdmin ? { isAdmin: true } : {}),
    },
  })
}

/* ------------------------------------------------------------------ */
/* Update dispatch                                                     */
/* ------------------------------------------------------------------ */

export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query)
      return
    }

    const msg = update.message ?? update.edited_message
    if (!msg) return

    if (update.edited_message) return

    // Forward-сообщение (пересылка поста из канала) — обрабатываем отдельно
    // ВАЖНО: AltGram getChat не работает с @username, нужно получать chat_id из forward
    if (msg.forward_from_chat || msg.forward_origin || msg.forward_from) {
      const handled = await handleForwardMessage(msg)
      if (handled) {
        // Уже обработали — не вызываем остальные обработчики
        return
      }
    }

    if (msg.text) {
      await handleTextMessage(msg)
    } else if (msg.photo || msg.video || msg.animation || msg.document) {
      // Может быть медиа для создания розыгрыша (мастер)
      await handleMediaMessage(msg)
    }
  } catch (e) {
    console.error('[handler] error processing update:', update.update_id, e)
    try {
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id
      if (chatId) {
        const errMsg = e instanceof Error ? e.message : String(e)
        await altgram.sendMessage({
          chat_id: chatId,
          text: `❌ Внутренняя ошибка.\n\nДетали: ${errMsg.slice(0, 300)}`,
        })
      }
    } catch { /* ignore */ }
  }
}

async function handleTextMessage(msg: TgMessage) {
  const from = msg.from
  if (!from || from.is_bot) return

  const rawText = (msg.text ?? '').trim()
  const senderName = from.username ? `@${from.username}` : (from.first_name || `id:${from.id}`)
  console.log(`[msg] ${senderName} (${from.id}): "${rawText.slice(0, 100)}"`)

  if (!isPrivate(msg)) {
    // В группе/канале бот не отвечает на текстовые команды
    return
  }

  const user = await upsertUser(from)

  if (user.isBanned) {
    await send(msg.chat.id, '🚫 Вы заблокированы.')
    return
  }

  const raw = (msg.text ?? '').trim()
  const parts = raw.split(/\s+/)
  const head = parts[0] ?? ''
  const cmd = (head.split('@')[0] ?? '').toLowerCase()

  // Check if user is in giveaway creation session
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (session && !cmd.startsWith('/cancel')) {
    await handleSessionStep(msg, user, session, raw)
    return
  }

  switch (cmd) {
    case '/start':
      await sendWelcome(msg, user)
      break
    case '/help':
      await sendHelp(msg, user)
      break
    case '/newgiveaway':
      await startGiveawayCreation(msg, user)
      break
    case '/cancel':
      await db.session.deleteMany({ where: { tgId: user.tgId } })
      await send(msg.chat.id, '❌ Создание розыгрыша отменено.')
      break
    case '/mygiveaways':
      await handleMyGiveaways(msg, user)
      break
    case '/mywins':
      await handleMyWins(msg, user)
      break
    case '/mytickets':
      await handleMyTickets(msg, user)
      break
    case '/active':
      await handleActiveGiveaways(msg, user)
      break
    case '/listgiveaways':
      await handleActiveGiveaways(msg, user)
      break
    default:
      if (cmd.startsWith('/')) {
        await send(msg.chat.id, '🤔 Неизвестная команда. /help — список команд.')
      }
  }
}

async function handleForwardMessage(msg: TgMessage): Promise<boolean> {
  const from = msg.from
  if (!from || from.is_bot || !isPrivate(msg)) return false

  const user = await upsertUser(from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session) {
    // Не в сессии — пересылка игнорируется
    return false
  }

  console.log(`[forward] user=${user.tgId} step=${session.step} forward_from_chat=${!!msg.forward_from_chat} forward_origin=${!!msg.forward_origin}`)

  // Шаг 7 — пересылка поста из канала
  if (session.step === 'step7_channel') {
    // Извлекаем chat_id из forward-сообщения
    let channelId: number | null = null
    let channelUsername: string | null = null
    let channelTitle: string | null = null

    if (msg.forward_from_chat) {
      channelId = msg.forward_from_chat.id
      channelUsername = msg.forward_from_chat.username ?? null
      channelTitle = msg.forward_from_chat.title ?? null
    }
    if (!channelId && msg.forward_origin?.chat) {
      channelId = msg.forward_origin.chat.id
      channelUsername = msg.forward_origin.chat.username ?? null
      channelTitle = msg.forward_origin.chat.title ?? null
    }

    console.log(`[forward] extracted: channelId=${channelId} username=${channelUsername} title=${channelTitle}`)

    if (!channelId) {
      const kb: TgInlineKeyboardMarkup = {
        inline_keyboard: [[{ text: '❌ Отменить', callback_data: 'cancelsess' }]],
      }
      await send(msg.chat.id, '⚠️ Не удалось получить chat_id канала. Возможно это пересылка из приватного чата.\n\nПерешли пост из **публичного** канала, где ты владелец.', kb)
      return true
    }

    // Вызываем handleSessionStep с forward-сообщением (msg вместо текста)
    await handleSessionStep(msg, user, session, '')
    return true
  }

  // Шаг 6 — медиа из пересланного поста тоже может подойти для шага 6
  if (session.step === 'step6_media') {
    // Проверим есть ли фото/видео
    if (msg.photo || msg.video || msg.animation) {
      await handleMediaMessage(msg)
      return true
    }
  }

  return false
}

async function handleMediaMessage(msg: TgMessage) {
  const from = msg.from
  if (!from || from.is_bot || !isPrivate(msg)) return

  const user = await upsertUser(from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session) {
    // Не в сессии — игнорируем медиа
    return
  }

  // Шаг 7 — пересылка поста из канала (forward)
  if (session.step === 'step7_channel' && (msg.forward_from_chat || msg.forward_origin)) {
    await handleSessionStep(msg, user, session, '')
    return
  }

  // В сессии, шаг 6 — добавление медиа
  if (session.step !== 'step6_media') {
    return
  }

  let mediaType: string | null = null
  let mediaFileId: string | null = null

  if (msg.photo && msg.photo.length > 0) {
    mediaType = 'photo'
    mediaFileId = msg.photo[msg.photo.length - 1].file_id  // самое большое
  } else if (msg.video) {
    mediaType = 'video'
    mediaFileId = msg.video.file_id
  } else if (msg.animation) {
    mediaType = 'animation'
    mediaFileId = msg.animation.file_id
  } else if (msg.document) {
    mediaType = 'document'
    mediaFileId = msg.document.file_id
  }

  if (!mediaFileId) {
    await send(msg.chat.id, '⚠️ Не удалось получить файл. Попробуй ещё раз или отправь /skip')
    return
  }

  const data = JSON.parse(session.data)
  data.mediaType = mediaType
  data.mediaFileId = mediaFileId

  await db.session.update({
    where: { tgId: user.tgId },
    data: {
      step: 'step7_channel',
      data: JSON.stringify(data),
    },
  })

  await send(msg.chat.id, `✅ Медиа добавлено (${mediaType}).\n\nШаг 7/7: Пришли @username канала\n\n⚠️ Ты должен быть **владельцем** канала, а бот должен быть админом канала.`)
}

/* ------------------------------------------------------------------ */
/* Welcome + main menu                                                */
/* ------------------------------------------------------------------ */

async function sendWelcome(msg: TgMessage, user: { id: string; username: string | null; firstName: string | null; isAdmin: boolean }) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: '🎁 Создать розыгрыш', callback_data: 'new' }],
      [{ text: '📋 Мои розыгрыши', callback_data: 'mygiveaways' }, { text: '🏆 Мои победы', callback_data: 'mywins' }],
      [{ text: '🎟️ Где участвую', callback_data: 'mytickets' }, { text: '🔥 Активные', callback_data: 'active' }],
    ],
  }
  await send(
    msg.chat.id,
    [
      `👋 Привет, **${user.firstName || user.username || 'друг'}**!`,
      ``,
      `🎁 Я бот для розыгрышей в Telegram-каналах.`,
      ``,
      `**Что я умею:**`,
      `• Создавать розыгрыши (только для владельцев каналов)`,
      `• Принимать участия кнопкой`,
      `• Честно выбирать победителей (crypto random)`,
      `• Публиковать результаты в канал`,
      ``,
      `Нажми кнопку ниже или отправь /newgiveaway`,
    ].join('\n'),
    kb
  )
}

async function sendHelp(msg: TgMessage, user: { isAdmin: boolean }) {
  const text = [
    `📖 **Помощь по Stars Giveaway Bot**`,
    ``,
    `**Для всех:**`,
    `• /newgiveaway — создать розыгрыш (нужен канал)`,
    `• /mygiveaways — мои розыгрыши`,
    `• /mywins — где я победил`,
    `• /mytickets — где участвую`,
    `• /active — активные розыгрыши`,
    `• /cancel — отменить создание`,
    `• /help — эта справка`,
    ``,
    `**Как создать розыгрыш:**`,
    `1. Ты должен быть **владельцем** Telegram-канала`,
    `2. Добавь бота в **администраторы** канала`,
    `3. Дай боту право **публиковать посты**`,
    `4. Отправь /newgiveaway и следуй шагам`,
    ``,
    `**Как участвовать:**`,
    `Жми кнопку "🎉 Участвовать" под постом розыгрыша`,
  ]
  if (user.isAdmin) {
    text.push(``, `**Админ:**`, `• Ты уже админ бота`)
  }
  await send(msg.chat.id, text.join('\n'))
}

/* ------------------------------------------------------------------ */
/* Giveaway creation master (session)                                  */
/* ------------------------------------------------------------------ */

async function startGiveawayCreation(msg: TgMessage, user: { id: string; tgId: string }) {
  if (!isPrivate(msg)) {
    await send(msg.chat.id, '🔒 Создавать розыгрыши можно только в личке с ботом.')
    return
  }

  // Удаляем старую сессию если есть
  await db.session.deleteMany({ where: { tgId: user.tgId } })

  // Создаём новую
  await db.session.create({
    data: {
      tgId: user.tgId,
      step: 'step1_title',
      data: '{}',
    },
  })

  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: '❌ Отменить', callback_data: 'cancelsess' }]],
  }

  await send(
    msg.chat.id,
    [
      `🎁 **Создание розыгрыша**`,
      ``,
      `Шаг 1/7: Что разыгрываем?`,
      ``,
      `Отправь **краткое название** приза.`,
      `Например: «iPhone 15 Pro», «1000 рублей», «Ключ от Steam»`,
    ].join('\n'),
    kb
  )
}

async function handleSessionStep(
  msg: TgMessage,
  user: { id: string; tgId: string; username: string | null; firstName: string | null },
  session: { id: string; step: string; data: string },
  input: string
) {
  const data = JSON.parse(session.data)
  const cancelKb: TgInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: '❌ Отменить', callback_data: 'cancelsess' }]],
  }

  switch (session.step) {
    case 'step1_title': {
      const title = input.trim().slice(0, 100)
      if (title.length < 2) {
        await send(msg.chat.id, '⚠️ Название слишком короткое. Попробуй ещё раз.', cancelKb)
        return
      }
      data.title = title
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'step2_desc', data: JSON.stringify(data) },
      })
      await send(
        msg.chat.id,
        [
          `✅ Название: **${title}**`,
          ``,
          `Шаг 2/7: Описание`,
          ``,
          `Опиши приз подробнее: состояние, доставку, и т.д.`,
          `Например: «Новый, в упаковке. Доставка по РФ бесплатно.»`,
        ].join('\n'),
        cancelKb
      )
      break
    }

    case 'step2_desc': {
      const description = input.trim().slice(0, 1000)
      if (description.length < 5) {
        await send(msg.chat.id, '⚠️ Описание слишком короткое. Попробуй ещё раз.', cancelKb)
        return
      }
      data.description = description
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'step3_requirements', data: JSON.stringify(data) },
      })
      await send(
        msg.chat.id,
        [
          `✅ Описание сохранено`,
          ``,
          `Шаг 3/7: Условия для участников`,
          ``,
          `Что должны сделать участники?`,
          ``,
          `Просто напиши текст условий.`,
          `Например: «Подписка на @channel + репост»`,
          `Или «Просто нажми кнопку»`,
        ].join('\n'),
        cancelKb
      )
      break
    }

    case 'step3_requirements': {
      const requirements = input.trim().slice(0, 500)
      data.requirements = requirements
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'step3_subs', data: JSON.stringify(data) },
      })
      const kb: TgInlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: '✅ Да, добавить каналы', callback_data: 'subs:yes' },
            { text: '⏭️ Без подписок', callback_data: 'subs:no' },
          ],
          [{ text: '❌ Отменить', callback_data: 'cancelsess' }],
        ],
      }
      await send(
        msg.chat.id,
        [
          `✅ Условия сохранены`,
          ``,
          `Шаг 3.5: Подписки на каналы`,
          ``,
          `Хочешь ли ты требовать подписку на каналы?`,
          ``,
          `Если **да** — напиши @username каналов через пробел:`,
          `Например: \`@channel1 @channel2\``,
          ``,
          `Бот будет проверять подписку каждого участника.`,
        ].join('\n'),
        kb
      )
      break
    }

    case 'step3_subs_input': {
      // Юзер ввёл @username каналов через пробел
      const channels = input.trim().split(/\s+/)
        .map(c => c.replace(/^@/, '').toLowerCase())
        .filter(c => c.length >= 3)
      if (channels.length === 0) {
        await send(msg.chat.id, '⚠️ Не понял. Напиши @username каналов через пробел.\nНапример: `@channel1 @channel2`', cancelKb)
        return
      }
      data.requiredChannels = channels
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'step4_winners', data: JSON.stringify(data) },
      })
      await send(
        msg.chat.id,
        [
          `✅ Подписки добавлены:`,
          ...channels.map(c => `• @${c}`),
          ``,
          `Шаг 4/7: Сколько победителей?`,
        ].join('\n'),
        {
          inline_keyboard: [
            [
              { text: '1', callback_data: 'winners:1' },
              { text: '3', callback_data: 'winners:3' },
              { text: '5', callback_data: 'winners:5' },
              { text: '10', callback_data: 'winners:10' },
            ],
            [{ text: '❌ Отменить', callback_data: 'cancelsess' }],
          ],
        }
      )
      break
    }

    case 'step4_winners': {
      const n = parseInt(input.trim())
      if (isNaN(n) || n < 1 || n > 100) {
        await send(msg.chat.id, '⚠️ Введи число от 1 до 100.', cancelKb)
        return
      }
      data.winnersCount = n
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'step5_endtype', data: JSON.stringify(data) },
      })
      const kb: TgInlineKeyboardMarkup = {
        inline_keyboard: [
          [
            { text: '⏰ По времени', callback_data: 'endtype:time' },
            { text: '🔘 Вручную', callback_data: 'endtype:manual' },
          ],
          [
            { text: '👥 По кол-ву участников', callback_data: 'endtype:participants' },
          ],
          [{ text: '❌ Отменить', callback_data: 'cancelsess' }],
        ],
      }
      await send(
        msg.chat.id,
        [
          `✅ Победителей: ${n}`,
          ``,
          `Шаг 5/7: Как завершить розыгрыш?`,
          ``,
          `⏰ **По времени** — завершится сам`,
          `🔘 **Вручную** — по кнопке владельца`,
          `👥 **По участникам** — после N участников`,
        ].join('\n'),
        kb
      )
      break
    }

    case 'step5_endtype_time': {
      // ожидаем длительность: 1h, 24h, 7d, или дату
      const m = input.trim().toLowerCase().match(/^(\d+)([hмdдwнminмин]+)$/)
      let endsAt: Date | null = null
      if (m) {
        const num = parseInt(m[1])
        const unit = m[2]
        const now = new Date()
        if (unit.startsWith('h') || unit.startsWith('м')) {
          if (unit.includes('ин') || unit.includes('min')) {
            endsAt = new Date(now.getTime() + num * 60 * 1000)
          } else {
            endsAt = new Date(now.getTime() + num * 60 * 60 * 1000)
          }
        } else if (unit.startsWith('d') || unit.startsWith('д')) {
          endsAt = new Date(now.getTime() + num * 24 * 60 * 60 * 1000)
        } else if (unit.startsWith('w') || unit.startsWith('н')) {
          endsAt = new Date(now.getTime() + num * 7 * 24 * 60 * 60 * 1000)
        }
      }
      // Также принимаем простые числа
      if (!endsAt) {
        const n = parseInt(input.trim())
        if (!isNaN(n)) {
          endsAt = new Date(Date.now() + n * 60 * 60 * 1000) // n часов
        }
      }
      if (!endsAt) {
        await send(msg.chat.id, '⚠️ Не понял формат. Примеры: 1h, 24h, 7d, 30min. Или просто число часов.', cancelKb)
        return
      }
      data.endType = 'time'
      data.endsAt = endsAt.toISOString()
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'step6_media', data: JSON.stringify(data) },
      })
      const kb: TgInlineKeyboardMarkup = {
        inline_keyboard: [[{ text: '⏭️ Без медиа', callback_data: 'skip' }]],
      }
      await send(
        msg.chat.id,
        [
          `✅ Завершится: ${endsAt.toLocaleString('ru-RU')}`,
          ``,
          `Шаг 6/7: Медиа (опционально)`,
          ``,
          `Пришли фото или видео для поста, или нажми «⏭️ Без медиа».`,
        ].join('\n'),
        kb
      )
      break
    }

    case 'step5_endtype_participants': {
      // ожидаем число участников для завершения
      const n = parseInt(input.trim())
      if (isNaN(n) || n < 1 || n > 100000) {
        await send(msg.chat.id, '⚠️ Введи число от 1 до 100000.', cancelKb)
        return
      }
      data.endType = 'participants'
      data.maxParticipants = n
      data.endsAt = null
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'step6_media', data: JSON.stringify(data) },
      })
      const kb: TgInlineKeyboardMarkup = {
        inline_keyboard: [[{ text: '⏭️ Без медиа', callback_data: 'skip' }]],
      }
      await send(
        msg.chat.id,
        [
          `✅ Завершится после ${n} участников`,
          ``,
          `Шаг 6/7: Медиа (опционально)`,
          ``,
          `Пришли фото или видео для поста, или нажми «⏭️ Без медиа».`,
        ].join('\n'),
        kb
      )
      break
    }

    case 'step7_channel': {
      // Шаг 7 — ввод @username канала
      const cancelKb: TgInlineKeyboardMarkup = {
        inline_keyboard: [[{ text: '❌ Отменить', callback_data: 'cancelsess' }]],
      }
      
      const channelArg = input.trim()
      if (!channelArg) {
        await send(msg.chat.id, '⚠️ Пришли @username канала.\nНапример: `@mychannel`', cancelKb)
        return
      }
      
      const channelUsername = channelArg.replace(/^@/, '').toLowerCase()
      if (channelUsername.length < 3) {
        await send(msg.chat.id, '⚠️ Слишком короткое имя. Пришли @username канала.', cancelKb)
        return
      }

      data.channelUsername = channelUsername
      await db.session.update({
        where: { tgId: user.tgId },
        data: { step: 'publishing', data: JSON.stringify(data) },
      })

      await send(msg.chat.id, `🔍 Проверяю что ты владелец @${channelUsername}...\n\n⏳ Это может занять несколько секунд.`)

      // Проверяем через getChatMember с @username (бот должен быть админом канала!)
      try {
        const memberRes = await altgram.getChatMember({
          chat_id: `@${channelUsername}`,
          user_id: Number(user.tgId),
        })
        console.log(`[channel] getChatMember for @${channelUsername}:`, JSON.stringify(memberRes).slice(0, 300))

        if (!memberRes.ok || !memberRes.result) {
          await send(
            msg.chat.id,
            [
              `❌ Не удалось проверить твой статус в @${channelUsername}.`,
              ``,
              `**Возможные причины:**`,
              `• Бот НЕ добавлен в админы @${channelUsername}`,
              `• Канал приватный или удалён`,
              ``,
              `**Что делать:**`,
              `1. Открой @${channelUsername}`,
              `2. Управление → Администраторы`,
              `3. Добавь бота с правом публикации постов`,
              `4. Попробуй снова: /newgiveaway`,
              ``,
              `Ошибка: ${memberRes.description || 'неизвестно'}`,
            ].join('\n'),
            cancelKb
          )
          await db.session.deleteMany({ where: { tgId: user.tgId } })
          return
        }

        const status = memberRes.result.status
        if (status !== 'creator' && status !== 'administrator') {
          await send(
            msg.chat.id,
            [
              `❌ Ты не владелец @${channelUsername}.`,
              ``,
              `Твой статус: **${status}**`,
              `Только владелец (creator) или админ канала может создавать розыгрыши.`,
            ].join('\n'),
            cancelKb
          )
          await db.session.deleteMany({ where: { tgId: user.tgId } })
          return
        }

        if (status === 'administrator' && memberRes.result.can_post_messages === false) {
          await send(
            msg.chat.id,
            `❌ Ты админ @${channelUsername}, но без права публикации постов. Попроси владельца дать тебе это право.`,
            cancelKb
          )
          await db.session.deleteMany({ where: { tgId: user.tgId } })
          return
        }

        // ОК — можно создавать!
        await send(msg.chat.id, `✅ Ты ${status === 'creator' ? 'владелец' : 'админ'} @${channelUsername}. Создаю розыгрыш...`)
      } catch (e) {
        await send(msg.chat.id, `❌ Ошибка проверки канала: ${e instanceof Error ? e.message : String(e)}`, cancelKb)
        await db.session.deleteMany({ where: { tgId: user.tgId } })
        return
      }

      // Создаём розыгрыш
      await publishGiveaway(msg, user, data)
      break
    }

    default:
      await send(msg.chat.id, '⚠️ Неизвестный шаг. Отправь /cancel и начни заново.')
  }
}

async function publishGiveaway(
  msg: TgMessage,
  user: { id: string; tgId: string; username: string | null; firstName: string | null },
  data: {
    title: string
    description: string
    requirements: string
    winnersCount: number
    endType: string
    endsAt?: string
    maxParticipants?: number
    mediaType?: string
    mediaFileId?: string
    channelUsername: string
    channelChatId?: number
    channelTitle?: string | null
    requiredChannels?: string[]
  }
) {
  // Если есть requiredChannels, добавим их в requirements текстом
  let fullRequirements = data.requirements
  if (data.requiredChannels && data.requiredChannels.length > 0) {
    const subsLine = data.requiredChannels.map(c => `• Подписка на @${c}`).join('\n')
    fullRequirements = `${data.requirements}\n\n${subsLine}`
  }

  // Создаём запись в БД
  const giveaway = await db.giveaway.create({
    data: {
      title: data.title,
      description: data.description,
      requirements: fullRequirements,
      winnersCount: data.winnersCount,
      endType: data.endType,
      endsAt: data.endsAt ? new Date(data.endsAt) : null,
      maxParticipants: data.maxParticipants ?? null,
      mediaType: data.mediaType ?? null,
      mediaFileId: data.mediaFileId ?? null,
      channelUsername: data.channelUsername,
      channelId: data.channelChatId ? String(data.channelChatId) : null,
      ownerTgId: user.tgId,
      requiredChannels: data.requiredChannels ? JSON.stringify(data.requiredChannels) : null,
    },
  })

  // Публикуем в канал
  const giveawayText = buildGiveawayText(giveaway, 0)
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: '🎉 Участвовать (0)', callback_data: `join:${giveaway.id}` }],
    ],
  }

  try {
    let postedMessage: { message_id: number } | null = null

    if (data.mediaFileId && data.mediaType === 'photo') {
      const res = await altgram.sendPhoto({
        chat_id: data.channelChatId ?? `@${data.channelUsername}`,
        photo: data.mediaFileId,
        caption: giveawayText,
        reply_markup: kb,
      })
      if (res.ok && res.result) postedMessage = { message_id: res.result.message_id }
    } else if (data.mediaFileId && data.mediaType === 'video') {
      const res = await altgram.sendVideo({
        chat_id: data.channelChatId ?? `@${data.channelUsername}`,
        video: data.mediaFileId,
        caption: giveawayText,
        reply_markup: kb,
      })
      if (res.ok && res.result) postedMessage = { message_id: res.result.message_id }
    } else if (data.mediaFileId && data.mediaType === 'animation') {
      const res = await altgram.sendAnimation({
        chat_id: data.channelChatId ?? `@${data.channelUsername}`,
        animation: data.mediaFileId,
        caption: giveawayText,
        reply_markup: kb,
      })
      if (res.ok && res.result) postedMessage = { message_id: res.result.message_id }
    } else {
      const { text: plain, entities } = md(giveawayText)
      const res = await altgram.sendMessage({
        chat_id: data.channelChatId ?? `@${data.channelUsername}`,
        text: plain,
        entities,
        reply_markup: kb,
      })
      if (res.ok && res.result) postedMessage = { message_id: res.result.message_id }
    }

    if (!postedMessage) {
      await send(msg.chat.id, `❌ Не удалось опубликовать пост в @${data.channelUsername}. Убедись что бот админ канала с правом постить.`)
      await db.giveaway.delete({ where: { id: giveaway.id } })
      await db.session.deleteMany({ where: { tgId: user.tgId } })
      return
    }

    // Сохраняем messageId и channelId
    await db.giveaway.update({
      where: { id: giveaway.id },
      data: {
        messageTgId: String(postedMessage.message_id),
        channelId: String(data.channelUsername), // для каналов используем @username
      },
    })

    // Удаляем сессию
    await db.session.deleteMany({ where: { tgId: user.tgId } })

    const endInfo = data.endType === 'time' 
      ? `⏰ Завершится: ${new Date(data.endsAt!).toLocaleString('ru-RU')}`
      : data.endType === 'participants'
      ? `👥 Завершится после ${data.maxParticipants} участников`
      : `🔘 Завершение вручную`

    // Кнопки управления для владельца
    const manageKb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '🔚 Завершить сейчас', callback_data: `end:${giveaway.id}` },
          { text: '❌ Отменить', callback_data: `cancel:${giveaway.id}` },
        ],
        [
          { text: '📊 Участники', callback_data: `participants:${giveaway.id}` },
        ],
      ],
    }

    await send(
      msg.chat.id,
      [
        `✅ **Розыгрыш опубликован!**`,
        ``,
        `🎁 **${data.title}**`,
        `📢 Канал: @${data.channelUsername}`,
        `👥 Победителей: ${data.winnersCount}`,
        endInfo,
        ``,
        `ID: \`${giveaway.id}\``,
        ``,
        `Управление:`,
      ].join('\n'),
      manageKb
    )
  } catch (e) {
    await send(msg.chat.id, `❌ Ошибка публикации: ${e instanceof Error ? e.message : String(e)}`)
    await db.giveaway.delete({ where: { id: giveaway.id } })
    await db.session.deleteMany({ where: { tgId: user.tgId } })
  }
}

function buildGiveawayText(
  giveaway: {
    title: string
    description: string
    requirements: string
    winnersCount: number
    endType: string
    endsAt: Date | null
    maxParticipants: number | null
    channelUsername: string
  },
  participantsCount: number,
  winners?: { username: string | null; firstName: string | null; tgId: string; place: number }[]
): string {
  if (winners && winners.length > 0) {
    const winLines = winners.map(w => {
      const name = w.username ? `@${w.username}` : (w.firstName || `id:${w.tgId}`)
      return `${w.place === 1 ? '🏆' : '🥈'} ${w.place}. ${name}`
    }).join('\n')
    return [
      `🎁 РОЗЫГРЫШ ЗАВЕРШЁН: ${giveaway.title}`,
      ``,
      `🏆 **Победители:**`,
      winLines,
      ``,
      `👥 Участников: ${participantsCount}`,
      `👑 Организатор: @${giveaway.channelUsername}`,
      ``,
      `Спасибо всем кто участвовал!`,
    ].join('\n')
  }

  let endInfo: string
  if (giveaway.endType === 'time' && giveaway.endsAt) {
    endInfo = `⏰ Завершится: ${giveaway.endsAt.toLocaleString('ru-RU')}`
  } else if (giveaway.endType === 'participants' && giveaway.maxParticipants) {
    const remaining = Math.max(0, giveaway.maxParticipants - participantsCount)
    endInfo = `👥 Завершится: после ${giveaway.maxParticipants} участников (осталось ${remaining})`
  } else {
    endInfo = `🔘 Завершение: вручную (по решению владельца)`
  }

  return [
    `🎁 РОЗЫГРЫШ: ${giveaway.title}`,
    ``,
    `**${giveaway.description}**`,
    ``,
    `📋 **Условия:**`,
    giveaway.requirements,
    ``,
    `🏆 Победителей: ${giveaway.winnersCount}`,
    endInfo,
    `👑 Организатор: @${giveaway.channelUsername}`,
    ``,
    `👥 Участников: ${participantsCount}`,
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* Callback query handler                                              */
/* ------------------------------------------------------------------ */

async function handleCallbackQuery(cq: TgCallbackQuery) {
  try {
    const data = cq.data ?? ''
    const from = cq.from

    if (!from) {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: 'Ошибка' }) } catch {}
      return
    }

    // Парсим callback_data. Формат: "act:arg" или "act_arg" (для обратной совместимости)
    // Сначала пробуем ":" разделитель
    let act = data
    let arg = ''
    if (data.includes(':')) {
      [act, arg] = data.split(':')
    } else if (data.includes('_')) {
      // Формат "winners_1" → act=winners, arg=1
      const idx = data.indexOf('_')
      act = data.slice(0, idx)
      arg = data.slice(idx + 1)
    }

    console.log(`[callback] data="${data}" → act="${act}" arg="${arg}"`)

    // Для быстрых действий (navigation в ЛС) — отвечаем сразу с текстом
    if (act === 'new_giveaway' || act === 'new') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '🎁 Создаём розыгрыш...' }) } catch {}
      const fakeMsg: TgMessage = {
        message_id: 0,
        from: from,
        chat: { id: from.id, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/newgiveaway',
      }
      const user = await upsertUser(from)
      await startGiveawayCreation(fakeMsg, user)
      return
    }

    if (act === 'join') {
      await handleJoinGiveaway(cq, arg)
      return
    }

    if (act === 'winners') {
      const n = parseInt(arg)
      if (isNaN(n) || n < 1) {
        try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Ошибка' }) } catch {}
        return
      }
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: `✅ Победителей: ${n}` }) } catch {}
      await setWinnersCount(cq, n)
      return
    }

    if (act === 'endtype') {
      const text = arg === 'time' ? '⏰ По времени' : arg === 'manual' ? '🔘 Вручную' : '👥 По участникам'
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text }) } catch {}
      await setEndType(cq, arg)
      return
    }

    if (act === 'subs') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: arg === 'yes' ? '✅ Да' : '⏭️ Без подписок' }) } catch {}
      await handleSubsChoice(cq, arg === 'yes')
      return
    }

    if (act === 'cancelsess') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Отменено' }) } catch {}
      const user = await upsertUser(cq.from)
      await db.session.deleteMany({ where: { tgId: user.tgId } })
      await send(cq.from.id, '❌ Создание розыгрыша отменено. Начни заново: /newgiveaway')
      return
    }

    // cancel:GIVEAWAY_ID — отмена конкретного розыгрыша (из поста управления)
    if (act === 'cancel') {
      await cancelGiveaway(cq, arg)
      return
    }

    if (act === 'cancel_ga' || act === 'cancelga') {
      await cancelGiveaway(cq, arg)
      return
    }

    if (act === 'dur') {
      const hours = parseInt(arg)
      if (isNaN(hours) || hours < 1) {
        try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Ошибка' }) } catch {}
        return
      }
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: `✅ ${hours}ч` }) } catch {}
      await handleDurationButton(cq, hours)
      return
    }

    if (act === 'maxpart') {
      const n = parseInt(arg)
      if (isNaN(n) || n < 1) {
        try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Ошибка' }) } catch {}
        return
      }
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: `✅ ${n} участников` }) } catch {}
      await handleMaxParticipantsButton(cq, n)
      return
    }

    if (act === 'skip' || act === 'skip') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '⏭️ Пропускаю медиа' }) } catch {}
      await skipMedia(cq)
      return
    }

    if (act === 'end_now' || act === 'end') {
      await endGiveawayNow(cq, arg)
      return
    }

    if (act === 'participants' || act === 'list') {
      await showParticipants(cq, arg)
      return
    }

    if (act === 'my_giveaways' || act === 'mygiveaways') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '📋' }) } catch {}
      const fakeMsg: TgMessage = {
        message_id: 0,
        from: from,
        chat: { id: from.id, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/mygiveaways',
      }
      const user = await upsertUser(from)
      await handleMyGiveaways(fakeMsg, user)
      return
    }

    if (act === 'my_wins' || act === 'mywins') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '🏆' }) } catch {}
      const fakeMsg: TgMessage = {
        message_id: 0,
        from: from,
        chat: { id: from.id, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/mywins',
      }
      const user = await upsertUser(from)
      await handleMyWins(fakeMsg, user)
      return
    }

    if (act === 'my_tickets' || act === 'mytickets') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '🎟️' }) } catch {}
      const fakeMsg: TgMessage = {
        message_id: 0,
        from: from,
        chat: { id: from.id, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/mytickets',
      }
      const user = await upsertUser(from)
      await handleMyTickets(fakeMsg, user)
      return
    }

    if (act === 'active') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '🔥' }) } catch {}
      const fakeMsg: TgMessage = {
        message_id: 0,
        from: from,
        chat: { id: from.id, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: '/active',
      }
      const user = await upsertUser(from)
      await handleActiveGiveaways(fakeMsg, user)
      return
    }

    // Неизвестный callback — отвечаем чтобы не зависал
    try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: 'Ок' }) } catch {}
  } catch (e) {
    console.error('[callback] error:', e)
    try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Ошибка' }) } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* Giveaway actions (join, end, cancel, etc.)                          */
/* ------------------------------------------------------------------ */

async function handleJoinGiveaway(cq: TgCallbackQuery, giveawayId: string) {
  const from = cq.from
  if (!from) return

  const giveaway = await db.giveaway.findUnique({
    where: { id: giveawayId },
    include: { participants: true },
  })

  if (!giveaway) {
    try {
      await altgram.answerCallbackQuery({
        callback_query_id: cq.id,
        text: '❌ Розыгрыш не найден',
        show_alert: true,
      })
    } catch {}
    return
  }

  if (giveaway.status !== 'active') {
    try {
      await altgram.answerCallbackQuery({
        callback_query_id: cq.id,
        text: '❌ Розыгрыш уже завершён',
        show_alert: true,
      })
    } catch {}
    return
  }

  // Проверяем не участвовал ли уже
  const existing = giveaway.participants.find(p => p.tgId === String(from.id))
  if (existing) {
    try {
      await altgram.answerCallbackQuery({
        callback_query_id: cq.id,
        text: `✅ Ты уже участвуешь! Участников: ${giveaway.participants.length}`,
        show_alert: true,
      })
    } catch {}
    return
  }

  // Проверяем подписки на обязательные каналы
  let requiredChannels: string[] = []
  if (giveaway.requiredChannels) {
    try {
      requiredChannels = JSON.parse(giveaway.requiredChannels)
    } catch {}
  }
  if (requiredChannels.length > 0) {
    const notSubscribed: string[] = []
    for (const ch of requiredChannels) {
      try {
        const memberRes = await altgram.getChatMember({
          chat_id: `@${ch}`,
          user_id: from.id,
        })
        console.log(`[join] check sub @${ch} for user ${from.id}:`, memberRes.ok ? memberRes.result?.status : 'failed')
        if (!memberRes.ok || !memberRes.result) {
          // Не удалось проверить — считаем что не подписан
          notSubscribed.push(ch)
        } else {
          const status = memberRes.result.status
          if (status !== 'member' && status !== 'administrator' && status !== 'creator') {
            notSubscribed.push(ch)
          }
        }
      } catch (e) {
        console.error(`[join] getChatMember error for @${ch}:`, e)
        notSubscribed.push(ch)
      }
    }

    if (notSubscribed.length > 0) {
      const channelList = notSubscribed.map(c => `@${c}`).join(', ')
      try {
        await altgram.answerCallbackQuery({
          callback_query_id: cq.id,
          text: `❌ Подпишись на: ${channelList}`,
          show_alert: true,
        })
      } catch {}
      // Отправим подробное сообщение в ЛС
      try {
        const subButtons = notSubscribed.map(c => [{ text: `📢 @${c}`, url: `https://t.me/${c}` }])
        await send(
          from.id,
          [
            `❌ **Подпишись чтобы участвовать**`,
            ``,
            `Для участия в розыгрыше **${giveaway.title}** нужно подписаться:`,
            ...notSubscribed.map(c => `• @${c}`),
            ``,
            `После подписки нажми «Участвовать» ещё раз.`,
          ].join('\n'),
          { inline_keyboard: subButtons }
        )
      } catch {}
      return
    }
  }

  // Создаём участника
  await db.participant.create({
    data: {
      giveawayId: giveaway.id,
      tgId: String(from.id),
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
    },
  })

  await db.giveaway.update({
    where: { id: giveaway.id },
    data: { totalTickets: { increment: 1 } },
  })

  // Обновляем пост в канале
  await updateGiveawayPost(giveaway.id)

  // Если завершение по кол-ву участников — проверим
  if (giveaway.endType === 'participants' && giveaway.maxParticipants) {
    const updated = await db.giveaway.findUnique({ where: { id: giveaway.id } })
    if (updated && updated.totalTickets >= giveaway.maxParticipants) {
      // Завершаем розыгрыш
      try {
        await altgram.answerCallbackQuery({
          callback_query_id: cq.id,
          text: `🎉 Ты последний участник! Завершаю розыгрыш...`,
        })
      } catch {}
      await finalizeGiveaway(giveaway.id)
      return
    }
  }

  try {
    await altgram.answerCallbackQuery({
      callback_query_id: cq.id,
      text: `✅ Ты участвуешь! Удачи!`,
    })
  } catch {}

  // Уведомляем участника в ЛС
  try {
    await send(
      from.id,
      [
        `🎉 Ты участвуешь в розыгрыше!`,
        ``,
        `🎁 **${giveaway.title}**`,
        `👑 Организатор: @${giveaway.channelUsername}`,
        `🏆 Победителей: ${giveaway.winnersCount}`,
        giveaway.endType === 'time' && giveaway.endsAt
          ? `⏰ Завершится: ${giveaway.endsAt.toLocaleString('ru-RU')}`
          : `🔘 Завершение: вручную`,
      ].join('\n')
    )
  } catch { /* ignore — может быть закрыл ЛС */ }
}

async function updateGiveawayPost(giveawayId: string) {
  const giveaway = await db.giveaway.findUnique({
    where: { id: giveawayId },
    include: { winners: true },
  })
  if (!giveaway || !giveaway.messageTgId || !giveaway.channelId) return

  const text = buildGiveawayText(giveaway, giveaway.totalTickets, giveaway.winners as any)
  const kb: TgInlineKeyboardMarkup = giveaway.status === 'active'
    ? {
        inline_keyboard: [
          [{ text: `🎉 Участвовать (${giveaway.totalTickets})`, callback_data: `join:${giveaway.id}` }],
        ],
      }
    : { inline_keyboard: [] }

  try {
    if (giveaway.mediaFileId && giveaway.mediaType === 'photo') {
      const { text: plain, entities } = md(text)
      await altgram.editMessageCaption({
        chat_id: giveaway.channelId,
        message_id: Number(giveaway.messageTgId),
        caption: plain,
        caption_entities: entities,
        reply_markup: kb,
      })
    } else if (giveaway.mediaFileId && (giveaway.mediaType === 'video' || giveaway.mediaType === 'animation')) {
      const { text: plain, entities } = md(text)
      await altgram.editMessageCaption({
        chat_id: giveaway.channelId,
        message_id: Number(giveaway.messageTgId),
        caption: plain,
        caption_entities: entities,
        reply_markup: kb,
      })
    } else {
      const { text: plain, entities } = md(text)
      await altgram.editMessageText({
        chat_id: giveaway.channelId,
        message_id: Number(giveaway.messageTgId),
        text: plain,
        entities,
        reply_markup: kb,
      })
    }
  } catch (e) {
    console.error('[updatePost] error:', e)
  }
}

async function setWinnersCount(cq: TgCallbackQuery, n: number) {
  const user = await upsertUser(cq.from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session || session.step !== 'step4_winners') {
    await send(cq.from.id, '⚠️ Сессия устарела. Начни заново: /newgiveaway')
    return
  }
  const data = JSON.parse(session.data)
  data.winnersCount = n
  await db.session.update({
    where: { tgId: user.tgId },
    data: { step: 'step5_endtype', data: JSON.stringify(data) },
  })

  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [
        { text: '⏰ По времени', callback_data: 'endtype:time' },
        { text: '🔘 Вручную', callback_data: 'endtype:manual' },
      ],
    ],
  }
  await send(
    cq.from.id,
    [
      `✅ Победителей: ${n}`,
      ``,
      `Шаг 5/7: Как завершить розыгрыш?`,
      ``,
      `⏰ **По времени** — завершится автоматически`,
      `🔘 **Вручную** — ты нажмёшь кнопку «Завершить»`,
    ].join('\n'),
    kb
  )
}

async function setEndType(cq: TgCallbackQuery, endType: string) {
  const user = await upsertUser(cq.from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session || session.step !== 'step5_endtype') {
    await send(cq.from.id, '⚠️ Сессия устарела. Начни заново: /newgiveaway')
    return
  }
  const data = JSON.parse(session.data)

  if (endType === 'manual') {
    data.endType = 'manual'
    data.endsAt = null
    await db.session.update({
      where: { tgId: user.tgId },
      data: { step: 'step6_media', data: JSON.stringify(data) },
    })
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [[{ text: '⏭️ Без медиа', callback_data: 'skip' }]],
    }
    await send(
      cq.from.id,
      [
        `✅ Завершение: вручную (по кнопке)`,
        ``,
        `Шаг 6/7: Медиа (опционально)`,
        ``,
        `Пришли фото или видео для поста, или нажми «⏭️ Без медиа».`,
      ].join('\n'),
      kb
    )
    return
  } else if (endType === 'participants') {
    // По кол-ву участников — ждём ввод числа
    data.endType = 'participants'
    await db.session.update({
      where: { tgId: user.tgId },
      data: { step: 'step5_endtype_participants', data: JSON.stringify(data) },
    })
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '50', callback_data: 'maxpart:50' },
          { text: '100', callback_data: 'maxpart:100' },
          { text: '500', callback_data: 'maxpart:500' },
          { text: '1000', callback_data: 'maxpart:1000' },
        ],
        [{ text: '❌ Отменить', callback_data: 'cancelsess' }],
      ],
    }
    await send(
      cq.from.id,
      [
        `✅ Завершение: по кол-ву участников`,
        ``,
        `После скольки участников завершить?`,
        ``,
        `Или отправь своё число:`,
      ].join('\n'),
      kb
    )
    return
  } else {
    // time
    data.endType = 'time'
    await db.session.update({
      where: { tgId: user.tgId },
      data: { step: 'step5_endtype_time', data: JSON.stringify(data) },
    })
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '1 час', callback_data: 'dur:1' },
          { text: '6 часов', callback_data: 'dur:6' },
          { text: '24 часа', callback_data: 'dur:24' },
        ],
        [
          { text: '3 дня', callback_data: 'dur:72' },
          { text: '7 дней', callback_data: 'dur:168' },
        ],
        [{ text: '❌ Отменить', callback_data: 'cancelsess' }],
      ],
    }
    await send(
      cq.from.id,
      [
        `✅ Завершение: по времени`,
        ``,
        `Через сколько завершить?`,
        ``,
        `Или отправь свою длительность: 30min, 1h, 24h, 7d`,
      ].join('\n'),
      kb
    )
  }
}

// Обработка выбора "добавить подписки" (subs:yes / subs:no)
async function handleSubsChoice(cq: TgCallbackQuery, addSubs: boolean) {
  const user = await upsertUser(cq.from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session || session.step !== 'step3_subs') {
    await send(cq.from.id, '⚠️ Сессия устарела. Начни заново: /newgiveaway')
    return
  }
  const data = JSON.parse(session.data)

  if (!addSubs) {
    // Без подписок — сразу к шагу 4
    data.requiredChannels = []
    await db.session.update({
      where: { tgId: user.tgId },
      data: { step: 'step4_winners', data: JSON.stringify(data) },
    })
    await send(
      cq.from.id,
      [
        `✅ Без обязательных подписок`,
        ``,
        `Шаг 4/7: Сколько победителей?`,
      ].join('\n'),
      {
        inline_keyboard: [
          [
            { text: '1', callback_data: 'winners:1' },
            { text: '3', callback_data: 'winners:3' },
            { text: '5', callback_data: 'winners:5' },
            { text: '10', callback_data: 'winners:10' },
          ],
          [{ text: '❌ Отменить', callback_data: 'cancelsess' }],
        ],
      }
    )
    return
  }

  // Да — ждём ввод @username каналов
  await db.session.update({
    where: { tgId: user.tgId },
    data: { step: 'step3_subs_input', data: JSON.stringify(data) },
  })
  await send(
    cq.from.id,
    [
      `✅ Добавляем подписки`,
      ``,
      `Напиши @username каналов через пробел:`,
      `Например: \`@channel1 @channel2 @channel3\``,
      ``,
      `⚠️ Бот должен быть админом каждого канала для проверки подписки.`,
    ].join('\n'),
    {
      inline_keyboard: [[{ text: '❌ Отменить', callback_data: 'cancelsess' }]],
    }
  )
}

// Helper: handle duration buttons (dur:1, dur:6, ...)
async function handleDurationButton(cq: TgCallbackQuery, hours: number) {
  const user = await upsertUser(cq.from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session || session.step !== 'step5_endtype_time') {
    return
  }
  const data = JSON.parse(session.data)
  const endsAt = new Date(Date.now() + hours * 60 * 60 * 1000)
  data.endType = 'time'
  data.endsAt = endsAt.toISOString()
  await db.session.update({
    where: { tgId: user.tgId },
    data: { step: 'step6_media', data: JSON.stringify(data) },
  })
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: '⏭️ Без медиа', callback_data: 'skip' }]],
  }
  await send(
    cq.from.id,
    [
      `✅ Завершится: ${endsAt.toLocaleString('ru-RU')}`,
      ``,
      `Шаг 6/7: Медиа (опционально)`,
      ``,
      `Пришли фото или видео для поста, или нажми «⏭️ Без медиа».`,
    ].join('\n'),
    kb
  )
}

// Обработка кнопок maxpart:N (50, 100, 500, 1000)
async function handleMaxParticipantsButton(cq: TgCallbackQuery, maxParticipants: number) {
  const user = await upsertUser(cq.from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session || session.step !== 'step5_endtype_participants') {
    return
  }
  const data = JSON.parse(session.data)
  data.endType = 'participants'
  data.maxParticipants = maxParticipants
  data.endsAt = null
  await db.session.update({
    where: { tgId: user.tgId },
    data: { step: 'step6_media', data: JSON.stringify(data) },
  })
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [[{ text: '⏭️ Без медиа', callback_data: 'skip' }]],
  }
  await send(
    cq.from.id,
    [
      `✅ Завершится после ${maxParticipants} участников`,
      ``,
      `Шаг 6/7: Медиа (опционально)`,
      ``,
      `Пришли фото или видео для поста, или нажми «⏭️ Без медиа».`,
    ].join('\n'),
    kb
  )
}

async function skipMedia(cq: TgCallbackQuery) {
  const user = await upsertUser(cq.from)
  const session = await db.session.findUnique({ where: { tgId: user.tgId } })
  if (!session || session.step !== 'step6_media') {
    await send(cq.from.id, '⚠️ Сессия устарела.')
    return
  }
  const data = JSON.parse(session.data)
  data.mediaType = null
  data.mediaFileId = null
  await db.session.update({
    where: { tgId: user.tgId },
    data: { step: 'step7_channel', data: JSON.stringify(data) },
  })
  await send(
    cq.from.id,
    `✅ Без медиа\n\nШаг 7/7: Пришли @username канала\n\n⚠️ Ты должен быть **владельцем** канала, а бот должен быть админом канала.`
  )
}

/* ------------------------------------------------------------------ */
/* End / cancel giveaway                                              */
/* ------------------------------------------------------------------ */

async function endGiveawayNow(cq: TgCallbackQuery, giveawayId: string) {
  const from = cq.from
  const giveaway = await db.giveaway.findUnique({ where: { id: giveawayId } })
  if (!giveaway) {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Розыгрыш не найден', show_alert: true })
    } catch {}
    return
  }
  if (giveaway.ownerTgId !== String(from.id)) {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Только владелец может завершить', show_alert: true })
    } catch {}
    return
  }
  if (giveaway.status !== 'active') {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Уже завершён', show_alert: true })
    } catch {}
    return
  }

  await finalizeGiveaway(giveaway.id)
  try {
    await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '✅ Розыгрыш завершён!' })
  } catch {}
}

async function cancelGiveaway(cq: TgCallbackQuery, giveawayId: string) {
  const from = cq.from
  const giveaway = await db.giveaway.findUnique({ where: { id: giveawayId } })
  if (!giveaway) {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Розыгрыш не найден', show_alert: true })
    } catch {}
    return
  }
  if (giveaway.ownerTgId !== String(from.id)) {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Только владелец может отменить', show_alert: true })
    } catch {}
    return
  }

  await db.giveaway.update({
    where: { id: giveawayId },
    data: { status: 'cancelled', endedAt: new Date() },
  })
  await updateGiveawayPost(giveawayId)
  try {
    await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Розыгрыш отменён' })
  } catch {}
}

export async function finalizeGiveaway(giveawayId: string) {
  const giveaway = await db.giveaway.findUnique({
    where: { id: giveawayId },
    include: { participants: true },
  })
  if (!giveaway || giveaway.status !== 'active') return

  const participants = giveaway.participants
  if (participants.length === 0) {
    // Нет участников — просто завершаем
    await db.giveaway.update({
      where: { id: giveawayId },
      data: { status: 'ended', endedAt: new Date() },
    })
    await updateGiveawayPost(giveawayId)
    // Уведомить владельца
    try {
      await send(
        giveaway.ownerTgId,
        `⚠️ Розыгрыш «${giveaway.title}» завершён без участников.`
      )
    } catch {}
    return
  }

  // Выбираем победителей через crypto random (Fisher-Yates shuffle)
  const winnerTgIds: string[] = []
  const shuffled = [...participants]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const winnerCount = Math.min(giveaway.winnersCount, shuffled.length)
  for (let i = 0; i < winnerCount; i++) {
    winnerTgIds.push(shuffled[i].tgId)
  }

  // Атомарно создаём победителей + обновляем статус
  await db.$transaction(async (tx) => {
    for (let i = 0; i < winnerTgIds.length; i++) {
      const p = participants.find(p => p.tgId === winnerTgIds[i])!
      await tx.winner.create({
        data: {
          giveawayId: giveaway.id,
          tgId: p.tgId,
          username: p.username,
          firstName: p.firstName,
          place: i + 1,
        },
      })
      // Увеличиваем счётчик побед юзера
      await tx.user.updateMany({
        where: { tgId: p.tgId },
        data: { totalWins: { increment: 1 } },
      })
    }
    await tx.giveaway.update({
      where: { id: giveaway.id },
      data: { status: 'ended', endedAt: new Date() },
    })
  })

  // Обновляем пост с победителями
  await updateGiveawayPost(giveawayId)

  // Уведомляем победителей
  const winners = await db.winner.findMany({ where: { giveawayId: giveaway.id }, orderBy: { place: 'asc' } })
  for (const w of winners) {
    try {
      const placeText = w.place === 1 ? '🏆 Ты победила на 1 месте!' : `🥈 Ты заняла ${w.place} место!`
      await send(
        w.tgId,
        [
          `🎉 **Ты выиграла!**`,
          ``,
          `${placeText}`,
          ``,
          `🎁 Розыгрыш: **${giveaway.title}**`,
          `👑 Организатор: @${giveaway.channelUsername}`,
          ``,
          `Свяжись с организатором для получения приза.`,
        ].join('\n')
      )
    } catch {}
  }

  // Уведомляем владельца
  try {
    const winnerLines = winners.map(w => {
      const name = w.username ? `@${w.username}` : (w.firstName || `id:${w.tgId}`)
      return `${w.place}. ${name}`
    }).join('\n')
    await send(
      giveaway.ownerTgId,
      [
        `✅ **Розыгрыш завершён!**`,
        ``,
        `🎁 **${giveaway.title}**`,
        `👥 Участников: ${participants.length}`,
        ``,
        `🏆 **Победители:**`,
        winnerLines,
        ``,
        `Свяжись с победителями для передачи призов.`,
      ].join('\n')
    )
  } catch {}
}

async function showParticipants(cq: TgCallbackQuery, giveawayId: string) {
  const from = cq.from
  const giveaway = await db.giveaway.findUnique({
    where: { id: giveawayId },
    include: { participants: true },
  })
  if (!giveaway) {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Не найден', show_alert: true })
    } catch {}
    return
  }
  if (giveaway.ownerTgId !== String(from.id)) {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Только для владельца', show_alert: true })
    } catch {}
    return
  }

  if (giveaway.participants.length === 0) {
    try {
      await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '📭 Нет участников', show_alert: true })
    } catch {}
    return
  }

  const lines = giveaway.participants.slice(0, 100).map((p, i) => {
    const name = p.username ? `@${p.username}` : (p.firstName || `id:${p.tgId}`)
    return `${i + 1}. ${name}`
  }).join('\n')

  await send(
    cq.from.id,
    [
      `📋 **Участники (${giveaway.participants.length}):**`,
      ``,
      lines,
      ...(giveaway.participants.length > 100 ? [`\n...и ещё ${giveaway.participants.length - 100}`] : []),
    ].join('\n')
  )
}

/* ------------------------------------------------------------------ */
/* List commands                                                       */
/* ------------------------------------------------------------------ */

async function handleMyGiveaways(msg: TgMessage, user: { id: string; tgId: string }) {
  const giveaways = await db.giveaway.findMany({
    where: { ownerTgId: user.tgId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  if (giveaways.length === 0) {
    await send(msg.chat.id, '📭 У тебя пока нет розыгрышей.\n\nСоздай первый: /newgiveaway')
    return
  }
  const lines = giveaways.map(g => {
    const status = g.status === 'active' ? '🟢' : g.status === 'ended' ? '✅' : '❌'
    const endInfo = g.endType === 'time' && g.endsAt
      ? (g.endsAt > new Date() ? `⏰ ${g.endsAt.toLocaleString('ru-RU')}` : 'завершён')
      : 'кнопкой'
    return `${status} **${g.title}**\n   👥 ${g.totalTickets} участ. | 🏆 ${g.winnersCount} побед. | ${endInfo}\n   ID: \`${g.id}\``
  })
  await send(msg.chat.id, `📋 **Твои розыгрыши (${giveaways.length}):**\n\n${lines.join('\n\n')}`)
}

async function handleMyWins(msg: TgMessage, user: { id: string; tgId: string }) {
  const wins = await db.winner.findMany({
    where: { tgId: user.tgId },
    include: { giveaway: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  if (wins.length === 0) {
    await send(msg.chat.id, '📭 Ты ещё не выигрывал(а).\n\nУчаствуй в розыгрышах и удача улыбнётся!')
    return
  }
  const lines = wins.map(w => {
    const date = w.createdAt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const place = w.place === 1 ? '🏆 1 место' : `🥈 ${w.place} место`
    return `${place} — **${w.giveaway.title}**\n   👑 @${w.giveaway.channelUsername} | ${date}`
  })
  await send(msg.chat.id, `🏆 **Твои победы (${wins.length}):**\n\n${lines.join('\n\n')}`)
}

async function handleMyTickets(msg: TgMessage, user: { id: string; tgId: string }) {
  const participations = await db.participant.findMany({
    where: { tgId: user.tgId },
    include: { giveaway: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  if (participations.length === 0) {
    await send(msg.chat.id, '📭 Ты ещё ни где не участвуешь.\n\nЖми кнопку «🎉 Участвовать» под постами розыгрышей!')
    return
  }
  const lines = participations.map(p => {
    const status = p.giveaway.status === 'active' ? '🟢' : p.giveaway.status === 'ended' ? '✅' : '❌'
    return `${status} **${p.giveaway.title}**\n   👑 @${p.giveaway.channelUsername} | 🏆 ${p.giveaway.winnersCount} побед.`
  })
  await send(msg.chat.id, `🎟️ **Где участвую (${participations.length}):**\n\n${lines.join('\n\n')}`)
}

async function handleActiveGiveaways(msg: TgMessage, user: { id: string; tgId: string }) {
  const giveaways = await db.giveaway.findMany({
    where: { status: 'active' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  if (giveaways.length === 0) {
    await send(msg.chat.id, '📭 Нет активных розыгрышей.')
    return
  }
  const lines = giveaways.map(g => {
    const endInfo = g.endType === 'time' && g.endsAt
      ? `⏰ ${g.endsAt.toLocaleString('ru-RU')}`
      : `🔘 вручную`
    return `🎁 **${g.title}**\n   👑 @${g.channelUsername} | 👥 ${g.totalTickets} участ. | 🏆 ${g.winnersCount} побед. | ${endInfo}`
  })
  await send(msg.chat.id, `🔥 **Активные розыгрыши (${giveaways.length}):**\n\n${lines.join('\n\n')}`)
}

/* ------------------------------------------------------------------ */
/* Cron: check ended giveaways                                         */
/* ------------------------------------------------------------------ */

export async function checkEndedGiveaways() {
  const now = new Date()
  const toEnd = await db.giveaway.findMany({
    where: {
      status: 'active',
      endType: 'time',
      endsAt: { lte: now },
    },
    select: { id: true },
  })
  for (const g of toEnd) {
    console.log(`[cron] finalizing giveaway ${g.id}`)
    try {
      await finalizeGiveaway(g.id)
    } catch (e) {
      console.error(`[cron] error finalizing ${g.id}:`, e)
    }
  }
}

// Handle duration button — parse data string
export async function handleCallbackDataWithDuration(cq: TgCallbackQuery) {
  // Этот метод вызывается для dur_N — парсим
  const data = cq.data ?? ''
  if (data.startsWith('dur_')) {
    const hours = parseInt(data.slice(4))
    if (!isNaN(hours)) {
      await handleDurationButton(cq, hours)
      return true
    }
  }
  return false
}
