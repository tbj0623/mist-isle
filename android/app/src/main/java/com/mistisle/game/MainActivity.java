package com.mistisle.game;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;

/**
 * MIST ISLE 的安卓壳：一个全屏 WebView 载入 {@code http://appassets.androidplatform.net/assets/index.html}。
 *
 * <p>为「对局中不能丢局」这条硬需求，Activity 做了四件事：
 * <ol>
 *   <li>清单里声明 {@code configChanges}（orientation/screenSize/screenLayout/uiMode…），
 *       旋转与分屏只触发 onConfigurationChanged，不重建 Activity，WebView 里的 Three.js 场景与对局状态原地保留；</li>
 *   <li>返回键走 {@link OnBackPressedCallback}，先把事件交给页面的 {@code window.mistIsleBack()}，
 *       页面返回 true（例如对局中弹出暂停菜单）时绝不 finish()；</li>
 *   <li>前后台切换把 {@code window.mistIsleVisibility(false/true)} 传给页面，并暂停/恢复 WebView 渲染；</li>
 *   <li>渲染进程被系统回收（低内存/驱动崩溃）时 {@code onRenderProcessGone} 返回 true 并原地重建 WebView，
 *       而不是让整个 App 闪退。</li>
 * </ol>
 */
public final class MainActivity extends ComponentActivity {

    private static final String TAG = "MistIsle";
    private static final String LOCAL_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "http://" + LOCAL_HOST + "/assets/index.html";
    private static final int THEME_COLOR = 0xff152c2d;
    /** 崩溃日志保留份数：真机调试够回捞，又不会把用户存储写满。 */
    private static final int CRASH_LOG_KEEP = 20;

    /** 返回键探针：页面已消费返回事件时返回 true（对局中 → 暂停菜单；弹窗打开 → 关弹窗）。 */
    private static final String BACK_PROBE =
            "(function(){try{return !!(window.mistIsleBack && window.mistIsleBack());}catch(e){return false;}})()";

    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private boolean released;
    private static volatile boolean crashLogging;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 对局常亮：WebView 主动开屏的时长可能超过系统默认休眠
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // 音量键调「媒体音量」而不是铃声音量 —— 游戏默认走 STREAM_MUSIC，
        // 不设这一行时按音量键会把手机调成静音/响铃，游戏声音纹丝不动。
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        installCrashHandler();
        configureWindow();
        buildWebView();
        setContentView(webView);
        installImeInsets();
        installBackHandler();
        webView.loadUrl(START_URL);
        applyImmersiveMode();
    }

    // ── 软键盘避让 ────────────────────────────────────────────────────────────

    /**
     * 用 IME inset 给 WebView 让位。
     *
     * <p>清单里的 {@code adjustResize} 在 {@code setDecorFitsSystemWindows(false)} 之后
     * 不再生效（窗口自己接管 inset，系统不再帮忙缩高度），于是软键盘会盖住页面底部 ——
     * 聊天输入框正好在那里。这里监听 {@code ime()} inset，把键盘高度加到底部 padding。
     *
     * <p>只处理 bottom：左右/顶部交给系统的沉浸式与刘海策略（LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES），
     * 给它们加 padding 会让游戏画面在带刘海/挖孔的机器上整体内缩，视觉上明显变差。
     */
    private void installImeInsets() {
        final WebView view = webView;
        ViewCompat.setOnApplyWindowInsetsListener(view, (v, windowInsets) -> {
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(0, 0, 0, ime.bottom);
            // 不消费：系统栏的可见性仍由 WindowInsetsControllerCompat 统一管理
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(view);
    }

    // ── 窗口：沉浸式全屏 + 刘海适配 ────────────────────────────────────────────

    @SuppressWarnings("deprecation")
    private void configureWindow() {
        // 内容自己延伸到系统栏后面，再由 insets controller 隐藏系统栏
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // 刘海屏：短边允许绘制，避免竖屏握持时左右黑边
            WindowManager.LayoutParams attrs = getWindow().getAttributes();
            attrs.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(attrs);
        }
        getWindow().setStatusBarColor(THEME_COLOR);
        getWindow().setNavigationBarColor(THEME_COLOR);
    }

    /** 隐藏状态栏与导航栏（AndroidX 兼容层，minSdk 26 上自动走 SYSTEM_UI_FLAG_*）。 */
    private void applyImmersiveMode() {
        View decor = getWindow().getDecorView();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), decor);
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        controller.hide(WindowInsetsCompat.Type.systemBars());
        decor.setKeepScreenOn(true);
    }

    // ── 生命周期 ──────────────────────────────────────────────────────────────

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript(
                    "try{window.mistIsleVisibility && window.mistIsleVisibility(true);}catch(e){}", null);
        }
        applyImmersiveMode();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript(
                    "try{window.mistIsleVisibility && window.mistIsleVisibility(false);}catch(e){}", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveMode();
    }

    @Override
    protected void onDestroy() {
        released = true;
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ── 返回键：先问页面，页面不认才退出 ──────────────────────────────────────

    private void installBackHandler() {
        OnBackPressedCallback callback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                final WebView view = webView;
                if (view == null) {
                    setEnabled(false);
                    finish();
                    return;
                }
                view.evaluateJavascript(BACK_PROBE, value -> {
                    // 页面返回 true = 已消费（对局中弹暂停菜单 / 关闭顶层弹窗）→ 不退出
                    if ("true".equals(value)) return;
                    // 否则回到系统默认行为（退出 App）
                    setEnabled(false);
                    finish();
                });
            }
        };
        getOnBackPressedDispatcher().addCallback(this, callback);
    }

    /**
     * 兜底：某些 ROM 会直接调用 Activity#onBackPressed（清单里关闭了 predictive back）。
     *
     * <p>这里**故意不调用 super**：ComponentActivity 的 super 实现同样是转交给
     * OnBackPressedDispatcher，再调一次会让返回键被处理两遍（第一次弹暂停菜单、
     * 第二次直接退出）。lint 的 MissingSuperCall 在这里是误报，显式抑制并写明原因。
     */
    @SuppressLint("MissingSuperCall")
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        getOnBackPressedDispatcher().onBackPressed();
    }

    // ── WebView 构建与安全策略 ────────────────────────────────────────────────

    private void buildWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(THEME_COLOR);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        configureSettings(webView.getSettings());

        assetLoader = new WebViewAssetLoader.Builder()
                .setHttpAllowed(true)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new GameWebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (BuildConfig.DEBUG) {
                    Log.d(TAG, message.message() + " @" + message.lineNumber());
                }
                return true;
            }
        });
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureSettings(WebSettings settings) {
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // 只从 appassets 读资源：关掉 file:// 与 content:// 两条旁路
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        // 离线包不需要缓存外的网络资源，避免旧缓存和 APK 内资源打架
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }
    }

    /** 拦截本地资源、外链交给系统浏览器、渲染进程死亡时原地重建。 */
    private final class GameWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url != null && LOCAL_HOST.equals(url.getHost())) {
                WebResourceResponse response = assetLoader.shouldInterceptRequest(url);
                if (response == null) response = notFound();
                return response;
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url != null && LOCAL_HOST.equals(url.getHost())) return false;
            openExternally(url);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            applyImmersiveMode();
        }

        /**
         * SSL 证书错误：**只提示，绝不 proceed**。
         *
         * <p>{@code handler.proceed()} 一旦被调用，WebView 就会无视证书校验继续加载 ——
         * 等于把中间人攻击的窗口打开。游戏连接的是玩家自己的服务器，证书配错是运维问题，
         * 应该让它明确失败（用户看到提示后才能去找运维），而不是悄悄降级。
         * 不调用 proceed / cancel 时系统默认就是取消，这里显式 cancel 只为表达意图。
         */
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            int primary = error != null ? error.getPrimaryError() : -1;
            Log.e(TAG, "SSL error, refusing to load: primary=" + primary + " url="
                    + (error != null ? error.getUrl() : "?"));
            crashLog("ssl-error primary=" + primary + " url=" + (error != null ? error.getUrl() : "?"));
            handler.cancel();
            if (!isFinishing()) {
                Toast.makeText(MainActivity.this, "HTTPS 证书校验失败，已阻止连接", Toast.LENGTH_LONG).show();
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // 渲染进程被回收/崩溃：返回 true 表示 App 自己兜住，不让进程一起走。
            Log.e(TAG, "WebView renderer gone, didCrash=" + detail.didCrash());
            crashLog("render-process-gone didCrash=" + detail.didCrash());
            if (released) return true;
            rebuildWebView(detail.didCrash());
            return true;
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null,
                new java.io.ByteArrayInputStream(new byte[0]));
    }

    /**
     * 外链交给系统浏览器，但**只放行 http/https**。
     *
     * <p>历史实现对任意 scheme 直接 {@code ACTION_VIEW}：页面里一个 {@code intent:}
     * 或 {@code file:} 链接就能把任意 Intent 甩给系统（打开本地文件、跳转其他应用、
     * 甚至触发某些 ROM 的深层链接）。白名单之外一律丢弃。
     */
    private void openExternally(Uri url) {
        if (url == null) return;
        String scheme = url.getScheme();
        if (scheme == null) return;
        scheme = scheme.toLowerCase(Locale.US);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            Log.w(TAG, "blocked non-http(s) link: " + scheme);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "no activity for " + url);
        }
    }

    /**
     * 渲染进程被系统回收后重建 WebView：对局状态在 JS 侧，重载会回到主菜单，
     * 但至少不闪退；离线训练场景下这是可以接受的降级。
     */
    private void rebuildWebView(boolean crashed) {
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent != null) parent.removeView(webView);
        webView.destroy();
        webView = null;
        if (isFinishing() || isDestroyed()) return;
        buildWebView();
        setContentView(webView);
        installImeInsets();
        webView.loadUrl(START_URL);
        applyImmersiveMode();
        if (crashed && BuildConfig.DEBUG) Log.w(TAG, "WebView rebuilt after crash");
    }

    // ── 崩溃兜底：未捕获异常落盘，便于真机调试时回捞 ──────────────────────────

    private void installCrashHandler() {
        if (crashLogging) return;
        crashLogging = true;
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            crashLog("uncaught in " + thread.getName() + "\n" + stackTrace(error));
            if (previous != null) previous.uncaughtException(thread, error);
            else System.exit(1);
        });
    }

    /** 写 {@code getExternalFilesDir("logs")/crash-<时间>.log}；失败也绝不抛出（崩溃路径上再抛会死循环）。 */
    private void crashLog(String text) {
        try {
            File dir = getExternalFilesDir("logs");
            if (dir == null) dir = new File(getFilesDir(), "logs");
            if (!dir.exists() && !dir.mkdirs()) return;
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
            File file = new File(dir, "crash-" + stamp + ".log");
            try (FileWriter writer = new FileWriter(file, true)) {
                writer.write("# " + new Date() + " " + TAG + "\n" + text + "\n\n");
            }
            pruneCrashLogs(dir);
        } catch (Throwable ignored) {
            // 崩溃路径禁止二次抛异常
        }
    }

    /**
     * 只保留最近 {@link #CRASH_LOG_KEEP} 份崩溃日志。
     *
     * <p>文件名里的时间戳是 {@code yyyyMMdd-HHmmss}，字典序即时间序，直接按名字倒序即可。
     * 之前只写不清：反复崩溃的用户，日志目录会无限增长（每个文件还带完整堆栈）。
     * 清理失败不影响写入，异常同样被外层吞掉。
     */
    private static void pruneCrashLogs(File dir) {
        File[] files = dir.listFiles((d, name) -> name.startsWith("crash-") && name.endsWith(".log"));
        if (files == null || files.length <= CRASH_LOG_KEEP) return;
        Arrays.sort(files, Comparator.comparing(File::getName).reversed());
        for (int i = CRASH_LOG_KEEP; i < files.length; i++) {
            //noinspection ResultOfMethodCallIgnored
            files[i].delete();
        }
    }

    private static String stackTrace(Throwable error) {
        StringWriter buffer = new StringWriter();
        error.printStackTrace(new PrintWriter(buffer));
        return buffer.toString();
    }
}
