import { registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'

/**
 * 系统能力桥（Task 9 + Task 11）：密钥加密存储 + 带进度下载到公共 Download 目录。
 *
 * 原生实现见 android/app/src/main/java/com/chksz/music/system/SystemPlugin.kt。
 * 与 playerBridge 同构：registerPlugin 拿原生代理，桥接口用域名风格方便上层调用。
 * 注意：本桥没有 web 实现（浏览器 dev 下调用会 reject Unimplemented），
 * 与 playerBridge 一致——移动 App 的真实运行环境是 Capacitor WebView。
 */

/** 下载结果。path 为 MediaStore 的 content:// URI，status=saved 时才有。 */
export interface DownloadResult {
  status: 'saved' | 'failed'
  path?: string
}

/** 下载任务进度事件（原生 onDownloadProgress 回推）。 */
export interface DownloadProgressEvent {
  taskId: string | null
  status: 'downloading' | 'done' | 'error'
  /** 0-100 整数；total 未知（分块传输）时 progress 恒 0 直到完成。 */
  progress?: number
  /** 已下载字节数。 */
  downloaded?: number
  /** 文件总字节数；Content-Length 缺失时为 0。 */
  total?: number
  /** status=done 时，文件的 MediaStore content:// URI。 */
  path?: string
  /** status=error 时，用户可读错误信息。 */
  message?: string
}

/** 原生插件代理的真实类型（方法参数是 options 对象，Capacitor 序列化约定）。 */
interface NativeSystemPlugin {
  getSecureKey(): Promise<{ key: string }>
  setSecureKey(options: { key: string }): Promise<void>
  download(options: {
    taskId: string
    title: string
    artist: string
    url: string
    fileExt: string
  }): Promise<DownloadResult>
  /** 系统返回键事件（MainActivity 转发的原生返回键，JS 侧逐级处理）。 */
  addListener(
    eventName: 'backButton',
    listener: () => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'onDownloadProgress',
    listener: (event: DownloadProgressEvent) => void,
  ): Promise<PluginListenerHandle>
  /** 退出 App（返回键无可回溯时调用）。 */
  exitApp(): Promise<void>
}

const SystemPlugin = registerPlugin<NativeSystemPlugin>('SystemPlugin')

/**
 * 系统能力桥实例：WebView 侧唯一入口。
 */
export const systemBridge = {
  /** 读取加密存储里的 API 密钥；未设置/存储不可用时返回空串。 */
  getSecureKey: (): Promise<string> => SystemPlugin.getSecureKey().then(result => result.key ?? ''),
  /** 写入加密存储的 API 密钥（JS 侧须先通过 chksz_ 前缀校验）。 */
  setSecureKey: (key: string): Promise<void> => SystemPlugin.setSecureKey({ key }),
  /** 后台下载音频到公共 Download 目录（MediaStore，Android 10+），期间在 onDownloadProgress 上回推进度。 */
  download: (options: { taskId: string; title: string; artist: string; url: string; fileExt: string }): Promise<DownloadResult> =>
    SystemPlugin.download(options),
  /** 订阅下载进度/完成/失败事件（返回 handle，卸载时 remove）。 */
  onDownloadProgress: (callback: (event: DownloadProgressEvent) => void): Promise<PluginListenerHandle> =>
    SystemPlugin.addListener('onDownloadProgress', callback),
  /** 订阅系统返回键事件（MainActivity OnBackPressedCallback 转发）。 */
  onBackButton: (callback: () => void): Promise<PluginListenerHandle> =>
    SystemPlugin.addListener('backButton', callback),
  /** 退出 App（返回键在 home 且无可回溯时调用）。 */
  exitApp: (): Promise<void> => SystemPlugin.exitApp(),
}

export default systemBridge