package com.divault.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "divault_mobile";
    private static final String PREF_SERVER_URL = "server_url";
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1002;
    private static final String REMINDER_CHANNEL_ID = "divault_reminders";

    private SharedPreferences preferences;
    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
    private String pendingShareTitle;
    private String pendingShareBody;
    private boolean shareAttempted;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        }
        getWindow().setStatusBarColor(Color.rgb(250, 247, 240));
        getWindow().setNavigationBarColor(Color.rgb(250, 247, 240));
        setTitle(R.string.app_name);
        preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        handleShareIntent(getIntent());
        ensureNotificationChannel();
        requestNotificationPermissionIfNeeded();
        buildWebView();
        configureWebView();
        loadConfiguredServer();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
        loadIntentUrl(intent);
        injectPendingShare();
    }

    private void buildWebView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(250, 247, 240));
        webView = new WebView(this);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                left = bars.left;
                top = bars.top;
                right = bars.right;
                bottom = bars.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            view.setPadding(left, top, right, bottom);
            injectSystemInsets(left, top, right, bottom);
            return insets;
        });

        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        root.addView(webView);
        setContentView(root);
        root.requestApplyInsets();
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        webView.addJavascriptInterface(new Bridge(), "DiVaultAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectPendingShare();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    showOfflinePage();
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = filePathCallback;

                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(resolveChooserType(fileChooserParams));
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);

                try {
                    startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_file)), FILE_CHOOSER_REQUEST);
                } catch (Exception exception) {
                    fileUploadCallback.onReceiveValue(null);
                    fileUploadCallback = null;
                    Toast.makeText(MainActivity.this, R.string.file_chooser_unavailable, Toast.LENGTH_SHORT).show();
                    return false;
                }

                return true;
            }
        });
    }

    private String resolveChooserType(WebChromeClient.FileChooserParams fileChooserParams) {
        if (fileChooserParams != null && fileChooserParams.getAcceptTypes() != null) {
            for (String type : fileChooserParams.getAcceptTypes()) {
                if (type != null && type.trim().length() > 0) {
                    return type.trim();
                }
            }
        }
        return "*/*";
    }

    private void loadConfiguredServer() {
        if (loadIntentUrl(getIntent())) return;
        String savedUrl = preferences.getString(PREF_SERVER_URL, null);
        if (isValidServerUrl(savedUrl)) {
            webView.loadUrl(savedUrl);
        } else {
            promptForServerUrl();
        }
    }

    private boolean loadIntentUrl(Intent intent) {
        if (intent == null || intent.getData() == null || webView == null) return false;
        String url = intent.getData().toString();
        if (!isValidServerUrl(url)) return false;
        webView.loadUrl(url);
        return true;
    }

    private void reloadServer() {
        String savedUrl = preferences.getString(PREF_SERVER_URL, null);
        if (isValidServerUrl(savedUrl)) {
            webView.loadUrl(savedUrl);
        } else {
            promptForServerUrl();
        }
    }

    private void promptForServerUrl() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(R.string.server_url_hint);
        input.setText(preferences.getString(PREF_SERVER_URL, ""));
        input.setSelectAllOnFocus(false);
        input.setPadding(dp(16), dp(8), dp(16), dp(8));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.server_url_title)
                .setMessage(R.string.server_url_message)
                .setView(input)
                .setPositiveButton(R.string.save, null)
                .setNegativeButton(R.string.cancel, null)
                .create();

        dialog.setOnShowListener(activeDialog -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String url = normalizeServerUrl(input.getText().toString());
            if (!isValidServerUrl(url)) {
                input.setError(getString(R.string.invalid_server_url));
                return;
            }
            preferences.edit().putString(PREF_SERVER_URL, url).apply();
            webView.loadUrl(url);
            dialog.dismiss();
        }));

        dialog.show();
    }

    private String normalizeServerUrl(String url) {
        String trimmed = url == null ? "" : url.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private boolean isValidServerUrl(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url.trim());
        String scheme = uri.getScheme();
        return uri.getHost() != null && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
    }

    private void handleShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        if (text == null || text.toString().trim().isEmpty()) return;
        pendingShareTitle = subject != null && subject.toString().trim().length() > 0 ? subject.toString().trim() : "Shared to DiVault";
        pendingShareBody = text.toString().trim();
        shareAttempted = false;
    }

    private void injectPendingShare() {
        if (pendingShareBody == null || shareAttempted || webView == null) return;
        shareAttempted = true;
        String js = "(async function(){try{"
                + "const c=Object.fromEntries(document.cookie.split('; ').filter(Boolean).map(x=>x.split('=')));"
                + "const csrf=decodeURIComponent(c.divault_csrf||c.qv_csrf||'');"
                + "const r=await fetch('/api/notes',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({title:"
                + jsString(pendingShareTitle) + ",body:" + jsString(pendingShareBody)
                + ",type:'text',section:'All'})});return r.ok?'ok':'fail';}catch(e){return 'fail';}})();";
        webView.evaluateJavascript(js, result -> {
            if (result != null && result.contains("ok")) {
                Toast.makeText(this, R.string.shared_note_saved, Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(this, R.string.shared_note_failed, Toast.LENGTH_LONG).show();
            }
            pendingShareTitle = null;
            pendingShareBody = null;
            shareAttempted = false;
        });
    }

    private String jsString(String value) {
        String escaped = value == null ? "" : value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
        return "\"" + escaped + "\"";
    }

    private void showOfflinePage() {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>"
                + "<style>body{font-family:Inter,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7fb;color:#111827}.card{padding:28px;max-width:420px}button{padding:12px 16px;margin:6px;border:0;border-radius:8px;background:#635bff;color:white;font-weight:800}h1{letter-spacing:-.04em}.muted{color:#64748b}</style>"
                + "</head><body><div class='card'><h1>" + getString(R.string.server_unavailable) + "</h1><p class='muted'>DiVault could not reach the saved server.</p><button onclick='DiVaultAndroid.retry()'>" + getString(R.string.retry) + "</button><button onclick='DiVaultAndroid.changeServer()'>" + getString(R.string.change_server) + "</button></div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode != FILE_CHOOSER_REQUEST || fileUploadCallback == null) {
            return;
        }

        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                ArrayList<Uri> uris = new ArrayList<>();
                for (int index = 0; index < data.getClipData().getItemCount(); index++) {
                    Uri uri = data.getClipData().getItemAt(index).getUri();
                    if (uri != null) uris.add(uri);
                }
                results = uris.toArray(new Uri[0]);
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }

        fileUploadCallback.onReceiveValue(results);
        fileUploadCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        if (fileUploadCallback != null) {
            fileUploadCallback.onReceiveValue(null);
            fileUploadCallback = null;
        }
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    private void injectSystemInsets(int left, int top, int right, int bottom) {
        if (webView == null) return;
        String js = "document.documentElement.style.setProperty('--android-system-left','" + left + "px');"
                + "document.documentElement.style.setProperty('--android-system-top','" + top + "px');"
                + "document.documentElement.style.setProperty('--android-system-right','" + right + "px');"
                + "document.documentElement.style.setProperty('--android-system-bottom','" + bottom + "px');";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                REMINDER_CHANNEL_ID,
                "DiVault reminders",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Calendar and task reminders from DiVault");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < 33 || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean showDeviceNotification(String title, String body, String url) {
        if (!canPostNotifications()) {
            Toast.makeText(this, title + ": " + body, Toast.LENGTH_LONG).show();
            requestNotificationPermissionIfNeeded();
            return false;
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (isValidServerUrl(url)) intent.setData(Uri.parse(url));
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, Math.abs((title + body).hashCode()), intent, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, REMINDER_CHANNEL_ID)
                : new Notification.Builder(this);
        Notification notification = builder
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .build();

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return false;
        manager.notify(Math.abs((title + body).hashCode()), notification);
        return true;
    }

    private final class Bridge {
        @JavascriptInterface
        public void retry() {
            runOnUiThread(() -> reloadServer());
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> promptForServerUrl());
        }

        @JavascriptInterface
        public boolean notify(String title, String body, String url) {
            final String safeTitle = title == null ? "DiVault" : title;
            final String safeBody = body == null ? "" : body;
            final String safeUrl = url == null ? "" : url;
            if (Looper.myLooper() == Looper.getMainLooper()) {
                return showDeviceNotification(safeTitle, safeBody, safeUrl);
            }
            AtomicBoolean delivered = new AtomicBoolean(false);
            CountDownLatch latch = new CountDownLatch(1);
            runOnUiThread(() -> {
                try {
                    delivered.set(showDeviceNotification(safeTitle, safeBody, safeUrl));
                } finally {
                    latch.countDown();
                }
            });
            try {
                latch.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return delivered.get();
        }
    }
}
