import type { RepeatMode, Song } from '@shared/contracts'

/**
 * 队列状态：现在仅用于 JS 侧 UI 展示同步（列表高亮/进度条/队列面板），
 * 不再驱动实际播放——播放的驱动源是原生 PlaybackQueue（Queue.kt），
 * ended/next 等 action 由 usePlayer 在收到原生 onTrackAutoAdvanced 事件后
 * 用 { type: 'select', index } 同步过来，而不是本地算出下一首去触发 load。
 */
export interface QueueState {
  items: Song[]
  currentIndex: number
  repeatMode: RepeatMode
  playRequestId: number
  /** 是否整单连续播放（歌曲列表入队）；true → 失败自动跳过，false → 单曲点播、失败停住可重试。 */
  queuePlay: boolean
}

export type QueueAction =
  | { type: 'replace'; items: Song[]; index?: number; queuePlay?: boolean }
  | { type: 'append'; song: Song }
  | { type: 'playNext'; song: Song }
  | { type: 'remove'; index: number }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'select'; index: number }
  | { type: 'ended'; random?: number }
  | { type: 'next'; random?: number }
  | { type: 'setRepeatMode'; mode: RepeatMode }

export const initialQueue: QueueState = { items: [], currentIndex: -1, repeatMode: 'sequence', playRequestId: 0, queuePlay: false }

function requestPlayback(state: QueueState, currentIndex: number): QueueState {
  // 索引相同时仍递增标记，让播放器明确收到重新播放请求。
  return { ...state, currentIndex, playRequestId: state.playRequestId + 1 }
}

function randomIndex(state: QueueState, random = Math.random()): number {
  return Math.min(state.items.length - 1, Math.floor(random * state.items.length))
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'replace': return { ...state, items: action.items, currentIndex: action.items.length ? Math.min(action.index ?? 0, action.items.length - 1) : -1, playRequestId: state.playRequestId + 1, queuePlay: action.queuePlay ?? false }
    case 'append': return { ...state, items: [...state.items, action.song] }
    case 'playNext': {
      const items = [...state.items]
      items.splice(Math.max(0, state.currentIndex + 1), 0, action.song)
      return { ...state, items }
    }
    case 'remove': {
      if (action.index < 0 || action.index >= state.items.length) return state
      const items = state.items.filter((_item, index) => index !== action.index)
      const currentIndex = items.length === 0 ? -1 : action.index < state.currentIndex ? state.currentIndex - 1 : Math.min(state.currentIndex, items.length - 1)
      return { ...state, items, currentIndex }
    }
    case 'reorder': {
      if (action.from < 0 || action.to < 0 || action.from >= state.items.length || action.to >= state.items.length) return state
      const items = [...state.items]
      const [moved] = items.splice(action.from, 1)
      if (!moved) return state
      items.splice(action.to, 0, moved)
      let currentIndex = state.currentIndex
      if (currentIndex === action.from) currentIndex = action.to
      else if (action.from < currentIndex && action.to >= currentIndex) currentIndex -= 1
      else if (action.from > currentIndex && action.to <= currentIndex) currentIndex += 1
      return { ...state, items, currentIndex }
    }
    case 'select': return action.index >= 0 && action.index < state.items.length ? requestPlayback(state, action.index) : state
    case 'setRepeatMode': return { ...state, repeatMode: action.mode }
    case 'ended': {
      if (!state.items.length || state.currentIndex < 0) return state
      if (state.repeatMode === 'one') return requestPlayback(state, state.currentIndex)
      if (state.repeatMode === 'shuffle') return requestPlayback(state, randomIndex(state, action.random))
      if (state.currentIndex < state.items.length - 1) return requestPlayback(state, state.currentIndex + 1)
      return requestPlayback(state, state.repeatMode === 'list' ? 0 : -1)
    }
    case 'next': {
      if (!state.items.length || state.currentIndex < 0) return state
      if (state.repeatMode === 'shuffle') return requestPlayback(state, randomIndex(state, action.random))
      if (state.currentIndex < state.items.length - 1) return requestPlayback(state, state.currentIndex + 1)
      return requestPlayback(state, state.repeatMode === 'list' || state.repeatMode === 'one' ? 0 : -1)
    }
  }
}