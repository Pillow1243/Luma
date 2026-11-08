package app.luma.messenger;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

/**
 * Luma — native Android shell.
 *
 * Dependency-free (framework classes only) so the APK can be assembled with the
 * Android SDK build tools alone, no Gradle/AndroidX/Google Maven.
 *
 * Loading strategy ("remote, with a real offline fallback"):
 *   1. Always try the live Vercel deployment, so every user is instantly on the
 *      newest UI without an app-store update.
 *   2. The same web bundle is also packaged inside the APK under
 *      assets/public. If the live host is unreachable (offline, blocked
 *      network, DNS failure), the shell transparently loads the bundled copy
 *      instead of showing an error page.
 *
 * Also handled natively: branded splash background, edge-to-edge dark system
 * bars, notch/gesture-bar safe insets, a violet loading bar, media-capture
 * permission bridging, external links, and hardware back navigation.
 */
public class MainActivity extends Activity {

    /** Live deployment the APK prefers. */
    private static final String APP_URL = "https://luma-messenger.vercel.app";
    /** Offline fallback shipped inside the APK. */
    private static final String BUNDLED_URL = "file:///android_asset/public/index.html";

    private static final int INK = Color.parseColor("#0B0716");
    private static final int VIOLET = Color.parseColor("#8B5CF6");

    private WebView webView;
    private ProgressBar progress;
    private boolean showingFallback = false;
    private int mainFrameFailures = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        paintWindow();
        buildUi();
        configureWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            loadApp();
        }
    }

    /* ------------------------------------------------------------------ UI */

    private void paintWindow() {
        Window window = getWindow();
        window.setBackgroundDrawableResource(android.R.color.black);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(INK);
        window.setNavigationBarColor(INK);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            View decor = window.getDecorView();
            int flags = decor.getSystemUiVisibility();
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            decor.setSystemUiVisibility(flags);
        }
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(INK);
        root.setFitsSystemWindows(false);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(VIOLET));
        progress.setBackgroundColor(Color.TRANSPARENT);
        progress.setVisibility(View.GONE);

        webView = new WebView(this);
        webView.setBackgroundColor(INK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setFitsSystemWindows(true);

        root.addView(progress, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(2)));
        root.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
        applySafeAreaInsets(root);
    }

    /** Keep content clear of notches and gesture bars (true edge-to-edge). */
    private void applySafeAreaInsets(final View root) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public android.view.WindowInsets onApplyWindowInsets(View v, android.view.WindowInsets insets) {
                    try {
                        android.graphics.Insets bars = insets.getInsets(
                                android.view.WindowInsets.Type.systemBars()
                                        | android.view.WindowInsets.Type.displayCutout());
                        v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                    } catch (Throwable ignored) {
                        /* leave default padding */
                    }
                    return insets;
                }
            });
            root.requestApplyInsets();
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
            final int top = getStatusBarHeight();
            root.setPadding(0, top, 0, 0);
        }
    }

    private int getStatusBarHeight() {
        int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return id > 0 ? getResources().getDimensionPixelSize(id) : dp(24);
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /* -------------------------------------------------------------- webview */

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowContentAccess(true);
        s.setAllowFileAccess(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " LumaAndroid/1.0");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Luma only ever asks for media capture (attachments, voice notes).
                String[] requested = request.getResources();
                boolean mediaOnly = requested.length > 0;
                for (String r : requested) {
                    if (!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)
                            && !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                        mediaOnly = false;
                    }
                }
                if (mediaOnly) request.grant(requested);
                else request.deny();
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                String host = uri.getHost() == null ? "" : uri.getHost();

                if ("file".equals(scheme) || "about".equals(scheme)) return false;
                boolean internal = host.equals("luma-messenger.vercel.app")
                        || host.endsWith(".vercel.app")
                        || host.endsWith("supabase.co")
                        || host.equals("localhost")
                        || host.equals("127.0.0.1");
                if (internal) return false;

                // Everything else (mailto:, tel:, web links) goes to the system.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Throwable ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                if (url != null && url.startsWith("file:")) showingFallback = true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && request.isForMainFrame()) {
                    mainFrameFailures++;
                    // First failure: fall back to the bundled build immediately so
                    // the user is never stuck on an error page.
                    if (!showingFallback) loadBundled();
                }
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M && !showingFallback) {
                    loadBundled();
                }
            }
        });
    }

    private void loadApp() {
        showingFallback = false;
        webView.loadUrl(APP_URL);
        // If nothing has painted after 9s the network is likely blocked: use the
        // bundled bundle so the app still opens.
        webView.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!showingFallback && progress.getProgress() < 100 && mainFrameFailures == 0) {
                    loadBundled();
                }
            }
        }, 9000);
    }

    private void loadBundled() {
        showingFallback = true;
        progress.setVisibility(View.GONE);
        webView.loadUrl(BUNDLED_URL);
    }

    /* -------------------------------------------------------------- back/etc */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                return true;
            }
            if (showingFallback && webView != null) {
                // Back out of the offline copy into the live app.
                loadApp();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
