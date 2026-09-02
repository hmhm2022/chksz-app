package com.chksz.music.player

import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * ChKSz 网关直连（原生侧取播放地址）。
 *
 * 复刻 shared-music/src/api/client.ts 的策略（超时/重试/参数拼装），
 * 但只覆盖"取单曲播放地址"这一个用途——原生侧不需要搜索/歌单等其他接口。
 * 零依赖：用 java.net.HttpURLConnection + org.json（本项目已可用，无需新增 Gradle 依赖）。
 *
 * 三平台字段差异对齐 shared-music/src/api/adapters/{netease,qq,kugou}.ts：
 * - 网易云 /api/163_music：响应 { code, data: { url, ... } }
 * - QQ /api/qq_music：响应顶层带 url（{ url, bitrate/quality, format, ... }）
 * - 酷狗 /api/kugou_music：新版顶层带 url，旧版嵌在 { data: { url, ... } } 里，需兼容
 */
object ChkszApi {
    @Volatile
    private var baseUrl: String = ""
    private const val TAG = "ChkszApi"
    private const val TIMEOUT_MS = 15_000
    private const val MAX_ATTEMPTS = 3
    private const val RETRY_DELAY_MS = 400L

    fun setBaseUrl(url: String) {
        baseUrl = url.trim()
    }

    /**
     * 解析单曲播放地址。三次重试（间隔 400ms），失败抛 IOException 交由调用方处理
     * （PlayerPlugin 会在解析失败时自动跳下一首，语义对齐 JS 侧"整单播放自动跳过"）。
     *
     * 顺带解析歌词字段（QQ/酷狗的歌词与播放地址同一响应）并一并返回：这两个平台没有
     * 独立免费歌词接口，若原生只取 url 不取歌词，JS 事后想要歌词就得重新调同一个
     * ChKSz 收费接口，等于一首歌被扣两次额度——必须在这里一次性拿全。
     * 网易云的歌词走独立免费接口（music.163.com），不受此限制，这里返回空串，
     * JS 侧对网易云单独调用免费歌词接口即可（不产生额外额度消耗）。
     */
    fun resolvePlayback(track: QueueTrack, apiKey: String): ResolvedPlayback {
        if (baseUrl.isBlank()) throw IllegalStateException("请先填写 API 地址")
        val path = buildPath(track)
        var lastError: Exception? = null
        for (attempt in 0 until MAX_ATTEMPTS) {
            if (attempt > 0) Thread.sleep(RETRY_DELAY_MS)
            try {
                val (json, quotaRemaining) = requestJson("$baseUrl$path&apikey=$apiKey")
                val url = extractUrl(track.platform, json)
                if (url.isNotBlank()) {
                    return ResolvedPlayback(
                        url = normalizeHttps(url),
                        lyric = extractLyric(track.platform, json),
                        freeQuotaRemaining = quotaRemaining, // 响应头带真实额度，随播放消耗刷新
                    )
                }
                lastError = IOException("响应中没有可播放地址")
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "resolvePlayback attempt ${attempt + 1}/$MAX_ATTEMPTS failed for ${track.songKey}", e)
            }
        }
        throw IOException("解析播放地址失败：${track.songKey}", lastError)
    }

    private fun buildPath(track: QueueTrack): String {
        val quality = track.quality.ifBlank { "master" }
        return when (track.platform) {
            "netease" -> "/api/163_music?id=${track.songId}&level=${track.quality.ifBlank { "lossless" }}"
            "qq" -> "/api/qq_music?mid=${track.songId}&type=json&size=$quality"
            "kugou" -> "/api/kugou_music?id=${track.songId}&size=$quality"
            else -> throw IllegalArgumentException("unknown platform: ${track.platform}")
        }
    }

    private fun requestJson(url: String): Pair<JSONObject, Int?> {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.setRequestProperty("Accept", "application/json")
            connection.instanceFollowRedirects = true
            val code = connection.responseCode
            if (code !in 200..299) throw IOException("HTTP $code")
            // 免费额度剩余次数（每次成功响应都带该头，实时刷新；与 client.ts 的解析同类）。
            val quotaHeader = connection.getHeaderField("x-quota-free-remaining")
            val quota = quotaHeader?.toIntOrNull()
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            return JSONObject(body) to quota
        } finally {
            connection.disconnect()
        }
    }

    /**
     * 按平台从响应里取 url 字段。
     * 网易云：{ code, data: { url } }；QQ：顶层 { url }；酷狗：新版顶层 { url }，旧版 { data: { url } }。
     */
    private fun extractUrl(platform: String, json: JSONObject): String = when (platform) {
        "netease" -> json.optJSONObject("data")?.optString("url").orEmpty()
        "qq" -> json.optString("url")
        "kugou" -> if (json.has("url")) json.optString("url")
            else json.optJSONObject("data")?.optString("url").orEmpty()
        else -> ""
    }

    /** 与 helpers.ts 的 httpsCover/secureUrl 同语义：播放地址统一升级为 https。 */
    private fun normalizeHttps(url: String): String =
        if (url.startsWith("http://", ignoreCase = true)) "https://" + url.substring(7) else url

    /**
     * 从同一响应里取歌词（仅 QQ/酷狗需要，字段对齐 adapters/{qq,kugou}.ts 的 mapQqDetail/mapKugouDetail）：
     * - QQ：顶层 { lrc } 或 { lyric: { text } }
     * - 酷狗：新版顶层 { lrc }，旧版 { data: { lyrics } }
     * - 网易云：不含歌词字段，返回空串（JS 侧走独立免费接口）
     */
    private fun extractLyric(platform: String, json: JSONObject): String = when (platform) {
        "qq" -> json.optString("lrc").ifBlank {
            json.optJSONObject("lyric")?.optString("text").orEmpty()
        }
        "kugou" -> if (json.has("lrc")) json.optString("lrc")
            else json.optJSONObject("data")?.optString("lyrics").orEmpty()
        else -> ""
    }
}

/** 解析结果：播放地址 + 歌词（QQ/酷狗随播放接口一并返回，网易云为空串）+ 免费额度剩余（响应头）。 */
data class ResolvedPlayback(
    val url: String,
    val lyric: String,
    /** 响应头 x-quota-free-remaining 的值；请求未带或解析失败时为 null。 */
    val freeQuotaRemaining: Int? = null,
)
