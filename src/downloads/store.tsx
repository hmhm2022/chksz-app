import { createContext, use, useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import type { PluginListenerHandle } from '@capacitor/core'
import type { Song } from '@shared/contracts'
import type { DownloadRecord } from '@shared/storage/downloads-store'
import { systemBridge } from '../systemBridge'

/** 下载任务状态（进行中任务只在内存；成功后落库 DownloadsStore）。 */
export type DownloadTaskStatus = 'downloading' | 'done' | 'error'

export interface DownloadTask {
  taskId: string
  song: Song
  quality: string
  status: DownloadTaskStatus
  /** 0-100 整数；total 未知分块传输时保持 0 直到完成。 */
  progress: number
  downloaded: number
  /** 文件总字节数；Content-Length 缺失时为 0。 */
  total: number
  /** status=done 时，content:// URI。 */
  path?: string
  /** status=error 时，用户可读错误信息。 */
  message?: string
  /** 任务创建时间戳。 */
  createdAt: number
  /** status=done 的时间戳（内存任务自动清理用）；done 前无值。 */
  finishedAt?: number
}

/**
 * 保存一次下载成功记录：同一 taskId 只允许一个并发写入。
 * 返回记录给调用方刷新内存状态；写入失败时撤销占位，后续完成事件可以再次尝试。
 */
export async function persistDownloadHistory(
  task: DownloadTask,
  path: string | undefined,
  downloaded: number,
  persisted: Set<string>,
  pending: Map<string, Promise<DownloadRecord | null>>,
  saveHistory: (record: DownloadRecord) => Promise<void>,
): Promise<DownloadRecord | null> {
  if (persisted.has(task.taskId)) return null
  const existing = pending.get(task.taskId)
  if (existing) {
    const result = await existing
    // 共享保存失败时，由当前等待者重新发起一次，避免并发窗口留下未保存记录。
    if (result) return result
    if (persisted.has(task.taskId)) return null
  }
  const record: DownloadRecord = {
    taskId: task.taskId,
    song: task.song,
    quality: task.quality,
    size: downloaded,
    createdAt: new Date(task.createdAt).toISOString(),
    uri: path,
  }
  const operation = (async () => {
    try {
      await saveHistory(record)
      return record
    } catch {
      return null
    }
  })()
  pending.set(task.taskId, operation)
  try {
    const result = await operation
    if (result) persisted.add(task.taskId)
    return result
  } finally {
    if (pending.get(task.taskId) === operation) pending.delete(task.taskId)
  }
}

/** done 任务在内存里保留的时长：结束后短暂展示给用户看过渡，之后移除（历史已落库）。 */
const DONE_TASK_KEEP_MS = 5000

interface DownloadsContextValue {
  /** 进行中/刚结束的任务（含 error/done 的短暂状态）。 */
  tasks: DownloadTask[]
  /** 已下载历史记录（时间倒序）。 */
  history: DownloadRecord[]
  /** 已下载歌曲 key 集合（按钮「已下载」禁用态）。 */
  downloadedKeys: Set<string>
  /** 历史记录是否已就绪（页面先渲染壳再填充列表）。 */
  loaded: boolean
  /** 发起下载：取直链 → 提交原生 → 进度订阅。返回 taskId。 */
  startDownload(song: Song, quality?: string): Promise<string>
  /** 重试失败任务：换新 taskId 重新走 startDownload。 */
  retryTask(task: DownloadTask): Promise<string>
}

const DownloadsContext = createContext<DownloadsContextValue | null>(null)

type TaskAction =
  | { type: 'upsert'; task: DownloadTask }
  | { type: 'remove'; taskId: string }
  | { type: 'setHistory'; history: DownloadRecord[]; keys: Set<string> }

export function taskReducer(tasks: DownloadTask[], action: TaskAction): DownloadTask[] {
  switch (action.type) {
    case 'setHistory':
      return tasks
    case 'remove':
      return tasks.filter(task => task.taskId !== action.taskId)
    case 'upsert': {
      const index = tasks.findIndex(task => task.taskId === action.task.taskId)
      if (index < 0) return [action.task, ...tasks]
      const next = [...tasks]
      next[index] = action.task
      return next
    }
  }
}

/**
 * 下载状态管理（Task 11 下载管理页核心）。
 *
 * - startDownload：crypto.randomUUID() 生成 taskId → window.chksz.downloads.save
 *   （内部：getPlayback 直链 → systemBridge.download({taskId,...})）；
 * - 原生 onDownloadProgress 事件（按 taskId 归并）驱动任务进度/完成/失败；
 * - done → 落库 DownloadsStore（saveHistory）并刷新历史；
 * - 历史记录在挂载时读入（loaded 表示就绪）。
 *
 * 全局单例挂载（App.tsx 顶层），避免多个页面各自订阅事件造成重复进度更新。
 * 事件监听用 ref 持有当前任务表，规避 effect 闭包捕获旧数组的 stale 问题。
 */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [tasks, dispatch] = useReducer(taskReducer, [])
  const [history, setHistory] = useState<DownloadRecord[]>([])
  const [downloadedKeys, setDownloadedKeys] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const listenerRef = useRef<PluginListenerHandle | null>(null)
  /** 当前任务表（供事件回调读最新值，避免 effect 闭包旧数组）。 */
  const tasksRef = useRef<DownloadTask[]>([])
  /** 已落库的 taskId：done 事件重发时避免重复写库。 */
  const persistedRef = useRef<Set<string>>(new Set())
  /** 正在写入的 taskId：done 事件和 Promise 兜底共享同一个保存操作。 */
  const pendingPersistenceRef = useRef<Map<string, Promise<DownloadRecord | null>>>(new Map())

  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])

  const loadHistory = async () => {
    try {
      const [records, keys] = await Promise.all([
        window.chksz.downloads.getHistory(),
        window.chksz.downloads.downloadedKeys(),
      ])
      setHistory(records)
      setDownloadedKeys(keys)
    } catch {
      // 读取历史失败不阻塞下载（IndexedDB 极端异常），保持空列表。
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    void loadHistory()
  }, [])

  // 订阅原生进度事件（全局一次）：done/error 由原生保证在 resolve/reject 前发出。
  useEffect(() => {
    let cancelled = false
    void systemBridge
      .onDownloadProgress((event) => {
        if (cancelled) return
        void onProgress(event)
      })
      .then(handle => {
        if (cancelled) void handle.remove()
        else listenerRef.current = handle
      })
    return () => {
      cancelled = true
      void listenerRef.current?.remove()
      listenerRef.current = null
    }
    // 只在挂载时订阅一次；onProgress 经 ref 读最新任务表。
  }, [])

  // done 任务自动清理：结束后短暂过渡（已落库持久化），超过保留时长从内存移除，
  // 避免 tasks 数组只增不减（下载历史以 DownloadsStore 为准）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      const stale = tasks.filter(task => task.status === 'done' && task.finishedAt != null && now - task.finishedAt >= DONE_TASK_KEEP_MS)
      for (const task of stale) dispatch({ type: 'remove', taskId: task.taskId })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [tasks])

  /** 进度事件 → 更新任务 + done 落库。 */
  const onProgress = async (event: { taskId: string | null; status: 'downloading' | 'done' | 'error'; progress?: number; downloaded?: number; total?: number; path?: string; message?: string }) => {
    const { taskId } = event
    if (!taskId) return
    const task = tasksRef.current.find(item => item.taskId === taskId)
    if (!task) return

    if (event.status === 'done') {
      dispatch({
        type: 'upsert',
        task: { ...task, status: 'done', progress: 100, path: event.path, finishedAt: Date.now() },
      })
      // done 落库：同 taskId 只写一次；Promise 成功兜底也走同一函数。
      const record = await persistDownloadHistory(
        task,
        event.path,
        event.downloaded ?? task.downloaded,
        persistedRef.current,
        pendingPersistenceRef.current,
        item => window.chksz.downloads.saveHistory(item),
      )
      if (record) {
        setDownloadedKeys(prev => new Set(prev).add(task.song.key))
        try {
          const records = await window.chksz.downloads.getHistory()
          setHistory(records)
        } catch {
          // 历史刷新失败不影响已保存记录和下载文件。
        }
      }
      return
    }

    if (event.status === 'error') {
      dispatch({
        type: 'upsert',
        task: {
          ...task,
          status: 'error',
          message: event.message ?? '下载失败，请重试',
        },
      })
      return
    }

    // downloading 进度更新（total 未知时 progress 恒 0，UI 显示已下载字节）。
    dispatch({
      type: 'upsert',
      task: {
        ...task,
        status: 'downloading',
        progress: event.progress ?? 0,
        downloaded: event.downloaded ?? task.downloaded,
        total: event.total ?? task.total,
      },
    })
  }

  /** Promise 成功回调和 done 事件共用的兜底落库流程。 */
  const persistDone = async (task: DownloadTask, path: string | undefined) => {
    const record = await persistDownloadHistory(
      task,
      path,
      task.downloaded,
      persistedRef.current,
      pendingPersistenceRef.current,
      item => window.chksz.downloads.saveHistory(item),
    )
    if (!record) return
    setDownloadedKeys(prev => new Set(prev).add(task.song.key))
    try {
      const records = await window.chksz.downloads.getHistory()
      setHistory(records)
    } catch {
      // 历史刷新失败不影响已保存记录和下载文件。
    }
  }

  /** 发起下载（重复下载同歌曲时每次新建任务）。 */
  const startDownload = async (song: Song, quality?: string): Promise<string> => {
    const taskId = crypto.randomUUID()
    const createdAt = Date.now()
    const task: DownloadTask = {
      taskId,
      song,
      quality: quality ?? '',
      status: 'downloading',
      progress: 0,
      downloaded: 0,
      total: 0,
      createdAt,
    }
    dispatch({ type: 'upsert', task })
    void window.chksz.downloads
      .save(song, quality, taskId)
      .then(result => {
        // 原生 resolve（含 status:saved/path）在 done 事件之后到达；
        // 事件丢失时这里同时补齐内存状态和下载历史。
        const current = tasksRef.current.find(t => t.taskId === taskId)
        if (result.status === 'saved' && current && current.status !== 'done') {
          const doneTask: DownloadTask = { ...current, status: 'done', progress: 100, path: result.path, finishedAt: Date.now() }
          dispatch({
            type: 'upsert',
            task: doneTask,
          })
          void persistDone(doneTask, result.path)
        }
      })
      .catch(error => {
        // onDownloadProgress(error) 事件已先行置 error；这里兜底（事件丢失时）。
        const current = tasksRef.current.find(t => t.taskId === taskId)
        if (current && current.status !== 'error' && current.status !== 'done') {
          dispatch({
            type: 'upsert',
            task: {
              ...current,
              status: 'error',
              message: error instanceof Error ? error.message : '下载失败，请重试',
            },
          })
        }
      })
    return taskId
  }

  /** 重试失败任务：移除旧 error 任务，换新 taskId 重新走完整链路（原生不留旧状态）。 */
  const retryTask = async (task: DownloadTask): Promise<string> => {
    dispatch({ type: 'remove', taskId: task.taskId })
    return startDownload(task.song, task.quality || undefined)
  }

  return (
    <DownloadsContext value={{ tasks, history, downloadedKeys, loaded, startDownload, retryTask }}>
      {children}
    </DownloadsContext>
  )
}

export function useDownloads(): DownloadsContextValue {
  const value = use(DownloadsContext)
  if (!value) throw new Error('DownloadsProvider is missing')
  return value
}
