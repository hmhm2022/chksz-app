package com.chksz.music.mobile;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.GZIPInputStream;

/**
 * 放开 CORS 的 WebViewClient。
 * <p>
 * 移动端数据层跑在 WebView（浏览器环境），对免费老接口（music.163.com / mobiles.kugou.com，
 * 未配 Access-Control-Allow-Origin）的 fetch 会被浏览器 CORS 拦截；桌面端跑在 Electron 主进程
 * （Node fetch 无 CORS）所以正常。
 * <p>
 * 思路：对 WebView 发起的外部 http(s) GET 请求，用原生网络栈（HttpURLConnection）转发，
 * 并在响应头注入 {@code Access-Control-Allow-Origin: *}，从而绕开 Chromium 的 CORS 校验。
 * Capacitor 本地资源（assets / localhost）仍走原 {@link BridgeWebViewClient} 的本地服务处理。
 */
public class CorsRelaxWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "CorsRelax";
    /** 本地服务已处理时返回的 WebResourceResponse 之外的 null 判定：本地服务命中返回非 null。 */
    private static final Set<String> SKIP_HEADERS = Set.of(
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-expose-headers",
        "content-encoding"
    );

    public CorsRelaxWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        // 1. 先让 Capacitor 本地服务处理（assets/localhost 页面资源）。
        WebResourceResponse local = super.shouldInterceptRequest(view, request);
        if (local != null) return local;

        // 2. 仅处理外部 http(s) 的 GET 请求（fetch 跨域场景）；否则放行原逻辑。
        Uri uri = request.getUrl();
        String scheme = uri.getScheme();
        String method = request.getMethod();
        if ((!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) || !"GET".equalsIgnoreCase(method)) {
            return null;
        }

        try {
            WebResourceResponse response = forward(uri, request.getRequestHeaders());
            if (response != null) {
                Logger.debug(TAG, "CORS-relaxed: " + redactedUrl(uri));
            }
            return response;
        } catch (Exception e) {
            Logger.error(TAG, "转发失败 " + redactedUrl(uri) + ": " + e.getMessage(), e);
            return null;
        }
    }

    /** 保留其他查询参数，只隐藏 API 密钥，方便排查接口参数问题。 */
    private static String redactedUrl(Uri uri) {
        Uri.Builder builder = uri.buildUpon().clearQuery();
        for (String name : uri.getQueryParameterNames()) {
            List<String> values = uri.getQueryParameters(name);
            if ("apikey".equalsIgnoreCase(name)) {
                builder.appendQueryParameter(name, "***");
            } else {
                for (String value : values) {
                    builder.appendQueryParameter(name, value);
                }
            }
        }
        return builder.build().toString();
    }

    /** 用原生网络栈转发 GET，注入 ACAO 头。失败返回 null（放行原逻辑）。 */
    private WebResourceResponse forward(Uri uri, Map<String, String> requestHeaders) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(uri.toString()).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            // 透传关键请求头（UA、Referer 等；Cookie 不必，免费接口一般不需要）。
            // 注意不透传 Origin：WebView 页面是 https://localhost，它发起的跨域 fetch 会
            // 自动带 Origin: https://localhost——QQ 的 client_search_cp 等免费接口拒绝该
            // 陌生 Origin（实测返回 400），透传会让免费源在真机全部失效而回退 ChKSz。
            if (requestHeaders != null) {
                for (Map.Entry<String, String> entry : requestHeaders.entrySet()) {
                    String name = entry.getKey();
                    if ("Host".equalsIgnoreCase(name)
                            || "Content-Length".equalsIgnoreCase(name)
                            || "Origin".equalsIgnoreCase(name)) continue;
                    conn.setRequestProperty(name, entry.getValue());
                }
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 400) {
                // 非 2xx/3xx 失败：返回空响应让上层处理（避免暴露原始错误）。
                Logger.debug(TAG, redactedUrl(uri) + " -> HTTP " + code);
                return new WebResourceResponse(
                    "text/plain", "utf-8", code, "Error",
                    Map.of("Access-Control-Allow-Origin", "*"),
                    new ByteArrayInputStream(new byte[0])
                );
            }

            InputStream body = conn.getInputStream();
            String encoding = conn.getContentEncoding();
            if (encoding != null && "gzip".equalsIgnoreCase(encoding)) {
                body = new GZIPInputStream(body);
            }

            String mime = conn.getContentType();
            if (mime != null && mime.contains(";")) mime = mime.substring(0, mime.indexOf(';')).trim();
            String encodingOut = "utf-8";

            Map<String, String> headers = new java.util.LinkedHashMap<>();
            for (Map.Entry<String, java.util.List<String>> entry : conn.getHeaderFields().entrySet()) {
                if (entry.getKey() == null) continue;
                if (SKIP_HEADERS.contains(entry.getKey().toLowerCase())) continue;
                if (entry.getValue() != null && !entry.getValue().isEmpty()) {
                    headers.put(entry.getKey(), entry.getValue().get(0));
                }
            }
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Access-Control-Expose-Headers", "*");

            return new WebResourceResponse(mime != null ? mime : "application/octet-stream", encodingOut, code, "OK", headers, body);
        } catch (IOException | RuntimeException e) {
            Logger.error(TAG, "forward error: " + e.getMessage(), e);
            return null;
        } finally {
            // 不关 conn——body 流由 WebView 消费后由系统回收；此处若关闭会导致流已用。
            // 为安全，记录但不强制关闭（Android WebView 会处理流生命周期）。
        }
    }
}
