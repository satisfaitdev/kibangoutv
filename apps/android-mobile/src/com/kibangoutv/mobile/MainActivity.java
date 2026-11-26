package com.kibangoutv.mobile;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;

public class MainActivity extends Activity {
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout rootLayout;

    private void enqueueDeviceDownload(String url, String filename, String mimeType) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle(filename);
            req.setDescription("Téléchargement KibangouTV");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
            if (mimeType != null && !mimeType.isEmpty()) req.setMimeType(mimeType);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) dm.enqueue(req);
            Toast.makeText(this, "Téléchargement dans Téléchargements : " + filename, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Erreur téléchargement : " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    public class AndroidBridge {
        @JavascriptInterface
        public void downloadUrl(String url, String filename) {
            runOnUiThread(() -> enqueueDeviceDownload(url, filename, "video/mp4"));
        }

        @JavascriptInterface
        public void saveBase64(String filename, String b64) {
            try {
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, filename);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(data);
                }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Enregistré : " + out.getName(), Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Erreur sauvegarde : " + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(Color.parseColor("#0E1318"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0E1318"));
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(true);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // Evite le blocage Google OAuth 403 disallowed_useragent dans WebView
        String ua = ws.getUserAgentString();
        if (ua != null) {
            ws.setUserAgentString(ua.replace("; wv", "").replace("Version/4.0 ", ""));
        }

        webView.addJavascriptInterface(new AndroidBridge(), "KibangouAndroid");
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                String fname = URLUtil.guessFileName(url, contentDisposition, mimetype);
                enqueueDeviceDownload(url, fname, mimetype);
            }
        });

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
        webView.loadUrl("https://kibangoutv.vercel.app");
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            webView.getWebChromeClient().onHideCustomView();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }
}
