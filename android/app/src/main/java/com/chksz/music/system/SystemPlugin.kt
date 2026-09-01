package com.chksz.music.system

import android.content.ContentValues
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 系统能力插件（Task 9）：密钥加密存储 + 下载到公共 Download 目录。
 *
 * 三个能力都走原生：
 * - API 密钥用 [EncryptedSharedPreferences]（AES-256 主密钥存 Android Keystore，
 *   密钥名 AES256_SIV + 值 AES256_GCM 双层加密）持久化，替代 Web 侧
 *   @capacitor/preferences 的键值存储占位；
 * - 下载经 [HttpURLConnection] 拉流后写入 MediaStore.Downloads（Android 10+，
 *   无需任何存储权限）；老版本（<10）不支持，明确报错而不是降级到
 *   WRITE_EXTERNAL_STORAGE 那样麻烦的路径——本 App 设计目标即 Android 10+；
 *   下载在独立单线程池后台执行，进度经 onDownloadProgress 事件实时回推
 *   WebView（Task 11：下载管理页）；
 * - 通知权限：Task 8 已在首次播放时 fire-and-forget 请求过（PlayerPlugin，
 *   POST_NOTIFICATIONS 已在 manifest 声明），此处不重复实现，避免两处请求
 *   竞态双弹窗。拒绝后通知栏不可见但前台服务照常运行，符合系统惯例。
 */
@CapacitorPlugin(name = "SystemPlugin")
class SystemPlugin : Plugin() {

    /** 加密偏好文件名（EncryptedSharedPreferences 专用，勿与其他 Preferences 混用）。 */
    private val prefsFileName = "chksz_secure_prefs"
    /** 密钥在加密偏好里的键名。 */
    private val apiKeyName = "chksz_api_key"

    /** 懒建主密钥（每次调用都 build 会触发 Keystore 交互，故缓存实例）。 */
    private var masterKey: MasterKey? = null
    private var securePrefs: SharedPreferences? = null

    /**
     * 下载专用线程池：单线程串行下载，避免并行大流量挤占带宽/内存。
     * 插件方法本身已跑在 Capacitor 的 "CapacitorPlugins" HandlerThread 上，
     * 但那是所有插件共享的串行线程——同步阻塞下载会卡住其他插件调用，
     * 故下载真正的工作在此池里执行，方法体只做参数校验 + 提交任务后立即返回。
     */
    private val downloadExecutor: ExecutorService = Executors.newSingleThreadExecutor()

    /**
     * EncryptedSharedPreferences 在 1.1.0 标记为 deprecated（官方推荐迁移
     * security-crypto-datastore），但仍是稳定可用的标准方案，且避免引入
     * datastore 额外依赖。任务约定即此方案，故 @Suppress 保留。
     */
    @Suppress("DEPRECATION")
    private fun getSecurePrefs(): SharedPreferences? {
        // 懒建未加锁：并发只可能重复构建一次 MasterKey/prefs，结果等价且幂等
        // （同一 KeyScheme 同一文件），重复构建的成本可接受，故不做同步。
        if (securePrefs == null) {
            val context = bridge.context ?: return null
            val key = masterKey
                ?: MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                    .also { masterKey = it }
            securePrefs = EncryptedSharedPreferences.create(
                context,
                prefsFileName,
                key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
        return securePrefs
    }

    /** 读取加密存储的 API 密钥；未设置时返回空串（hasKey 语义由 JS 侧保持）。 */
    @PluginMethod
    fun getSecureKey(call: PluginCall) {
        val prefs = getSecurePrefs()
        if (prefs == null) {
            call.reject("secure storage unavailable")
            return
        }
        val key = prefs.getString(apiKeyName, "") ?: ""
        call.resolve(JSObject().apply { put("key", key) })
    }

    /** 写入加密存储的 API 密钥。JS 侧已校验 chksz_ 前缀，这里只负责安全落盘。 */
    @PluginMethod
    fun setSecureKey(call: PluginCall) {
        val key = call.getString("key")
        if (key == null) {
            call.reject("key is required")
            return
        }
        val prefs = getSecurePrefs()
        if (prefs == null) {
            call.reject("secure storage unavailable")
            return
        }
        prefs.edit().putString(apiKeyName, key).commit()
        call.resolve()
    }

    /**
     * 退出 App（返回键在 home 且无可回溯时 JS 调用）。
     * 与 Capacitor App 插件 exitApp 语义一致；直接 finish Activity，不 kill 进程。
     * 注意：不能调 onBackPressedDispatcher.onBackPressed()——会再次进入 MainActivity 的
     * OnBackPressedCallback（又发 backButton 事件 → JS 又调 exitApp → 死循环）。
     */
    @PluginMethod
    fun exitApp(call: PluginCall) {
        call.resolve()
        getActivity()?.finish()
    }

    /** 外部（MainActivity 返回键）把系统返回转成 backButton 事件给 JS。 */
    fun emitBackButton() {
        notifyListeners("backButton", JSObject())
    }

    /**
     * 下载音频到系统公共 Download 目录（后台异步，带进度回推）。
     *
     * @param options.taskId   JS 侧生成的下载任务 ID（uuid），进度/完成事件按它回推
     * @param options.title    歌曲名
     * @param options.artist   歌手（单曲可多个，已用顿号拼接）
     * @param options.url      可播放地址（getPlayback 返回的直链）
     * @param options.fileExt  扩展名（mp3/m4a/flac 等，JS 侧按 format/url 推断）
     *
     * 下载在 [downloadExecutor] 上异步执行（调用立即返回，不阻塞 Capacitor 插件线程）：
     * - 期间按块定期发 onDownloadProgress {taskId, progress, downloaded, total, status:'downloading'}
     * - 完成发 onDownloadProgress {taskId, progress:100, status:'done', path} 后 resolve
     * - 失败发 onDownloadProgress {taskId, status:'error', message} 后 reject
     * 调用用 setKeepAlive(true) 保存：resolve/reject 在后台线程完成后发出，
     * JS 侧 await 正常收结果；完成后 release 释放保存的调用。
     */
    @PluginMethod
    fun download(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("需要 Android 10 及以上版本（当前 ${Build.VERSION.SDK_INT}）")
            return
        }
        val taskId = call.getString("taskId")?.takeIf { it.isNotBlank() }
        val url = call.getString("url")
        val title = call.getString("title")?.takeIf { it.isNotBlank() }
        val artist = call.getString("artist")?.takeIf { it.isNotBlank() } ?: "未知歌手"
        if (url.isNullOrBlank() || title == null) {
            call.reject("url 和 title 必填")
            return
        }
        val extension = sanitizeExt(call.getString("fileExt")) ?: "mp3"
        val displayName = sanitizeFileName("${artist} - ${title}") + ".$extension"

        call.setKeepAlive(true)
        downloadExecutor.execute {
            try {
                val contentUri = downloadToMediaStore(displayName, url, taskId)
                emitDone(taskId, contentUri)
                call.resolve(JSObject().apply {
                    put("status", "saved")
                    put("path", contentUri.toString())
                })
            } catch (error: Exception) {
                // 底层异常只负责携带原因，用户可见文案在此统一归一，避免英文原始消息透传。
                val message = downloadErrorMessage(error)
                emitError(taskId, message)
                call.reject(message, null, error)
            } finally {
                call.release(bridge)
            }
        }
    }

    /** 把底层下载异常归一为用户可读的中文文案（SocketTimeout/FileNotFound 是 IOException 子类，需先判）。 */
    private fun downloadErrorMessage(error: Exception): String = when {
        // shutdownNow 打断 / 循环内 isInterrupted 抛出的中断标记（含消息"下载已中断"）。
        error is InterruptedException || error.message?.contains("中断") == true -> "下载已中断"
        // 阻塞读被中断（socket read 抛的是 InterruptedIOException，同时置位当前线程中断状态）。
        error is InterruptedIOException && Thread.currentThread().isInterrupted -> "下载已中断"
        error is SocketTimeoutException -> "下载超时，请重试"
        error is InterruptedIOException -> "下载已中断"
        error is FileNotFoundException -> "音频文件无法访问"
        else -> "下载失败，请重试"
    }

    /** 进度事件（下载中）。taskId 为 null 时仍照发（JS 按 taskId 过滤），保留原始信息。 */
    private fun emitProgress(taskId: String?, downloaded: Long, total: Long, progress: Int) {
        notifyListeners("onDownloadProgress", JSObject().apply {
            put("taskId", taskId)
            put("status", "downloading")
            put("downloaded", downloaded)
            put("total", total)
            put("progress", progress)
        })
    }

    /** 完成事件。 */
    private fun emitDone(taskId: String?, path: Uri) {
        notifyListeners("onDownloadProgress", JSObject().apply {
            put("taskId", taskId)
            put("status", "done")
            put("progress", 100)
            put("path", path.toString())
        })
    }

    /** 失败事件。 */
    private fun emitError(taskId: String?, message: String) {
        notifyListeners("onDownloadProgress", JSObject().apply {
            put("taskId", taskId)
            put("status", "error")
            put("message", message)
        })
    }

    /**
     * 用 MediaStore 两步写入把 url 拉到公共 Download 目录，期间按块上报进度。
     * 在 [downloadExecutor] 线程上执行（IO 阻塞可接受）；notifyListeners 线程安全
     * （内部经 JavaScriptReplyProxy.postMessage / webView.post 切到主线程发 JS）。
     */
    private fun downloadToMediaStore(displayName: String, url: String, taskId: String?): Uri {
        val resolver = bridge.context?.contentResolver ?: throw IOException("无 ContentResolver")
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, displayName)
            put(MediaStore.Downloads.MIME_TYPE, "audio/*")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val item = resolver.insert(collection, values)
            ?: throw IOException("MediaStore 插入失败：无法写入公共下载目录")

        try {
            val stream = resolver.openOutputStream(item)
                ?: throw IOException("MediaStore 无法打开输出流")
            stream.use { output ->
                val connection = URL(url).openConnection() as HttpURLConnection
                try {
                    connection.connectTimeout = 15_000
                    connection.readTimeout = 60_000
                    connection.instanceFollowRedirects = true
                    // 部分音频 CDN 对默认 UA 会 403，伪装成常规浏览器 UA 最稳。
                    connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36")
                    connection.connect()
                    if (connection.responseCode !in 200..299) {
                        throw IOException("下载服务器返回 ${connection.responseCode}")
                    }

                    // 总大小：Content-Length 缺失（chunked 等）时 total=0，JS 侧只显示已下载。
                    val total = connection.contentLengthLong.takeIf { it > 0 } ?: 0L
                    val buffer = ByteArray(64 * 1024)
                    var downloaded = 0L
                    var lastEmit = 0L
                    connection.inputStream.use { input ->
                        while (true) {
                            // shutdownNow 线程打断 / App 销毁：提前退出，避免残留写盘任务。
                            if (Thread.currentThread().isInterrupted) {
                                throw InterruptedException("下载已中断")
                            }
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            downloaded += read
                            // 进度节流：每 512KB（或每次读完）上报一次，避免高频事件压垮 WebView。
                            if (downloaded - lastEmit >= 512 * 1024) {
                                lastEmit = downloaded
                                val percent = if (total > 0) ((downloaded * 100) / total).toInt().coerceIn(0, 99) else 0
                                emitProgress(taskId, downloaded, total, percent)
                            }
                        }
                    }
                    // 完成上报：进度 100（仅当 total 已知时才算完整百分比；未知则按块节流后仍报 100）。
                    emitProgress(taskId, downloaded, total, 100)
                } finally {
                    connection.disconnect()
                }
            }
            // 写入完成：IS_PENDING 置 0，文件对用户可见。
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(item, values, null, null)
            return item
        } catch (error: Exception) {
            // 写入失败：删除半成品 MediaStore 条目，避免 Download 目录残留坏文件。
            runCatching { resolver.delete(item, null, null) }
            throw if (error is IOException || error is FileNotFoundException) error
            else IOException("下载失败：${error.message}", error)
        }
    }

    /** 文件名净化：去掉 Android 不允许的字符，去掉尾部点/空格，限长。 */
    private fun sanitizeFileName(value: String): String {
        val cleaned = value.map { if (it.code < 32 || it in "<>:\"/\\|?*") '_' else it }.joinToString("")
        return cleaned.replace(Regex("[. ]+$"), "").take(150).ifBlank { "未命名歌曲" }
    }

    /** 扩展名净化：只保留字母数字（如 mp3/m4a/flac），空值回退 mp3。 */
    private fun sanitizeExt(value: String?): String? {
        val ext = value?.trim()?.lowercase()?.removePrefix(".") ?: return null
        return ext.takeIf { it.isNotEmpty() && it.all { c -> c.isLetterOrDigit() || c == '_' } }
    }

    override fun handleOnDestroy() {
        // shutdownNow：打断在途下载（interrupt 置位，读循环里 isInterrupted 检查提前退出），
        // 配合 finally 中已释放的流，不残留写盘任务；比 shutdown 等待下载排空更干净。
        downloadExecutor.shutdownNow()
        super.handleOnDestroy()
    }
}
