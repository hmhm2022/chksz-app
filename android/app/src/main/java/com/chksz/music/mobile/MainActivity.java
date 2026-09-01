package com.chksz.music.mobile;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.chksz.music.player.PlayerPlugin;
import com.chksz.music.system.SystemPlugin;
import com.getcapacitor.BridgeActivity;

import androidx.activity.OnBackPressedCallback;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册自定义插件
        registerPlugin(PlayerPlugin.class);
        registerPlugin(SystemPlugin.class);
        super.onCreate(savedInstanceState);
        relaxWebViewCors();
        interceptBackKey();
    }

    /**
     * 放开 WebView 跨域（CORS）限制。
     * <p>
     * 移动端数据层跑在 WebView（浏览器环境），对免费老接口（music.163.com / mobiles.kugou.com
     * 未配 Access-Control-Allow-Origin）的 fetch 会被浏览器 CORS 拦截；桌面端跑在 Electron 主进程
     * （Node fetch，无 CORS 概念）所以正常。这里把 Chromium 的跨域校验放宽，让免费接口在移动端恢复。
     */
    private void relaxWebViewCors() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        WebSettings settings = webView.getSettings();
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // 核心：外部 http(s) 请求走原生转发 + 注入 ACAO 头，绕开 Chromium CORS。
        getBridge().setWebViewClient(new CorsRelaxWebViewClient(getBridge()));
    }

    /**
     * 拦截系统返回键，实现「弹层优先 → 逐级返回 → home 退出」。
     * <p>
     * Capacitor 8 的 BridgeActivity 不处理返回键（源码确认，无 onBackPressed/OnBackPressedCallback），
     * 默认行为 = Activity finish 直接退出。这里接管：
     * - WebView 内部有历史（canGoBack）时先退 WebView 内导航（当前无 pushState 恒 false，保留未来兼容）；
     * - 否则把系统返回转成 SystemPlugin 的 backButton 事件发给 JS，由 AppState 返回栈逐级处理
     *   （JS 处理完栈空且无可回溯时再调 exitApp() 结束）。
     */
    private void interceptBackKey() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                if (wv != null && wv.canGoBack()) {
                    wv.goBack();
                    return;
                }
                com.chksz.music.system.SystemPlugin plugin =
                        getBridge() != null
                                ? (com.chksz.music.system.SystemPlugin) getBridge().getPlugin("SystemPlugin").getInstance()
                                : null;
                if (plugin != null) {
                    plugin.emitBackButton();
                }
                // plugin 为 null（理论不发生）：什么都不做，返回键无效但不崩溃。
            }
        });
    }
}