package com.kibangoutv.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout rootLayout;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#0E1318"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0E1318"));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.requestFocus();

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        String ua = ws.getUserAgentString();
        if (ua != null) {
            ws.setUserAgentString(ua.replace("; wv", "").replace("Version/4.0 ", "") + " GoogleTV/1.0");
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && (url.contains("kibangoutv.vercel.app") || url.contains("accounts.google.com"))) {
                    return false;
                }
                if (url != null && url.startsWith("http")) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    return true;
                }
                return false;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                rootLayout.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ));
                webView.setVisibility(View.GONE);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                rootLayout.removeView(customView);
                customView = null;
                webView.setVisibility(View.VISIBLE);
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        });

        rootLayout.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(rootLayout);
        webView.loadUrl("https://kibangoutv.vercel.app/?tv=1");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (customView != null) {
                webView.getWebChromeClient().onHideCustomView();
                return true;
            }
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                return true;
            }
        }
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY || keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            webView.evaluateJavascript("(() => { const v = document.querySelector('video.player-video'); if (v) { if (v.paused) v.play(); else v.pause(); } })();", null);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_CHANNEL_UP) {
            webView.evaluateJavascript("document.querySelector('.player-zap-next, button[aria-label*=\"Suivant\"]')?.click();", null);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_CHANNEL_DOWN) {
            webView.evaluateJavascript("document.querySelector('.player-zap-prev, button[aria-label*=\"Précédent\"]')?.click();", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
