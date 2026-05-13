package com.divault.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.util.ArrayList;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "divault_mobile";
    private static final String PREF_SERVER_URL = "server_url";
    private static final int FILE_CHOOSER_REQUEST = 1001;

    private SharedPreferences preferences;
    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.WHITE);

        Button clearButton = new Button(this);
        clearButton.setText(R.string.clear_server_url);
        clearButton.setAllCaps(false);
        clearButton.setOnClickListener(view -> clearServerUrl());
        layout.addView(clearButton, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        webView = new WebView(this);
        layout.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));

        setContentView(layout);
        configureWebView();

        String savedUrl = preferences.getString(PREF_SERVER_URL, null);
        if (isValidServerUrl(savedUrl)) {
            webView.loadUrl(savedUrl);
        } else {
            promptForServerUrl();
        }
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        webView.setWebViewClient(new WebViewClient());
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

    private void promptForServerUrl() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(R.string.server_url_hint);
        input.setText(preferences.getString(PREF_SERVER_URL, ""));
        input.setSelectAllOnFocus(false);
        int padding = (int) (16 * getResources().getDisplayMetrics().density);
        input.setPadding(padding, padding / 2, padding, padding / 2);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.server_url_title)
                .setMessage(R.string.server_url_message)
                .setView(input)
                .setPositiveButton(R.string.save, null)
                .setNegativeButton(R.string.cancel, null)
                .create();

        dialog.setOnShowListener(activeDialog -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String url = input.getText().toString().trim();
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

    private boolean isValidServerUrl(String url) {
        if (url == null) {
            return false;
        }

        Uri uri = Uri.parse(url.trim());
        String scheme = uri.getScheme();
        return uri.getHost() != null && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
    }

    private void clearServerUrl() {
        preferences.edit().remove(PREF_SERVER_URL).apply();
        webView.loadUrl("about:blank");
        promptForServerUrl();
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
                    if (uri != null) {
                        uris.add(uri);
                    }
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
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (fileUploadCallback != null) {
            fileUploadCallback.onReceiveValue(null);
            fileUploadCallback = null;
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
