package com.chksz.music.player

import android.Manifest
import android.app.ActivityManager
import android.app.ForegroundServiceStartNotAllowedException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * 原生播放桥：WebView -> ExoPlayer（Task 8 完整后台播放）。
 *
 * ExoPlayer 的创建/加载/播放/暂停/seek 全部在此。MediaSession 由 PlaybackService
 * 持有（media3 官方 MediaSessionService），本插件把 ExoPlayer 包一层 [CommandBridgePlayer]
 * 后经 [createOrGetSession] 提供给 service——保证：
 * - MediaSession 状态（播放/暂停/进度/元数据）随 ExoPlayer listener 自动同步；
 * - 通知栏按钮、耳机线控、锁屏控件都驱动同一个 player；
 * - 通知栏/线控的“上一曲/下一曲”命令被 [CommandBridgePlayer] 拦截后，
 *   经 [notifyListeners] 回推 WebView（队列在 JS 侧，原生不知道下一曲是谁）；
 * - 音频焦点由 ExoPlayer 内置 AudioFocusManager 处理：焦点被抢自动暂停，
 *   瞬时失去后恢复自动续播，永久失去则不自动恢复（符合系统惯例）。
 */
@OptIn(UnstableApi::class)
@CapacitorPlugin(
    name = "PlayerPlugin",
    permissions = [
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
    ]
)
class PlayerPlugin : Plugin() {

    private var player: ExoPlayer? = null
    /** 待应用的音量：WebView 先于播放器创建时 setVolume 会被缓存，ExoPlayer 建好后立即应用。 */
    private var pendingVolume: Float? = null
    private var mediaSession: MediaSession? = null
    /**
     * 最近一次通过 onState 推送的播放器状态（用于去重）。
     * 自然播完时 ExoPlayer 会同时触发 onPlaybackStateChanged(ENDED) 与
     * onIsPlayingChanged(false)，两者都调 emitState() 且都算"ended"，
     * 若不去重会把同一首歌的 ended 推两次，JS 队列连跳两首。这里只在
     * 状态真正变化时推送，重复的同状态事件直接丢弃。
     */
    private var lastEmittedState: String? = null
    /**
     * 最近一次播放错误的用户可读消息：onPlayerError 时记录，loadInternal 成功后清空。
     * error 态的 statePayload/getState 会带上它——onError 一次性事件在 JS 订阅空窗期
     * 可能丢失，error 状态本身（含消息）必须能通过状态通道随时补拉。
     */
    private var lastErrorMessage: String? = null
    /**
     * 播放位置周期上报（ExoPlayer 官方推荐做法）。
     * media3 没有"位置正常推进"的回调（Javadoc 明确说明：仅切歌/位置跳变才有事件），
     * 进度条要平滑显示就必须按固定间隔自行轮询 getCurrentPosition()。播放期间每
     * [PROGRESS_REPORT_INTERVAL_MS] 推一次 onProgress；暂停/结束/切歌时移除回调。
     * Handler 绑 ExoPlayer 所在线程（CapacitorPlugins）：player 线程敏感，不能在主线程访问。
     */
    private var progressHandler: Handler? = null
    private val progressRunnable = object : Runnable {
        override fun run() {
            val p = player
            if (p != null) {
                val duration = p.duration
                // 接近末尾（一拍内播完）时直接按满格上报：AUTO 无缝过渡（预排队列非空）
                // 不触发 STATE_ENDED，最后一拍周期上报只会停在 duration-ε，
                // UI 进度条永远"差一点点就被切零"。这里提前一拍宣判满格（误差 ≤ 一拍间隔，
                // 听感无差异），保证切歌前进度条先走到头。
                if (duration != C.TIME_UNSET && duration > 0 &&
                    p.currentPosition >= duration - PROGRESS_REPORT_INTERVAL_MS
                ) {
                    notifyListeners(
                        "onProgress",
                        JSObject().apply {
                            put("state", currentState())
                            put("currentPosition", duration)
                            put("duration", duration)
                        }
                    )
                } else {
                    emitProgress()
                }
            }
            progressHandler?.postDelayed(this, PROGRESS_REPORT_INTERVAL_MS)
        }
    }
    /**
     * 最近一次元数据：每次 load（含切音质重载）都带上，不随 load 清空。
     * 若 updateMetadata 先于 load 到达，同样由其兜底。currentSong.key 不变时
     * JS 不重跑元数据 effect，只有原生记住最近值才能保住通知栏标题/封面。
     */
    private var lastMetadata: MediaMetadata = MediaMetadata.EMPTY
    private val tag = "PlayerPlugin"

    /** 原生持有的播放队列（setQueue 时由 JS 一次性交入），驱动 ENDED 时的自动切歌。 */
    private val queue = PlaybackQueue()
    /**
     * 队列版本：每次换歌或编辑队列都会递增。后台解析完成后必须匹配当前版本，
     * 避免旧歌曲的慢请求晚回来后重新覆盖当前播放。
     */
    @Volatile
    private var queueRevision = 0L
    /** 取地址网络请求的串行执行器：避免阻塞 Capacitor 插件共享的 HandlerThread（同 SystemPlugin 的 downloadExecutor 模式）。 */
    private val resolveExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    /**
     * ENDED 自动切歌解析失败时的连续跳过计数：整单曲目全部解析失败时避免死循环
     * （每首都失败会无限递归 handleEndedInternally），达到队列长度即停止并回推 onQueueEnded。
     */
    private var autoSkipCount = 0
    /**
     * 前台服务启动幂等标志：本次播放会话内已发起过 startForegroundService 就不再重复
     * 拉起（服务保持前台直到 stop）。规避切歌时重复 startFGS 触发
     * ForegroundServiceDidNotStartInTimeException（服务重建间隙 5 秒内未能 startForeground）。
     */
    private var foregroundServiceRequested = false

    /** 加密偏好文件名/键名与 SystemPlugin.kt 完全一致，复用同一份密钥存储（无需 JS 传递密钥）。 */
    private val prefsFileName = "chksz_secure_prefs"
    private val apiKeyName = "chksz_api_key"
    private var masterKey: MasterKey? = null
    private var securePrefs: android.content.SharedPreferences? = null

    /** 读取 WebView 侧已保存的 ChKSz API 密钥；未设置或存储不可用时返回空串。 */
    @Suppress("DEPRECATION")
    private fun readApiKey(): String {
        val context = bridge.context ?: return ""
        return try {
            if (securePrefs == null) {
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
            securePrefs?.getString(apiKeyName, "") ?: ""
        } catch (e: Exception) {
            Log.w(tag, "readApiKey failed", e)
            ""
        }
    }

    private fun getPlayer(): ExoPlayer? {
        if (player == null) {
            val context = bridge.context ?: return null
            val audioAttributes = AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build()
            player = ExoPlayer.Builder(context)
                .setAudioAttributes(audioAttributes, true)
                .setHandleAudioBecomingNoisy(true)
                .build().also {
                    it.addListener(playerListener)
                    it.volume = pendingVolume ?: 1f
                }
        }
        return player
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            // 播完（STATE_ENDED）：若原生持有非空队列，自己解析下一首地址并切歌续播——
            // 不依赖 JS（WebView 后台被系统冻结时 JS 完全不响应，靠 JS 切歌会在后台卡死）。
            // 仍不在此处 stopPlaybackService()：队列到尾真播完时由 handleEndedInternally
            // 内部决定是否停服务，避免跨曲交接瞬间撤掉前台保护导致进程被回收。
            if (playbackState == Player.STATE_ENDED && !queue.isEmpty()) {
                handleEndedInternally()
            }
            if (playbackState == Player.STATE_ENDED) {
                // 播完补发一次满格进度（此时 position=duration）：周期上报已停表，
                // 不补发的话 UI 进度条停在最后一跳（~97%），观感"没走到头就被切零"。
                emitProgress()
            }
            emitState()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            // 播放中：开周期位置上报（进度条平滑推进）；暂停/播完：停表，省电也避免无效推送。
            if (isPlaying) startProgressReporting()
            else stopProgressReporting()
            emitState()
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            // 用媒体项 tag(songKey) 反查逻辑队列索引：不再假设"AUTO 过渡 = 逻辑下一首"。
            // ENDED 兜底路径（handleEndedInternally）会提前 +1，其 addMediaItem 引发的
            // AUTO 过渡若再盲 +1 会双重推进导致跳歌（实测 sequence 下连跳两首）。
            // tag 反查让索引永远跟随真实媒体项，无论过渡原因（AUTO/SEEK）都正确。
            val key = mediaItem?.localConfiguration?.tag as? String
            val logicalIndex = if (key != null) queue.items.indexOfFirst { it.songKey == key } else -1
            if (logicalIndex >= 0 && logicalIndex != queue.currentIndex) {
                queue.currentIndex = logicalIndex
                val track = queue.trackAt(logicalIndex)
                if (track != null) {
                    // 回推 JS：当前播放曲目变更（含歌词，QQ/酷狗随解析带回）
                    notifyListeners("onTrackAutoAdvanced", trackPayload(track, logicalIndex, track.lyric))
                    // 预排窗口尾再下一首，保持队列恒非空（队列尾时才真正触发 ENDED → 循环逻辑）。
                    val afterNext = queue.nextIndex()
                    if (afterNext != null) preloadNext(afterNext, queueRevision)
                }
            }
            // 清掉已消费的窗口项（当前项之前的全部移除），保持窗口不膨胀。
            val p = player
            if (p != null) {
                for (i in p.currentMediaItemIndex - 1 downTo 0) {
                    p.removeMediaItem(i)
                }
            }
            emitState()
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.e(tag, "player error: ${error.message}", error)
            lastErrorMessage = error.message ?: "播放器错误"
            // JS 靠 onError 展示 toast（整单播放时"已自动跳过"）与错误兜底 UI，无论是否自愈都推。
            notifyListeners("onError", errorPayload(lastErrorMessage!!))
            // 自愈：队列非空且未达连续失败上限时，自动解析下一首续播（与 ENDED 兜底同语义）。
            // ERROR 态下 play()/seekToNextMediaItem 均无效，必须走 resolveAndPlay 的
            // setMediaItem+prepare 重建播放状态；ONE 模式 nextIndex() 返回自身=重新解析重播。
            // 连续失败达队列长度即停并回推 onQueueEnded，避免全员失败时无限跳。
            val next = queue.nextIndex()
            if (next != null && autoSkipCount < queue.items.size) {
                autoSkipCount += 1
                queue.currentIndex = next
                resolveAndPlay(next, queueRevision)
            } else if (queue.items.isNotEmpty() && autoSkipCount >= queue.items.size) {
                queue.currentIndex = -1
                notifyListeners("onQueueEnded", JSObject())
            }
            emitState()
        }

        override fun onEvents(player: Player, events: Player.Events) {
            // 事件兜底立即补发一次进度（如 seek、buffer 变化秒级同步）；
            // 正常播放的平滑推进由 startProgressReporting() 的周期上报负责。
            emitProgress()
        }
    }

    /**
     * 开启周期位置上报：幂等（已在跑则不再重复排队），播放期间每 [PROGRESS_REPORT_INTERVAL_MS] 推一次。
     * 在 Player.Listener 回调里调用（onIsPlayingChanged），此时 Looper 正是 ExoPlayer 所在的
     * CapacitorPlugins 线程，Handler 绑该线程 Looper 才能安全访问 player。
     */
    private fun startProgressReporting() {
        val handler = progressHandler ?: Handler(Looper.myLooper() ?: Looper.getMainLooper()).also { progressHandler = it }
        handler.removeCallbacks(progressRunnable)
        handler.postDelayed(progressRunnable, PROGRESS_REPORT_INTERVAL_MS)
    }

    /** 停止周期上报：暂停/播完/切歌时调用，避免后台无谓推送。 */
    private fun stopProgressReporting() {
        progressHandler?.removeCallbacks(progressRunnable)
    }

    private fun currentState(): String {
        val p = player ?: return "idle"
        // 有未处理错误时如实上报 error：此前伪装成 "paused"，JS 侧完全不知道播放器已死，
        // 用户点播放（裸 play()）毫无反应，表现为"进度条冻结 + 点播放没用"。
        if (p.playerError != null) return "error"
        return when {
            p.playbackState == Player.STATE_IDLE -> "idle"
            p.playbackState == Player.STATE_BUFFERING -> "loading"
            p.playbackState == Player.STATE_ENDED -> "ended"
            p.isPlaying -> "playing"
            else -> "paused"
        }
    }

    private fun statePayload(): JSObject {
        val p = player ?: return JSObject().apply { put("state", "idle") }
        val state = currentState()
        return JSObject().apply {
            put("state", state)
            put("currentPosition", p.currentPosition)
            put("duration", p.duration)
            // error 态带上最近一次错误消息，供 onState/getState 通道一并到达 JS
            // （onError 是一次性事件，订阅空窗期会丢；error 状态本身可随时补拉）。
            if (state == "error") put("message", lastErrorMessage ?: "播放器错误")
        }
    }

    private fun emitState() {
        val state = currentState()
        // 状态真实变化才推送；同一状态重复触发（如二合一回调）丢弃，避免 JS 重复处理 ended。
        // 切歌时 load() 会通过 resetLastEmittedState() 清空，保证新歌首次状态必达。
        if (state == lastEmittedState) return
        lastEmittedState = state
        notifyListeners("onState", statePayload())
    }

    /** load() 切歌前调用：重置去重游标，确保新歌的首次状态上报不落空。 */
    private fun resetLastEmittedState() {
        lastEmittedState = null
    }

    private fun emitProgress() {
        notifyListeners("onProgress", statePayload())
    }

    /**
     * 把命令事件回推 WebView。用户点通知栏“下一曲/上一曲”或耳机线控时，
     * 队列在 JS 侧，原生无法直接切歌，只能把命令告诉 usePlayer 由它切换。
     */
    private fun emitCommand(command: String) {
        notifyListeners("onCommand", JSObject().apply { put("command", command) })
    }

    @PluginMethod
    fun setBaseUrl(call: PluginCall) {
        val url = call.getString("url")?.trim().orEmpty()
        ChkszApi.setBaseUrl(url)
        call.resolve()
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("url is required")
            return
        }
        val p = getPlayer()
        if (p == null) {
            call.reject("player init failed")
            return
        }
        // 元数据用最近一次值（含当前曲目标题/艺术家/封面），切音质重载不丢。
        val mediaItem = MediaItem.Builder()
            .setUri(url)
            .setMediaMetadata(lastMetadata)
            .build()
        p.setMediaItem(mediaItem)
        p.prepare()
        // 切歌后重置去重游标并主动推一次新歌的加载状态，避免上一首的 ended 残留
        // 抑制新歌首次状态（setMediaItem 过渡期可能短暂回 idle，此处已过 prepare）。
        resetLastEmittedState()
        emitState()
        call.resolve()
    }

    /**
     * JS 播放一个多曲队列时调用：把曲目列表 + 起播索引 + 循环模式一次性交给原生。
     * 原生随即解析 startIndex 曲目的地址并 load+play；此后播完（ENDED）不再需要 JS
     * 参与——由 [handleEndedInternally] 自己解析下一首。
     *
     * @param call.items       JSON 数组，每项 {songKey, platform, songId, quality, title, artist, cover}
     * @param call.startIndex  起播索引（默认 0）
     * @param call.repeatMode  'sequence'|'list'|'one'|'shuffle'（默认 sequence）
     */
    @PluginMethod
    fun setQueue(call: PluginCall) {
        val itemsArray = call.getArray("items")
        if (itemsArray == null) {
            call.reject("items is required")
            return
        }
        val items = try {
            parseQueueItems(itemsArray)
        } catch (e: Exception) {
            call.reject("items 格式不合法", e)
            return
        }
        val startIndex = (call.getInt("startIndex") ?: 0).coerceIn(0, (items.size - 1).coerceAtLeast(0))
        val revision = bumpQueueRevision()
        queue.items = items
        queue.currentIndex = if (items.isEmpty()) -1 else startIndex
        queue.repeatMode = RepeatMode.fromJs(call.getString("repeatMode"))
        autoSkipCount = 0

        if (queue.isEmpty()) {
            player?.clearMediaItems()
            call.resolve()
            return
        }
        call.resolve()
        // 解析 + 播放在后台线程做，避免网络请求阻塞 Capacitor 插件线程。
        resolveAndPlay(queue.currentIndex, revision)
    }

    /** JS 切平台/切音质等场景更新循环模式（不影响当前播放）。 */
    @PluginMethod
    fun setRepeatMode(call: PluginCall) {
        queue.repeatMode = RepeatMode.fromJs(call.getString("mode"))
        call.resolve()
    }

    /**
     * 同步队列内容/当前索引，不打断仍在播放的当前歌曲。
     * 清理 ExoPlayer 中旧的后续预加载项，再按新列表准备下一首；若当前媒体项已不存在，
     * 才重新解析当前曲目。用于插队、排序、删除非当前播放项等编辑场景。
     */
    @PluginMethod
    fun updateQueueItems(call: PluginCall) {
        val itemsArray = call.getArray("items")
        if (itemsArray == null) {
            call.reject("items is required")
            return
        }
        val items = try {
            parseQueueItems(itemsArray)
        } catch (e: Exception) {
            call.reject("items 格式不合法", e)
            return
        }
        val revision = bumpQueueRevision()
        queue.items = items
        val currentIndex = call.getInt("currentIndex") ?: queue.currentIndex
        queue.currentIndex = if (items.isEmpty()) -1 else currentIndex.coerceIn(0, items.size - 1)
        val p = player
        if (queue.isEmpty()) {
            p?.clearMediaItems()
            call.resolve()
            return
        }

        // 当前歌曲继续播放，只移除 ExoPlayer 中当前项后面旧的预加载项。
        if (p != null && p.currentMediaItemIndex >= 0 && p.mediaItemCount > p.currentMediaItemIndex + 1) {
            p.removeMediaItems(p.currentMediaItemIndex + 1, p.mediaItemCount)
        }
        val currentTrack = queue.currentTrack
        val mediaTag = p?.currentMediaItem?.localConfiguration?.tag as? String
        if (currentTrack != null && mediaTag != currentTrack.songKey) {
            // 当前媒体项已不存在或与逻辑队列不一致：需要重新解析当前曲目。
            resolveAndPlay(queue.currentIndex, revision)
        } else {
            // 当前媒体项仍在，按新队列重新准备下一首。
            queue.nextIndex()?.let { preloadNext(it, revision) }
        }
        call.resolve()
    }

    /**
     * 手动下一曲（通知栏按钮/耳机线控回推的 onCommand 由 JS 转调，或 JS 直接调用）。
     * 走 resolveAndPlay 重建窗口（逻辑正确优先，虽会重载媒体项但无并发风险）。
     */
    @PluginMethod
    fun next(call: PluginCall) {
        val target = queue.manualNextIndex()
        if (target == null) {
            call.resolve()
            return
        }
        queue.currentIndex = target
        val revision = bumpQueueRevision()
        autoSkipCount = 0 // 手动切歌：连续失败计数归零（新起点）
        call.resolve()
        resolveAndPlay(target, revision)
    }

    /** 手动上一曲：与 next 对称，位置判断（"已播超3秒回开头"）逻辑仍在 JS 侧，这里只管切歌。 */
    @PluginMethod
    fun previous(call: PluginCall) {
        val target = queue.manualPreviousIndex()
        queue.currentIndex = target
        val revision = bumpQueueRevision()
        autoSkipCount = 0 // 手动切歌：连续失败计数归零（新起点）
        call.resolve()
        resolveAndPlay(target, revision)
    }

    /** 把 JS 传入的 JSON 数组解析成 QueueTrack 列表。 */
    private fun parseQueueItems(array: JSArray): List<QueueTrack> {
        val result = mutableListOf<QueueTrack>()
        for (i in 0 until array.length()) {
            val item = array.getJSONObject(i)
            result.add(
                QueueTrack(
                    songKey = item.getString("songKey"),
                    platform = item.getString("platform"),
                    songId = item.getString("songId"),
                    quality = item.optString("quality", ""),
                    title = item.optString("title", ""),
                    artist = item.optString("artist", ""),
                    cover = item.optString("cover", ""),
                )
            )
        }
        return result
    }

    /**
     * 队列尾处理（ExoPlayer 播完最后一个媒体项、触发 STATE_ENDED 时调用）。
     *
     * 有了原生多曲队列后，ExoPlayer 在队列**非空**时会自动无缝切下一首（不触发 ENDED），
     * 因此这里只处理"真的到尾"的情况：
     * - sequence 到尾：回推 onQueueEnded，由 JS 决定是否 stop() 服务
     * - list/one/shuffle 循环：按 repeatMode 补下一首到队列尾（预解析 addMediaItem）继续播
     *
     * 关键价值：media3 队列**非空**时不会自动 stopForeground（前台服务保持），
     * 规避"跨曲瞬间队列空 → 停前台 → 后台重建通知 → ForegroundServiceStartNotAllowedException FATAL"。
     */
    private fun handleEndedInternally() {
        val next = queue.nextIndex()
        if (next == null) {
            queue.currentIndex = -1
            notifyListeners("onQueueEnded", JSObject())
            return
        }
        queue.currentIndex = next
        // 循环模式：解析下一首排进 ExoPlayer 队列尾后**再**恢复播放（onAdded 回调）。
        // ENDED 后光标停在旧曲末尾：必须显式 seekToNextMediaItem 才能离开 ENDED 态开播，
        // 单纯 play() 只置 playWhenReady，实测卡在 STOPPED@0 不出声。
        preloadNext(next, queueRevision,
            onAdded = {
                val p = player ?: return@preloadNext
                if (p.playbackState == Player.STATE_ENDED && p.hasNextMediaItem()) {
                    p.seekToNextMediaItem()
                }
                p.play()
            },
            onFailure = {
                // 解析失败自动跳下一首（与 resolveAndPlay 失败同语义）；
                // 连续失败达队列长度即停，避免全员失败时无限递归。
                autoSkipCount += 1
                if (autoSkipCount >= queue.items.size) {
                    queue.currentIndex = -1
                    notifyListeners("onQueueEnded", JSObject())
                } else {
                    handleEndedInternally()
                }
            })
    }

    /**
     * 在 [resolveExecutor] 后台线程解析 index 对应曲目的播放地址，成功后回主线程
     * load+play 并回推 onTrackAutoAdvanced；失败则回推 onError 并自动跳到下一首
     * （对齐 JS 侧"整单播放自动跳过不可播放曲目"的既有语义），达到队列长度上限
     * 时停止递归，避免全员解析失败时无限循环。
     */
    private fun resolveAndPlay(index: Int, revision: Long) {
        val track = queue.trackAt(index) ?: return
        val songKey = track.songKey
        val nextIndex = queue.nextIndex() // 当前曲之后的下一首索引（用于预排）
        resolveExecutor.execute {
            try {
                val apiKey = readApiKey()
                if (apiKey.isBlank()) throw IllegalStateException("未设置 API 密钥")
                val resolved = ChkszApi.resolvePlayback(track, apiKey)
                track.lyric = resolved.lyric
                bridge.execute {
                    if (!isRequestCurrent(revision, index, songKey)) return@execute
                    loadInternal(resolved.url, track, nextIndex, revision)
                    notifyListeners("onTrackAutoAdvanced", trackPayload(track, index, resolved.lyric))
                    // 播放消耗额度：响应头带的新额度推给 JS 落库（额度自动刷新）。
                    emitQuotaIfAny(resolved.freeQuotaRemaining)
                }
            } catch (e: Exception) {
                Log.w(tag, "resolveAndPlay failed for ${track.songKey}", e)
                bridge.execute {
                    if (!isRequestCurrent(revision, index, songKey)) return@execute
                    val message = if (e.message == "请先填写 API 地址") {
                        e.message!!
                    } else {
                        "「${track.title}」暂时无法播放，已自动跳过"
                    }
                    lastErrorMessage = message
                    notifyListeners("onError", errorPayload(message))
                    autoSkipCount += 1
                    if (autoSkipCount >= queue.items.size) {
                        // 整单全部解析失败：停止递归，回推播完事件，避免死循环。
                        queue.currentIndex = -1
                        notifyListeners("onQueueEnded", JSObject())
                    } else {
                        handleEndedInternally()
                    }
                }
            }
        }
    }

    /**
     * 在后台线程解析 index 曲目的播放地址，成功后把媒体项 addMediaItem 进 ExoPlayer 队列尾。
     * 供 loadInternal 在当前曲播放时预排下一首；也让 ENDED 自动切歌时队列始终保持非空。
     *
     * @param onAdded 媒体项成功 addMediaItem 进队列后（CapacitorPlugins 线程）回调。
     *                ENDED 自动切歌用它驱动"先有媒体项、再 seek+play"，避免 play() 空转。
     * @param onFailure 解析失败（CapacitorPlugins 线程）回调。ENDED 兜底场景传它实现
     *                  自动跳下一首；正常播放的预排失败不传，静默不打断当前曲。
     */
    private fun preloadNext(index: Int, revision: Long = queueRevision, onAdded: (() -> Unit)? = null, onFailure: (() -> Unit)? = null) {
        val track = queue.trackAt(index) ?: return
        val songKey = track.songKey
        resolveExecutor.execute {
            try {
                val apiKey = readApiKey()
                if (apiKey.isBlank()) throw IllegalStateException("未设置 API 密钥")
                val resolved = ChkszApi.resolvePlayback(track, apiKey)
                track.lyric = resolved.lyric
                bridge.execute {
                    if (!isRequestCurrent(revision, index, songKey)) return@execute
                    val p = player ?: return@execute
                    val mediaItem = MediaItem.Builder()
                        .setUri(resolved.url)
                        .setMediaMetadata(metadataFor(track))
                        // tag 带逻辑队列 songKey：onMediaItemTransition 靠它反查索引，
                        // 替代"AUTO 过渡盲 +1"（会与 ENDED 兜底的提前 +1 叠加导致跳歌）。
                        .setTag(track.songKey)
                        .build()
                    // 只 add 不播：ExoPlayer 播完当前曲会自动切到它。
                    p.addMediaItem(mediaItem)
                    onAdded?.invoke()
                    // 预解析也消耗额度（取地址请求），回推最新额度刷新展示。
                    emitQuotaIfAny(resolved.freeQuotaRemaining)
                }
            } catch (e: Exception) {
                Log.w(tag, "preloadNext failed for ${track.songKey}", e)
                // 正常播放的预排失败静默（不打断当前曲）；ENDED 兜底场景经 onFailure 跳下一首。
                if (onFailure != null) {
                    bridge.execute {
                        if (isRequestCurrent(revision, index, songKey)) onFailure()
                    }
                }
            }
        }
    }

    /**
     * ExoPlayer 侧真正的 load+play，供 setQueue/next/previous/自动切歌复用（必须在 CapacitorPlugins 线程调用）。
     * 加载当前曲后，立即在后台预解析下一首并排进队列尾，保证 ExoPlayer 队列恒非空——
     * 这样 ENDED 时 media3 自动切到下一首，不会因队列空而停前台服务（规避 FATAL 崩溃链）。
     */
    private fun loadInternal(url: String, track: QueueTrack, preloadNextIndex: Int? = null, revision: Long = queueRevision) {
        val p = getPlayer() ?: return
        lastMetadata = metadataFor(track)
        // 新媒体项 prepare 会清除 ERROR 态：同步清掉错误消息记忆，避免状态通道残留旧错误。
        lastErrorMessage = null
        // tag 带逻辑队列 songKey：onMediaItemTransition 靠它反查索引（与 preloadNext 一致）。
        val mediaItem = MediaItem.Builder().setUri(url).setMediaMetadata(lastMetadata).setTag(track.songKey).build()
        p.setMediaItem(mediaItem)
        p.prepare()
        resetLastEmittedState()
        p.play()
        startPlaybackService()
        emitState()
        // 预解析下一首（若有）排进 ExoPlayer 队列尾，让队列在播放期间恒非空。
        preloadNextIndex?.let { preloadNext(it, revision) }
    }

    /** 检查后台解析结果是否仍属于当前队列版本和同一首歌。只能在插件线程读取播放器状态。 */
    private fun isRequestCurrent(revision: Long, index: Int, songKey: String): Boolean =
        queueRevision == revision && queue.trackAt(index)?.songKey == songKey

    /** 队列操作统一从插件线程递增版本号；后台线程只读取 @Volatile 值。 */
    private fun bumpQueueRevision(): Long {
        queueRevision += 1
        return queueRevision
    }

    /** 由 QueueTrack 构建 MediaMetadata（通知栏/锁屏展示用），load 与预排共用。 */
    private fun metadataFor(track: QueueTrack): MediaMetadata =
        MediaMetadata.Builder()
            .setTitle(track.title)
            .setArtist(track.artist)
            .apply { if (track.cover.isNotBlank()) setArtworkUri(Uri.parse(track.cover)) }
            .build()

    private fun trackPayload(track: QueueTrack, index: Int, lyric: String): JSObject = JSObject().apply {
        put("songKey", track.songKey)
        put("index", index)
        // QQ/酷狗歌词随播放接口一并解析（同一响应，不重复耗额度）；网易云为空串，
        // JS 侧对网易云仍走独立免费歌词接口（fetchNeteaseLyricFree）补齐。
        put("lyric", lyric)
    }

    private fun errorPayload(message: String): JSObject = JSObject().apply {
        put("state", "error")
        put("message", message)
    }

    /** 把响应头里的免费额度剩余推给 JS（额度自动刷新）。null 表示请求未带该头，不发。 */
    private fun emitQuotaIfAny(freeQuota: Int?) {
        if (freeQuota == null) return
        notifyListeners("onQuota", JSObject().apply { put("freeQuota", freeQuota) })
    }

    @PluginMethod
    fun play(call: PluginCall) {
        val p = player
        if (p == null) {
            call.reject("player not loaded")
            return
        }
        p.play()
        startPlaybackService()
        requestNotificationsPermissionIfNeeded()
        call.resolve()
    }

    /**
     * JS 主动拉取当前播放状态（含 position/duration/错误消息）：
     * onState/onProgress 是推送式事件，JS 侧订阅重建（切歌等 effect 重跑）存在空窗，
     * 空窗期的事件会永久丢失——重订阅完成后调这个补齐最新快照，状态不再依赖"恰好没丢"。
     * 附带队列索引/当前曲目元数据：熄屏期间 WebView 冻结会吞掉 onTrackAutoAdvanced，
     * JS 回前台靠这些字段与原生对账（发现索引漂移即全量同步封面/歌词）。
     */
    @PluginMethod
    fun getState(call: PluginCall) {
        val payload = statePayload()
        payload.put("currentIndex", queue.currentIndex)
        val p = player
        val tag = p?.currentMediaItem?.localConfiguration?.tag as? String
        if (tag != null) payload.put("currentSongKey", tag)
        // 歌词/元数据取自逻辑队列当前项（QQ/酷狗随解析带回并缓存，网易云为空串由 JS 补齐）
        queue.trackAt(queue.currentIndex)?.let { track ->
            payload.put("title", track.title)
            payload.put("artist", track.artist)
            payload.put("cover", track.cover)
            payload.put("lyric", track.lyric)
        }
        call.resolve(payload)
    }

    /**
     * Android 13+ 通知栏权限：首次播放前顺手请求一次（fire-and-forget）。
     * 拒绝不影响播放，只是通知不进抽屉（前台服务仍可运行）；
     * 系统已弹过且用户选了"不再询问"后，本调用静默返回不再弹框。
     * 请求结果不消费（无 PluginCall 需要 resolve），grant 状态由系统持久化。
     */
    private fun requestNotificationsPermissionIfNeeded() {
        val context = bridge.context ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        // 自定义 requestCode：不依赖 Capacitor 的 @PermissionCallback 路由，仅用于系统回调归并。
        // 故意用已弃用的 pluginRequestPermission（fire-and-forget，无 PluginCall 要 resolve）。
        @Suppress("DEPRECATION")
        pluginRequestPermission(Manifest.permission.POST_NOTIFICATIONS, REQUEST_NOTIFICATIONS_PERMISSION)
    }

    /**
     * JS 在 currentSong 变化时调用：把标题/艺术家/封面写进当前 MediaItem 的元数据，
     * 通知栏/锁屏即展示（media3 在元数据变化时自动重建通知）。
     * 封面走 HTTP 下载，失败不影响标题/艺术家展示。
     * 记录为 lastMetadata，切音质重载/先于 load 到达时都由 load 一并带上。
     */
    @PluginMethod
    fun updateMetadata(call: PluginCall) {
        val title = call.getString("title")
        val artist = call.getString("artist")
        val coverUrl = call.getString("coverUrl")
        lastMetadata = MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(artist)
            .apply {
                if (!coverUrl.isNullOrBlank()) setArtworkUri(Uri.parse(coverUrl))
            }
            .build()

        val p = player ?: run { call.resolve(); return }
        val current = p.currentMediaItem
        if (current != null) {
            // 原位替换当前媒体项：不改 URI、不打断播放，只更新通知栏展示的元数据。
            p.replaceMediaItem(p.currentMediaItemIndex, current.buildUpon().setMediaMetadata(lastMetadata).build())
        }
        call.resolve()
    }

    /**
     * 启动（或复用）前台播放服务。做了两重防护，避免后台跨曲交接时被系统拒导致 FATAL：
     * - 幂等：服务已在前台（isForeground）就不再重复 start，跨曲交接时服务本该还挂着；
     * - 容错：后台（如刚从后台恢复的服务已被回收）时 start 会被 Android 拒抛
     *   ForegroundServiceStartNotAllowedException，这里捕住并静默降级——媒体播放本身
     *   不依赖前台服务，只是通知栏/后台保护暂时缺失，下次回到前台播放会重新拉起。
     */
    private fun startPlaybackService() {
        val context = bridge.context ?: return
        // 已发起过启动（本会话内）或服务已在前台 → 不重复拉起。
        if (foregroundServiceRequested || isPlaybackServiceForeground()) return
        val intent = Intent(context, PlaybackService::class.java)
        try {
            // 仅当 MediaSession 可建出时才 startFGS：media3 MediaSessionService 依赖 session
            // 来做 startForeground()。session 建不出时 startFGS 是"必崩"（5 秒限时内无 startForeground），
            // 此时静默降级——播放本身不依赖前台服务，只是通知栏/后台保护暂时缺失。
            val session = PlayerPlugin.createOrGetSession(context)
            if (session == null) {
                Log.w(tag, "MediaSession not ready, skip startForegroundService (degraded mode)")
                return
            }
            foregroundServiceRequested = true
            // startForegroundService 是 API 26+，minSdk 24/25 用 startService
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (e: ForegroundServiceStartNotAllowedException) {
            // 后台启动前台服务被系统拒绝：不抛 FATAL，静默降级（播放不依赖前台服务）。
            Log.w(tag, "startForegroundService denied in background, playback continues without FGS", e)
        }
    }

    /**
     * 检查 PlaybackService 当前是否处于前台运行状态（isForeground=true）。
     * 用 ActivityManager 查服务记录，避免重复 startForegroundService（后台重入会被系统拒）。
     */
    private fun isPlaybackServiceForeground(): Boolean {
        val context = bridge.context ?: return false
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        val services = am.getRunningServices(100)
        return services.any { it.service?.className == PlaybackService::class.java.name && it.foreground }
    }

    private fun stopPlaybackService() {
        val context = bridge.context ?: return
        context.stopService(Intent(context, PlaybackService::class.java))
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val p = player
        if (p == null) {
            call.reject("player not loaded")
            return
        }
        p.pause()
        call.resolve()
    }

    /**
     * JS 在「队列播完、无下一首」时调用：暂停播放并主动停掉前台服务。
     * 停掉后进程失去前台保护，可被系统正常回收；下次 play() 会重新拉起服务（幂等）。
     * 与旧的「ENDED 时无条件停服务」不同：这里由 JS 判断确认队列真播完了才停，
     * 避免跨曲交接瞬间撤掉前台保护导致后台进程被杀（曾观测到 appDiedLocked）。
     */
    @PluginMethod
    fun stop(call: PluginCall) {
        val p = player
        if (p != null && p.isPlaying) {
            p.pause()
        }
        // 清空逻辑队列和 ExoPlayer 媒体项，同时作废所有在途解析，避免停止后旧结果重新开播。
        bumpQueueRevision()
        queue.items = emptyList()
        queue.currentIndex = -1
        p?.clearMediaItems()
        stopPlaybackService()
        // 停掉了前台服务，重置幂等标志：下次播放需要重新拉前台保护。
        foregroundServiceRequested = false
        call.resolve()
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val p = player
        if (p == null) {
            call.reject("player not loaded")
            return
        }
        val positionMs = call.getInt("positionMs")
        if (positionMs == null) {
            call.reject("positionMs is required")
            return
        }
        p.seekTo(positionMs.toLong())
        call.resolve()
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val p = player ?: getPlayer()
        if (p == null) {
            call.reject("player init failed")
            return
        }
        val volume = call.getFloat("volume") ?: 1f
        pendingVolume = volume
        p.volume = volume.coerceIn(0f, 1f)
        call.resolve()
    }

    /** 插件初始化钩子：登记单例供 PlaybackService 静态取用。 */
    override fun load() {
        super.load()
        instance = this
    }

    override fun handleOnDestroy() {
        stopProgressReporting()
        resolveExecutor.shutdownNow()
        player?.removeListener(playerListener)
        player?.release()
        player = null
        pendingVolume = null
        lastMetadata = MediaMetadata.EMPTY
        foregroundServiceRequested = false
        // 会话/播放器统一由插件释放（单一属主）：service 销毁只置空引用不 release。
        synchronized(Companion::class.java) {
            mediaSession?.release()
            mediaSession = null
        }
        instance = null
        stopPlaybackService()
        super.handleOnDestroy()
    }

    companion object {
        /** 插件单例：Capacitor 生命周期内 PlayerPlugin 只有一个实例，service 静态取用。 */
        @Volatile
        private var instance: PlayerPlugin? = null

        /** POST_NOTIFICATIONS 请求码（仅用于系统回调归并，不接 Capacitor 回调路由）。 */
        private const val REQUEST_NOTIFICATIONS_PERMISSION = 4097

        /** 播放进度周期上报间隔（毫秒）。500ms 居中于各主流实现（250ms~1000ms），
         * 与 JS 侧进度条 transition 0.2s 搭配视觉平滑，功耗也可控。 */
        private const val PROGRESS_REPORT_INTERVAL_MS = 500L

        /**
         * 取（或懒建）与 ExoPlayer 相连的 MediaSession，多次调用返回同一实例。
         * 会话生命周期归插件独有（单一属主）：只有 plugin.handleOnDestroy 会 release 并同步
         * 置空 mediaSession/instance，service 销毁只隔离自有引用——因此这里返回的会话
         * 不可能处于 released 态，天然规避"复用已释放会话 → media3 Assertions 崩溃"。
         */
        fun createOrGetSession(context: Context): MediaSession? {
            val plugin = instance ?: return null
            synchronized(Companion::class.java) {
                plugin.mediaSession?.let { return it }
                val p = plugin.getPlayer() ?: return null
                val session = MediaSession.Builder(context, CommandBridgePlayer(p, plugin::emitCommand))
                    .setSessionActivity(PlaybackService.buildSessionActivity(context))
                    .build()
                plugin.mediaSession = session
                return session
            }
        }

        /**
         * ExoPlayer 桥接 MediaSession 的命令桥。原生已持有完整播放队列（media3 原生多曲队列），
         * 因此"上一曲/下一曲"（通知栏按钮、耳机线控、锁屏控件都会走这里）**直接转发给底层
         * ExoPlayer**——由 media3 在原生队列里切歌（onMediaItemTransition 会同步 JS）。
         * hasNext/hasPrevious 保持恒真：让系统始终渲染切歌按钮（队列尾部由 ExoPlayer
         * 自然停住，不依赖按钮态）。
         */
        private class CommandBridgePlayer(
            player: Player,
            private val onCommand: (String) -> Unit,
        ) : ForwardingPlayer(player) {
            override fun seekToNextMediaItem() {
                val p = wrappedPlayer
                if (p.hasNextMediaItem()) p.seekToNextMediaItem()
                else onCommand("next") // 队列尾：回推 JS，由 JS 决定（如循环重发队列或停）
            }

            override fun seekToNext() {
                val p = wrappedPlayer
                if (p.hasNextMediaItem()) p.seekToNext()
                else onCommand("next")
            }

            override fun seekToPreviousMediaItem() {
                val p = wrappedPlayer
                if (p.hasPreviousMediaItem()) p.seekToPreviousMediaItem()
                else onCommand("prev")
            }

            override fun seekToPrevious() {
                val p = wrappedPlayer
                if (p.hasPreviousMediaItem()) p.seekToPrevious()
                else onCommand("prev")
            }

            override fun hasNextMediaItem(): Boolean = true

            override fun hasPreviousMediaItem(): Boolean = true

            override fun isCommandAvailable(commandCode: Int): Boolean =
                when (commandCode) {
                    Player.COMMAND_SEEK_TO_NEXT,
                    Player.COMMAND_SEEK_TO_PREVIOUS,
                    Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                    Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                    -> true
                    else -> super.isCommandAvailable(commandCode)
                }

            override fun getAvailableCommands(): Player.Commands =
                super.getAvailableCommands()
                    .buildUpon()
                    .add(Player.COMMAND_SEEK_TO_NEXT)
                    .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                    .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                    .build()
        }
    }
}
