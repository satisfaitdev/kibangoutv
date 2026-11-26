package com.kibangoutv.tv;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0E1318"));

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
        String ua = ws.getUserAgentString();
        if (ua != null) {
            ws.setUserAgentString(ua.replace("; wv", "").replace("Version/4.0 ", ""));
        }

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());

        root.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);
        webView.loadUrl("https://kibangoutv.vercel.app");
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }
}
