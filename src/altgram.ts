/**
 * AltGram Bot API client for Stars Giveaway bot.
 * Telegram-compatible API at http://188.134.95.254:2610.
 * Does NOT support parse_mode — use `entities` array.
 */

const ALTGRAM_API_URL =
  process.env.ALTGRAM_API_URL || 'http://188.134.95.254:2610'
const BOT_TOKEN = process.env.BOT_TOKEN || ''

export type TgEntity = {
  type: string
  offset: number
  length: number
  url?: string
  user?: { id: number; first_name: string; is_bot: boolean }
}

export type TgInlineKeyboardButton = {
  text: string
  callback_data?: string
  url?: string
  web_app?: { url: string }
  copy_text?: { text: string }
}

export type TgInlineKeyboardMarkup = {
  inline_keyboard: TgInlineKeyboardButton[][]
}

export interface TgResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
}

async function tgFetch<T>(method: string, body: Record<string, unknown>) {
  const url = `${ALTGRAM_API_URL}/bot${BOT_TOKEN}/${method}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as TgResponse<T>
  if (!data.ok) {
    console.error(
      `[altgram] ${method} failed:`,
      data.error_code,
      data.description,
      JSON.stringify(body).slice(0, 200)
    )
  }
  return data
}

/**
 * Convert **markdown-ish** markers to plain text + entities.
 * Supports: **bold**, *italic*, __underline__, ~~strike~~, `code`.
 */
export function md(text: string): { text: string; entities: TgEntity[] } {
  const entities: TgEntity[] = []
  let plain = ''
  let i = 0

  const push = (type: string, raw: string) => {
    const start = plain.length
    plain += raw
    entities.push({ type, offset: start, length: raw.length })
  }

  while (i < text.length) {
    const rest = text.slice(i)
    let m: RegExpMatchArray | null = null

    if ((m = rest.match(/^\*\*([^*]+)\*\*/))) {
      push('bold', m[1])
      i += m[0].length
    } else if ((m = rest.match(/^__([^_]+)__/))) {
      push('underline', m[1])
      i += m[0].length
    } else if ((m = rest.match(/^~~([^~]+)~~/))) {
      push('strikethrough', m[1])
      i += m[0].length
    } else if ((m = rest.match(/^`([^`]+)`/))) {
      push('code', m[1])
      i += m[0].length
    } else if ((m = rest.match(/^\*([^*]+)\*/))) {
      push('italic', m[1])
      i += m[0].length
    } else {
      plain += text[i]
      i++
    }
  }

  return { text: plain, entities }
}

export const altgram = {
  async getMe() {
    return tgFetch<{ id: number; is_bot: boolean; first_name: string; username: string }>('getMe', {})
  },

  async sendMessage(params: {
    chat_id: number | string
    text: string
    entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
    reply_to_message_id?: number
    disable_web_page_preview?: boolean
  }) {
    const body: Record<string, unknown> = {
      chat_id: params.chat_id,
      text: params.text,
    }
    if (params.entities && params.entities.length > 0) {
      body.entities = params.entities
    }
    if (params.reply_markup) {
      body.reply_markup = params.reply_markup
    }
    if (params.reply_to_message_id) {
      body.reply_to_message_id = params.reply_to_message_id
    }
    if (params.disable_web_page_preview) {
      body.disable_web_page_preview = true
    }
    return tgFetch<{ message_id: number; chat: { id: number }; text: string }>('sendMessage', body)
  },

  async sendPhoto(params: {
    chat_id: number | string
    photo: string  // file_id
    caption?: string
    caption_entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    const body: Record<string, unknown> = {
      chat_id: params.chat_id,
      photo: params.photo,
    }
    if (params.caption) body.caption = params.caption
    if (params.caption_entities && params.caption_entities.length > 0) {
      body.caption_entities = params.caption_entities
    }
    if (params.reply_markup) body.reply_markup = params.reply_markup
    return tgFetch<{ message_id: number; chat: { id: number } }>('sendPhoto', body)
  },

  async sendVideo(params: {
    chat_id: number | string
    video: string  // file_id
    caption?: string
    caption_entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    const body: Record<string, unknown> = {
      chat_id: params.chat_id,
      video: params.video,
    }
    if (params.caption) body.caption = params.caption
    if (params.caption_entities && params.caption_entities.length > 0) {
      body.caption_entities = params.caption_entities
    }
    if (params.reply_markup) body.reply_markup = params.reply_markup
    return tgFetch<{ message_id: number; chat: { id: number } }>('sendVideo', body)
  },

  async sendAnimation(params: {
    chat_id: number | string
    animation: string  // file_id
    caption?: string
    caption_entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    const body: Record<string, unknown> = {
      chat_id: params.chat_id,
      animation: params.animation,
    }
    if (params.caption) body.caption = params.caption
    if (params.caption_entities && params.caption_entities.length > 0) {
      body.caption_entities = params.caption_entities
    }
    if (params.reply_markup) body.reply_markup = params.reply_markup
    return tgFetch<{ message_id: number; chat: { id: number } }>('sendAnimation', body)
  },

  async editMessageText(params: {
    chat_id: number | string
    message_id: number
    text: string
    entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    const body: Record<string, unknown> = {
      chat_id: params.chat_id,
      message_id: params.message_id,
      text: params.text,
    }
    if (params.entities && params.entities.length > 0) {
      body.entities = params.entities
    }
    if (params.reply_markup) body.reply_markup = params.reply_markup
    return tgFetch<{ message_id: number; chat: { id: number }; text: string }>('editMessageText', body)
  },

  async editMessageCaption(params: {
    chat_id: number | string
    message_id: number
    caption: string
    caption_entities?: TgEntity[]
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    const body: Record<string, unknown> = {
      chat_id: params.chat_id,
      message_id: params.message_id,
      caption: params.caption,
    }
    if (params.caption_entities && params.caption_entities.length > 0) {
      body.caption_entities = params.caption_entities
    }
    if (params.reply_markup) body.reply_markup = params.reply_markup
    return tgFetch<boolean>('editMessageCaption', body)
  },

  async editMessageReplyMarkup(params: {
    chat_id: number | string
    message_id: number
    reply_markup?: TgInlineKeyboardMarkup
  }) {
    return tgFetch<boolean>('editMessageReplyMarkup', params)
  },

  async answerCallbackQuery(params: {
    callback_query_id: string
    text?: string
    show_alert?: boolean
    url?: string
  }) {
    return tgFetch<boolean>('answerCallbackQuery', params)
  },

  async setMyCommands(commands: { command: string; description: string }[]) {
    return tgFetch<boolean>('setMyCommands', { commands })
  },

  async getChat(params: { chat_id: number | string }) {
    return tgFetch<{
      id: number
      type: string
      title?: string
      username?: string
      first_name?: string
      last_name?: string
    }>('getChat', params)
  },

  async getChatMember(params: {
    chat_id: number | string
    user_id: number
  }) {
    return tgFetch<{
      user: { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string }
      status: 'creator' | 'administrator' | 'member' | 'left' | 'kicked' | 'restricted'
      can_post_messages?: boolean
      can_edit_messages?: boolean
      can_delete_messages?: boolean
      can_invite_users?: boolean
      can_restrict_members?: boolean
      can_promote_members?: boolean
      can_change_info?: boolean
      can_pin_messages?: boolean
      is_member?: boolean
    }>('getChatMember', params)
  },

  async deleteMessage(params: { chat_id: number | string; message_id: number }) {
    return tgFetch<boolean>('deleteMessage', params)
  },

  async getUpdates(params: {
    offset: number
    timeout: number
    allowed_updates?: string[]
  }) {
    return tgFetch<unknown[]>('getUpdates', params)
  },

  async deleteWebhook() {
    return tgFetch<boolean>('deleteWebhook', {})
  },
}
