# MIST ISLE Android 混淆规则
#
# 只描述 Java 侧：WebView 载入的 assets/app.js + style.css 不含字节码，R8 不会碰它们。
# 但 JS 会通过 evaluateJavascript 调 window.mistIsle* 钩子，Java 侧也会读 BuildConfig，
# 这些名字一旦被改名就断链，必须保留。

# 崩溃兜底里用反射式方式记录线程/堆栈，保留行号便于回读 logcat
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# AndroidX WebKit / Activity 的正常消费方通过清单与资源引用，
# 这里显式保留入口与回调，避免 R8 把 onRenderProcessGone 之类的覆写删掉
-keep class com.mistisle.game.MainActivity { *; }
-keep class com.mistisle.game.BuildConfig { *; }

# WebView 壳直接消费 androidx.webkit（WebViewAssetLoader 拦截 appassets 伪域）。
# 整包保留：壳体只有三个 Java 文件、包体不缺这点体积，稳妥优先。
-keep class androidx.webkit.** { *; }
-keepclassmembers class * extends android.webkit.WebViewClient {
    public *;
}
-keepclassmembers class * extends android.webkit.WebChromeClient {
    public *;
}
-keepclassmembers class * extends android.app.Activity {
    public void onBackPressed();
}

# 不打印 R8 的整包映射（体积换可读性，1.9MB 的包不缺这点）
-dontwarn android.webkit.**
-dontwarn androidx.**
