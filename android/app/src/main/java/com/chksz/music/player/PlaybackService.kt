package com.chksz.music.player

import android.app.ActivityManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.MediaSession.ControllerInfo
import com.chksz.music.mobile.MainActivity

/**
 * 后台播放前台服务（Task 8 完整版）。
 *
 * 职责：持有 MediaSession + 系统级通知栏（media3 DefaultMediaNotificationProvider），
 * 保证切后台/锁屏后播放不中断、通知栏可控制。ExoPlayer 与播放逻辑仍在 PlayerPlugin。
 *
 * 关键设计：
 * - 本服务是 media3 官方 MediaSessionService：每次 onStartCommand 都会经 [onGetSession]
 *   取到 MediaSession（由 [PlayerPlugin.createOrGetSession] 提供，内含与 ExoPlayer 相连的
 *   ForwardingPlayer），随后框架 addSession 并接管通知构建/前台语义。
 * - 通知：media3 官方 provider 自动渲染标题/艺术家/封面 + 播放/暂停 + 上一曲/下一曲按钮，
 *   点击通知回 MainActivity；播放中 startForeground，有媒体项（含暂停态）时通知常驻，
 *   无媒体项时自动 stopForeground。
 * - 上一曲/下一曲：被 ForwardingPlayer 拦截后回推 WebView（队列在 JS 侧）。
 * - 会话生命周期归 PlayerPlugin 独有：服务销毁只隔离引用（detach）不 release，
 *   由插件 handleOnDestroy 统一释放——避免 service 释放后插件仍指向已释放会话而崩溃。
 * - 划杀即停播：WebView 随任务销毁，plugin 释放 player/会话，本服务随 stopSelf 结束。
 *   队列在 JS 侧、原生无独立会话，无法脱离 WebView 续播；Home 键后台可正常续播。
 */
class PlaybackService : MediaSessionService() {

    private var mediaSession: MediaSession? = null

    override fun onGetSession(controllerInfo: ControllerInfo): MediaSession? {
        // 缓存已持有的会话，避免每次重建（onGetSession 会被媒体按钮/通知/线控反复调用）。
        mediaSession ?: run { mediaSession = PlayerPlugin.createOrGetSession(this) }
        return mediaSession
    }

    /**
     * PlayerPlugin.startPlaybackService 用普通 startForegroundService 拉起（不含媒体动作 intent），
     * media3 官方 onStartCommand 对这类启动不会主动 addSession——但通知需要在服务启动时就绪。
     * 这里在 super 之后补齐：会话已建则挂到通知管理器（addSession 触发 startForeground），
     * 尚未建（播放器未初始化）则交给 onGetSession 兜底，下次媒体动作/按钮点击时再补。
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val result = super.onStartCommand(intent, flags, startId)
        val session = mediaSession ?: PlayerPlugin.createOrGetSession(this)
        if (session != null && !isSessionAdded(session)) {
            addSession(session)
        }
        // media3 默认返回 START_STICKY；本服务生命周期由 plugin 播放状态驱动，
        // 进程被系统回收后无需重建（WebView 已起不来），显式 NOT_STICKY。
        return START_NOT_STICKY
    }

    /**
     * media3 1.4.1 已知缺陷（androidx/media#2499、#3270）：熄屏后台切歌时（如异步封面
     * 位图加载完成回调），内部 MediaNotificationManager.startForeground() 被 Android 12+
     * 拒绝（mAllowStartForeground=false），且其 catch 块因 player 挂在非主 looper
     * （CapacitorPlugins 线程）而失效 → ForegroundServiceStartNotAllowedException 直接
     * 炸死主线程，表现为"熄屏听几首歌后 App 整个退出"。
     * 服务层拦截：app 不在用户可见态时降级为"仅更新通知内容、不重复提前台"——播放中的
     * 服务本应已是前台；真丢了前台时再提也会被拒，拦掉至少保住进程与播放本身。
     */
    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        val startInForeground = startInForegroundRequired && !isAppInBackground()
        if (startInForegroundRequired && !startInForeground) {
            Log.w("PlaybackService", "suppress startForeground while app in background (media3 #2499/#3270 guard)")
        }
        super.onUpdateNotification(session, startInForeground)
    }

    /** app 是否不在用户可见态（熄屏/切走）。ROM 受限拿不到进程信息时按"前台"放行原行为。 */
    private fun isAppInBackground(): Boolean {
        val am = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        val proc = am.runningAppProcesses?.firstOrNull { it.processName == packageName } ?: return false
        return proc.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    override fun onDestroy() {
        // 只隔离引用，不 release：会话/播放器由 PlayerPlugin.handleOnDestroy 统一释放，
        // 避免"service 释放、插件仍指向已释放会话"导致 media3 Assertions 崩溃。
        mediaSession = null
        super.onDestroy()
    }

    companion object {
        /** 会话所属 Activity：点击通知回 App。 */
        fun buildSessionActivity(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            return PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }
    }
}
