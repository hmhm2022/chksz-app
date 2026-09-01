package com.chksz.music.player

import kotlin.random.Random

/**
 * 播放队列数据模型（原生自动切歌用）。
 *
 * 与 JS 侧 `queue-reducer.ts` 的 QueueState 语义对齐（repeatMode 的四种行为一致），
 * 但驱动源不同：JS 版由 UI 事件驱动，这里由 [PlayerPlugin] 的 ENDED 回调驱动，
 * 目的是让原生在 WebView 后台被系统冻结时仍能独立完成跨曲交接。
 *
 * URL 不做长久缓存——每次即将播放某曲才现场解析（[ChkszApi]），避免签名过期
 * 和无谓的额度消耗。
 */

/** 单条队列项：元数据 + 音质档位（已按平台确定），URL 播放前才解析。 */
data class QueueTrack(
    val songKey: String,
    val platform: String,
    val songId: String,
    val quality: String,
    val title: String,
    val artist: String,
    val cover: String,
    /** QQ/酷狗歌词随播放接口一并解析（同响应不重复耗额度）；网易云为空串由 JS 侧补。 */
    var lyric: String = "",
)

/** 与 contracts.ts 的 RepeatMode 一一对应。 */
enum class RepeatMode {
    SEQUENCE, LIST, ONE, SHUFFLE;

    companion object {
        /** JS 传入的字符串（'sequence'|'list'|'one'|'shuffle'）转枚举，未知值兜底 SEQUENCE。 */
        fun fromJs(value: String?): RepeatMode = when (value) {
            "list" -> LIST
            "one" -> ONE
            "shuffle" -> SHUFFLE
            else -> SEQUENCE
        }
    }
}

/**
 * 播放队列：当前曲目 + 循环模式。`nextIndex()` 语义对齐 queue-reducer.ts 的 'ended' 分支：
 * - ONE：原地重播（返回 currentIndex）
 * - SHUFFLE：随机挑一首（尽量避免连续重复同一首）
 * - SEQUENCE：未到尾则 +1，到尾返回 null（表示播完，调用方据此停止/回推 onQueueEnded）
 * - LIST：未到尾则 +1，到尾回 0（循环整单）
 */
class PlaybackQueue {
    var items: List<QueueTrack> = emptyList()
    var currentIndex: Int = -1
    var repeatMode: RepeatMode = RepeatMode.SEQUENCE

    val currentTrack: QueueTrack?
        get() = items.getOrNull(currentIndex)

    fun trackAt(index: Int): QueueTrack? = items.getOrNull(index)

    /** 是否为一个合法的非空队列。 */
    fun isEmpty(): Boolean = items.isEmpty() || currentIndex < 0

    /**
     * 计算播完当前曲后的下一个索引。返回 null 表示队列到尾且非循环，调用方应停止播放。
     */
    fun nextIndex(): Int? {
        if (items.isEmpty() || currentIndex < 0) return null
        return when (repeatMode) {
            RepeatMode.ONE -> currentIndex
            RepeatMode.SHUFFLE -> randomIndex()
            RepeatMode.LIST, RepeatMode.SEQUENCE -> {
                if (currentIndex < items.size - 1) currentIndex + 1
                else if (repeatMode == RepeatMode.LIST) 0
                else null
            }
        }
    }

    /**
     * 手动"下一曲"（用户点击/通知栏/耳机线控）：语义与 nextIndex() 基本一致，
     * 但 SEQUENCE 到尾时不停止，而是钳在最后一首（与桌面/JS 版 queue-reducer.ts
     * 的 'next' 分支一致：到尾且非 list/one 时保持 -1 语义在此实现为"不再前进"）。
     */
    fun manualNextIndex(): Int? {
        if (items.isEmpty() || currentIndex < 0) return null
        return when (repeatMode) {
            RepeatMode.SHUFFLE -> randomIndex()
            RepeatMode.ONE, RepeatMode.LIST -> {
                if (currentIndex < items.size - 1) currentIndex + 1 else 0
            }
            RepeatMode.SEQUENCE -> {
                if (currentIndex < items.size - 1) currentIndex + 1 else null
            }
        }
    }

    /** 手动"上一曲"：不做位置判断（那部分逻辑在播放层用 currentPosition 决定是否先回到 0）。 */
    fun manualPreviousIndex(): Int {
        if (items.isEmpty()) return 0
        return if (currentIndex > 0) currentIndex - 1 else 0
    }

    /** 随机索引：曲目数 >1 时尽量避开当前曲，避免"随机播放却连续重复同一首"的体感问题。 */
    private fun randomIndex(): Int {
        if (items.size <= 1) return 0
        var candidate = Random.nextInt(items.size)
        while (candidate == currentIndex) candidate = Random.nextInt(items.size)
        return candidate
    }
}
