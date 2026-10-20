package com.roleplay.groupchat;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.drawable.Animatable;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.animation.PathInterpolator;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 唯一 Activity：全屏 WebView 装前端，底部输入条由系统键盘"压缩页面"自然顶起。
 *
 * 键盘：targetSdk 36 强制 edge-to-edge，布局不会自动避让键盘 —— 这里用
 * WindowInsets 手动消费：顶部让状态栏、底部让"输入法 inset 与导航栏 inset 的较大者"。
 * WebView 视图高度被系统精确压到键盘上沿，前端输入框（文档流钉底）即零间隙贴住键盘。
 *
 * 返回键：前端导航是状态栈不是 URL 历史，故"返回 = 退回后台"（不退出，服务与页面状态保留）。
 */
public class MainActivity extends Activity {
    private static final String TAG = "MainActivity";
    private static final String BASE = "http://127.0.0.1:8787/";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    /** 启动页最短展示时长：服务通常 ~1s 就绪，这个下限保证动画看得见、不闪一下就没 */
    private static final long SPLASH_MIN_MS = 900L;

    /**
     * 系统栏那两条带子的底色。WebView 被上下两条 inset 各让出一块（见 onCreate 的 padding），
     * 那两条是**外壳**画的，页面里的弹层遮罩（.dialog-mask）盖不到——弹窗打开时页面中间压暗、
     * 上下两条保持原亮度，真机观感就是"浮层只盖住了中间一段"。
     * 所以页面弹层开合时通过 JavaScript 桥通知外壳，把两条带子各自过渡到该有的颜色：
     *   page  = 页面底色（没弹层）
     *   dim   = 页面底色被 --mask(rgba(0,0,0,.5)) 压暗后的合成色（居中弹窗：两条都是背景）
     *   sheet = 上拉面板自己的白底（面板贴底，它下面那条属于面板，不该压暗）
     * 取值 = web/src/tokens.css / colors.xml。时长对齐 --t-view(0.18s)，曲线对齐 CSS 的 ease-out。
     */
    private static final int STRIP_PAGE = 0xFFF7F7F7;
    private static final int STRIP_DIM = 0xFF7B7B7B;
    private static final int STRIP_SHEET = 0xFFFFFFFF;
    private static final long STRIP_FADE_MS = 180L;
    /** CSS ease-out = cubic-bezier(0, 0, .58, 1)：页面遮罩用它，外壳必须用同一条，否则"先暗后暗"。 */
    private static final PathInterpolator STRIP_EASE = new PathInterpolator(0f, 0f, 0.58f, 1f);

    private WebView webView;
    /** 根容器：两条带子的宿主（WebView 只盖住中间的内容区，上下露出这两块）。 */
    private FrameLayout root;
    private Strip topStrip;
    private Strip bottomStrip;
    /** 等待页：纯品牌绿（logo 由系统的启动页负责，尺寸天然正确；自己再画一个会造成尺寸跳变） */
    private FrameLayout splash;
    private TextView splashFail;
    private ValueCallback<Uri[]> fileCallback;
    private final long startedAt = System.currentTimeMillis();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(STRIP_PAGE); // 兜底底色（两条带子各自有自己的 view）
        // 系统栏那两条带子：WebView 被上下让出来之后那块是空的，由这两个 view 上色
        topStrip = new Strip(new View(this), STRIP_PAGE);
        bottomStrip = new Strip(new View(this), STRIP_PAGE);
        root.addView(topStrip.view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.TOP));
        root.addView(bottomStrip.view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, Gravity.BOTTOM));
        // 让位容器：**padding 必须加在 WebView 外的容器上**——WebView 会忽略自身 padding
        // 直接铺满内容（真机反馈"标题栏顶进状态栏"即此），而容器 padding 能正常收缩其内容区。
        FrameLayout webBox = new FrameLayout(this);
        root.addView(webBox, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setVisibility(View.INVISIBLE);
        webView.setBackgroundColor(Color.parseColor("#EDEDED"));
        configureWebView(webView);
        // 页面弹层开合 → 外壳把两条带子过渡到该有的颜色（见 STRIP_PAGE/DIM/SHEET 注释）
        webView.addJavascriptInterface(new ShellBridge(), "qxbncShell");
        webBox.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 启动等待页最上层（纯品牌绿，覆盖含系统栏在内的整屏）
        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 键盘/系统栏让位：顶部让状态栏、底部取 ime 与导航栏的较大者（键盘打开时 WebView 内容区
        // 被精确压到键盘上沿，前端文档流钉底的输入框零间隙贴住键盘）
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets sys = insets.getInsets(WindowInsets.Type.systemBars());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            int bottom = Math.max(ime.bottom, sys.bottom);
            webBox.setPadding(0, sys.top, 0, bottom);
            topStrip.setHeight(sys.top, Gravity.TOP);
            bottomStrip.setHeight(bottom, Gravity.BOTTOM);
            return WindowInsets.CONSUMED;
        });

        setContentView(root);
        setDarkSystemBarIcons(false); // 启动阶段是品牌绿底：状态栏图标用白色

        waitForServerThenLoad();
    }

    /** 等待页：纯品牌绿（logo 由 Android 12+ 的系统启动页绘制，尺寸天然正确，
     *  自己再画一个只会与系统那个对不齐——真机反馈"logo 先大后小"即此）。 */
    private FrameLayout buildSplash() {
        FrameLayout box = new FrameLayout(this);
        box.setBackgroundColor(Color.parseColor("#07C160"));

        splashFail = new TextView(this);
        splashFail.setText(R.string.splash_fail);
        splashFail.setTextSize(14f);
        splashFail.setTextColor(Color.WHITE);
        splashFail.setGravity(Gravity.CENTER);
        splashFail.setPadding(48, 0, 48, 0);
        splashFail.setVisibility(View.GONE);
        box.addView(splashFail, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        return box;
    }

    /** 系统栏图标配色：darkIcons=true → 深色图标（浅色界面）；false → 白色图标（品牌绿启动页）。 */
    private void setDarkSystemBarIcons(boolean darkIcons) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        android.view.WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
        c.setSystemBarsAppearance(darkIcons ? mask : 0, mask);
    }

    /**
     * 页面弹层（Modal / Sheet / Confirm）开合的显示信号：页面的遮罩只能盖住 WebView 内容区，
     * 系统栏那两条带子在 WebView 之外（见 STRIP_* 注释），由外壳跟着过渡。
     * 只暴露这一个开关，没有数据出入口；前端在 ui.tsx 的 useShellStrip 里调用。
     */
    public final class ShellBridge {
        @JavascriptInterface
        public void setStrips(final String top, final String bottom) {
            // JS 桥方法跑在 JavaBridge 线程：切回 UI 线程再动 View
            runOnUiThread(() -> {
                topStrip.to(stripColor(top));
                bottomStrip.to(stripColor(bottom));
            });
        }
    }

    /** 桥上的模式名 → 颜色（未知/缺省一律按页面底色）。 */
    private static int stripColor(final String mode) {
        if ("dim".equals(mode)) return STRIP_DIM;
        if ("sheet".equals(mode)) return STRIP_SHEET;
        return STRIP_PAGE;
    }

    /** 一条系统栏带子：自己上色、自己过渡；只改颜色，不碰布局。 */
    private static final class Strip {
        private final View view;
        private int color;
        private ValueAnimator anim;

        Strip(final View view, final int color) {
            this.view = view;
            this.color = color;
            view.setBackgroundColor(color);
        }

        /** 高度由 inset 决定（0 = 该侧没有系统栏，自然不显示）。 */
        void setHeight(final int height, final int gravity) {
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) view.getLayoutParams();
            if (lp.height == height && lp.gravity == gravity) return;
            lp.height = height;
            lp.gravity = gravity;
            view.setLayoutParams(lp);
        }

        void to(final int target) {
            if (anim != null) anim.cancel();
            if (color == target) return;
            ValueAnimator a = ValueAnimator.ofArgb(color, target);
            a.setDuration(STRIP_FADE_MS);
            a.setInterpolator(STRIP_EASE);
            a.addUpdateListener(x -> {
                color = (int) x.getAnimatedValue();
                view.setBackgroundColor(color);
            });
            anim = a;
            a.start();
        }
    }

    private void configureWebView(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // 头像选择需要读取 content:// 返回的图片
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUseWideViewPort(false);
        wv.setWebViewClient(new WebViewClient());
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "选择图片"), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    Log.e(TAG, "无法打开文件选择器", e);
                    fileCallback = null;
                    return false;
                }
            }
        });
        WebView.setWebContentsDebuggingEnabled(true);
    }

    /** 拉起本地服务并轮询到就绪，再淡出等待页（服务冷启动要解包 payload + 拉起 node，约 1 秒）。 */
    private void waitForServerThenLoad() {
        new Thread(() -> {
            // node 作为本进程的子进程运行（无前台服务 → 无常驻通知）
            if (!NodeRunner.running()) NodeRunner.start(this);
            long deadline = System.currentTimeMillis() + 120_000L;
            boolean ok = false;
            while (System.currentTimeMillis() < deadline) {
                if (probe()) { ok = true; break; }
                try { Thread.sleep(300L); } catch (InterruptedException e) { return; }
            }
            final boolean ready = ok;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (ready) {
                    // 最短展示时长：让启动画面（系统启动页/自绘启动页）完整露个脸
                    long wait = Math.max(0L, SPLASH_MIN_MS - (System.currentTimeMillis() - startedAt));
                    webView.loadUrl(BASE);
                    webView.postDelayed(this::revealWebView, wait);
                } else {
                    // 服务起不来：把错误显示在等待页上
                    splash.setVisibility(View.VISIBLE);
                    splash.setAlpha(1f);
                    splashFail.setVisibility(View.VISIBLE);
                }
            });
        }, "server-probe").start();
    }

    /** 等待页淡出、界面淡入（220ms）。系统启动页已在其首次绘制时自然退出，
     *  本页与它同色同形，因此交接不可见。 */
    private void revealWebView() {
        if (isFinishing() || isDestroyed()) return;
        setDarkSystemBarIcons(true); // 回到浅色界面：系统栏图标改回深色
        webView.setVisibility(View.VISIBLE);
        webView.setAlpha(0f);
        webView.animate().alpha(1f).setDuration(220L).start();
        splash.animate().alpha(0f).setDuration(220L).withEndAction(() -> {
            if (splash != null) splash.setVisibility(View.GONE);
        }).start();
    }

    private boolean probe() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(BASE + "api/groups").openConnection();
            conn.setConnectTimeout(800);
            conn.setReadTimeout(1500);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code == 200) {
                try (InputStream in = conn.getInputStream()) {
                    return in.read() >= 0; // 读到内容即视为就绪
                }
            }
        } catch (Exception ignored) {
            // 服务还没起来：继续等
        } finally {
            if (conn != null) conn.disconnect();
        }
        return false;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        moveTaskToBack(true); // 退回后台而不是退出：服务与页面状态都保留
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        // 界面销毁即结束本地服务：没有前台服务，也就没有常驻通知（下次进入重新拉起，约 1 秒）
        if (isFinishing()) NodeRunner.stop();
        super.onDestroy();
    }
}
