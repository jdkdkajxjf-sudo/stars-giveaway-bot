/** Telegram types used by the giveaway bot. */

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  caption?: string
  entities?: TgMessageEntity[]
  reply_to_message?: TgMessage
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[]
  video?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number; file_size?: number }
  animation?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number; file_size?: number }
  sticker?: { file_id: string; file_unique_id: string; width: number; height: number; is_animated: boolean; is_video: boolean; emoji?: string }
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number }
}

export interface TgMessageEntity {
  type: string
  offset: number
  length: number
  url?: string
  user?: TgUser
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  inline_message_id?: string
  chat_instance?: string
  data?: string
  game_short_name?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  callback_query?: TgCallbackQuery
  channel_post?: TgMessage
}

export interface TgChatMember {
  user: TgUser
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
}

export interface TgChatMemberResponse {
  ok: boolean
  result?: TgChatMember
  error_code?: number
  description?: string
}
