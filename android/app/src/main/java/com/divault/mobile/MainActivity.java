package com.divault.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "divault_mobile";
    private static final String PREF_SERVER_URL = "server_url";
    private static final String PREF_LAST_MODE = "last_mode";
    private static final String PREF_PIN_SALT = "pin_salt";
    private static final String PREF_PIN_HASH = "pin_hash";
    private static final String MODE_LOCAL = "local";
    private static final String MODE_SERVER = "server";
    private static final int FILE_CHOOSER_REQUEST = 1001;

    private SharedPreferences preferences;
    private WebView webView;
    private ValueCallback<Uri[]> fileUploadCallback;
    private String pendingShareTitle;
    private String pendingShareBody;
    private boolean shareAttempted;
    private String currentMode = MODE_LOCAL;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle(R.string.app_name);
        preferences = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        handleShareIntent(getIntent());
        buildLayout();
        configureWebView();

        if (hasPin()) {
            promptUnlock();
        } else {
            loadConfiguredServer();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
        if (webView != null) {
            injectPendingShare();
        }
    }

    private void buildLayout() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.WHITE);

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(6), dp(4), dp(6), dp(4));
        toolbar.setBackgroundColor(Color.rgb(31, 41, 55));

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        title.setSingleLine(true);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.8f));
        toolbar.addView(toolbarButton(R.string.refresh, view -> reloadServer()));
        toolbar.addView(toolbarButton(R.string.local, view -> loadLocalVault()));
        toolbar.addView(toolbarButton(R.string.server, view -> promptForServerUrl()));
        toolbar.addView(toolbarButton(R.string.lock, view -> showAppLockOptions()));
        layout.addView(toolbar, new LinearLayout.LayoutParams(
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
    }

    private Button toolbarButton(int label, android.view.View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setOnClickListener(listener);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(6), dp(6), dp(6), dp(6));
        button.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.8f));
        return button;
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
        String savedUrl = preferences.getString(PREF_SERVER_URL, null);
        String lastMode = preferences.getString(PREF_LAST_MODE, MODE_LOCAL);
        if (MODE_SERVER.equals(lastMode) && isValidServerUrl(savedUrl)) {
            currentMode = MODE_SERVER;
            webView.loadUrl(savedUrl);
        } else {
            loadLocalVault();
        }
    }

    private void reloadServer() {
        if (MODE_LOCAL.equals(currentMode)) {
            loadLocalVault();
            return;
        }
        String savedUrl = preferences.getString(PREF_SERVER_URL, null);
        if (isValidServerUrl(savedUrl)) {
            currentMode = MODE_SERVER;
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
            preferences.edit()
                    .putString(PREF_SERVER_URL, url)
                    .putString(PREF_LAST_MODE, MODE_SERVER)
                    .apply();
            currentMode = MODE_SERVER;
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
        if (url == null) {
            return false;
        }

        Uri uri = Uri.parse(url.trim());
        String scheme = uri.getScheme();
        return uri.getHost() != null && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
    }

    private void showAppLockOptions() {
        if (!hasPin()) {
            promptSetPin();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.app_lock_title)
                .setItems(new CharSequence[]{getString(R.string.lock_now), getString(R.string.change_pin), getString(R.string.remove_pin)}, (dialog, which) -> {
                    if (which == 0) promptUnlock();
                    if (which == 1) promptVerifyPin(() -> promptSetPin());
                    if (which == 2) promptVerifyPin(() -> {
                        preferences.edit().remove(PREF_PIN_SALT).remove(PREF_PIN_HASH).apply();
                        Toast.makeText(this, R.string.pin_removed, Toast.LENGTH_SHORT).show();
                    });
                })
                .show();
    }

    private void promptSetPin() {
        promptForPin(getString(R.string.new_pin), pin -> {
            if (!pin.matches("\\d{4,}")) {
                Toast.makeText(this, R.string.invalid_pin, Toast.LENGTH_SHORT).show();
                return;
            }
            String salt = randomHex(16);
            preferences.edit()
                    .putString(PREF_PIN_SALT, salt)
                    .putString(PREF_PIN_HASH, hashPin(salt, pin))
                    .apply();
            Toast.makeText(this, R.string.pin_enabled, Toast.LENGTH_SHORT).show();
        });
    }

    private void promptUnlock() {
        webView.loadUrl("about:blank");
        promptVerifyPin(this::loadConfiguredServer);
    }

    private void promptVerifyPin(Runnable onSuccess) {
        promptForPin(getString(R.string.enter_pin), pin -> {
            if (!verifyPin(pin)) {
                Toast.makeText(this, R.string.wrong_pin, Toast.LENGTH_SHORT).show();
                promptVerifyPin(onSuccess);
                return;
            }
            onSuccess.run();
        });
    }

    private void promptForPin(String title, PinCallback callback) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        input.setPadding(dp(16), dp(8), dp(16), dp(8));
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(title)
                .setView(input)
                .setPositiveButton(R.string.save, null)
                .setNegativeButton(R.string.cancel, null)
                .create();
        dialog.setOnShowListener(activeDialog -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            callback.onPin(input.getText().toString());
            dialog.dismiss();
        }));
        dialog.show();
    }

    private boolean hasPin() {
        return preferences.contains(PREF_PIN_SALT) && preferences.contains(PREF_PIN_HASH);
    }

    private boolean verifyPin(String pin) {
        String salt = preferences.getString(PREF_PIN_SALT, "");
        String expected = preferences.getString(PREF_PIN_HASH, "");
        return expected.equals(hashPin(salt, pin));
    }

    private String hashPin(String salt, String pin) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest((salt + ":" + pin).getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder();
            for (byte value : hash) builder.append(String.format("%02x", value));
            return builder.toString();
        } catch (Exception exception) {
            return "";
        }
    }

    private String randomHex(int bytes) {
        byte[] values = new byte[bytes];
        new SecureRandom().nextBytes(values);
        StringBuilder builder = new StringBuilder();
        for (byte value : values) builder.append(String.format("%02x", value));
        return builder.toString();
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
        if (MODE_LOCAL.equals(currentMode)) {
            String js = "if(window.DiVaultLocal){window.DiVaultLocal.addSharedNote("
                    + jsString(pendingShareTitle) + "," + jsString(pendingShareBody) + ");'ok'}else{'fail'}";
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
            return;
        }
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
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{font-family:sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#f9fafb}.card{padding:28px;max-width:420px}button{padding:12px 16px;margin:6px;border:0;border-radius:10px;background:#4f46e5;color:white;font-weight:700}</style>"
                + "</head><body><div class='card'><h1>" + getString(R.string.server_unavailable) + "</h1><p>DiVault could not reach the saved server.</p><button onclick='DiVaultAndroid.localVault()'>" + getString(R.string.open_local_vault) + "</button><button onclick='DiVaultAndroid.retry()'>" + getString(R.string.retry) + "</button><button onclick='DiVaultAndroid.changeServer()'>" + getString(R.string.change_server) + "</button></div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private void loadLocalVault() {
        currentMode = MODE_LOCAL;
        preferences.edit().putString(PREF_LAST_MODE, MODE_LOCAL).apply();
        webView.loadDataWithBaseURL("https://local.divault/", localVaultHtml(), "text/html", "UTF-8", null);
    }

    private String localVaultHtml() {
        return """
                <!doctype html>
                <html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>DiVault Local</title>
                <style>
                :root{color-scheme:dark;--bg:#09090b;--panel:#111114;--line:#27272a;--text:#f8fafc;--muted:#a1a1aa;--brand:#f59e0b;--danger:#ef4444}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#18181b,#050505);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,sans-serif;min-height:100vh}.wrap{padding:18px;max-width:820px;margin:0 auto}.hero{display:flex;align-items:center;gap:12px;margin-bottom:16px}.logo{width:46px;height:46px;border-radius:14px;background:#020202;display:grid;place-items:center;font-weight:900}.title{font-size:24px;font-weight:850}.muted{color:var(--muted);font-size:13px}.card{background:rgba(17,17,20,.92);border:1px solid var(--line);border-radius:18px;padding:14px;box-shadow:0 18px 60px rgba(0,0,0,.28)}.bar{display:flex;gap:8px;margin:12px 0;position:sticky;top:0;background:linear-gradient(#111114,#111114cc);padding:10px 0;z-index:2}button,input,textarea{font:inherit}button{border:0;border-radius:12px;background:#27272a;color:var(--text);font-weight:750;padding:11px 13px}button.primary{background:var(--brand);color:#18130a}button.danger{background:var(--danger)}input,textarea{width:100%;border:1px solid var(--line);border-radius:14px;background:#0b0b0d;color:var(--text);padding:12px;margin:6px 0}textarea{min-height:180px;resize:vertical}.note{padding:13px;border:1px solid var(--line);border-radius:15px;margin:9px 0;background:#0c0c0f}.note h3{margin:0 0 6px;font-size:17px}.note p{margin:0;color:#d4d4d8;white-space:pre-wrap}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.hidden{display:none}.empty{padding:28px;text-align:center;color:var(--muted)}
                </style></head><body><main class="wrap"><section class="hero"><div class="logo">DV</div><div><div class="title">DiVault Local</div><div class="muted">Standalone notes stored on this device.</div></div></section><section class="card"><div class="bar"><button class="primary" onclick="newNote()">New note</button><button onclick="exportNotes()">Export</button><button onclick="importNotes()">Import</button><input id="file" class="hidden" type="file" accept="application/json" onchange="readImport(event)"></div><input id="search" placeholder="Search local notes" oninput="render()"><div id="editor" class="hidden"><input id="title" placeholder="Title"><textarea id="body" placeholder="Write a secure local note..."></textarea><div class="row"><button class="primary" onclick="saveNote()">Save</button><button onclick="closeEditor()">Cancel</button><button id="deleteBtn" class="danger hidden" onclick="deleteNote()">Delete</button></div></div><div id="list"></div></section></main><script>
                const KEY='divault.local.notes.v1';let notes=JSON.parse(localStorage.getItem(KEY)||'[]');let active=null;const $=id=>document.getElementById(id);function persist(){localStorage.setItem(KEY,JSON.stringify(notes));}function esc(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}function render(){const q=$('search').value.toLowerCase();const filtered=notes.filter(n=>(n.title+' '+n.body).toLowerCase().includes(q)).sort((a,b)=>b.updated-a.updated);$('list').innerHTML=filtered.length?filtered.map(n=>`<article class="note" onclick="editNote('${n.id}')"><h3>${esc(n.title||'Untitled')}</h3><p>${esc((n.body||'').slice(0,220))}</p><div class="muted">${new Date(n.updated).toLocaleString()}</div></article>`).join(''):'<div class="empty">No local notes yet.</div>';}function newNote(){active=null;$('title').value='';$('body').value='';$('deleteBtn').classList.add('hidden');$('editor').classList.remove('hidden');$('title').focus();}function editNote(id){const n=notes.find(x=>x.id===id);if(!n)return;active=id;$('title').value=n.title||'';$('body').value=n.body||'';$('deleteBtn').classList.remove('hidden');$('editor').classList.remove('hidden');}function saveNote(){const now=Date.now();const data={id:active||String(now)+Math.random().toString(16).slice(2),title:$('title').value.trim()||'Untitled',body:$('body').value,updated:now};notes=active?notes.map(n=>n.id===active?data:n):[data,...notes];persist();closeEditor();render();}function deleteNote(){if(!active||!confirm('Delete this local note?'))return;notes=notes.filter(n=>n.id!==active);persist();closeEditor();render();}function closeEditor(){$('editor').classList.add('hidden');active=null;}function exportNotes(){const blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),notes},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='divault-local-notes.json';a.click();URL.revokeObjectURL(a.href);}function importNotes(){$('file').click();}function readImport(e){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{const data=JSON.parse(r.result);const incoming=Array.isArray(data)?data:data.notes;if(!Array.isArray(incoming))throw new Error();const byId=new Map(notes.map(n=>[n.id,n]));incoming.forEach(n=>{if(n&&n.id)byId.set(n.id,{id:String(n.id),title:String(n.title||'Untitled'),body:String(n.body||''),updated:Number(n.updated)||Date.now()});});notes=[...byId.values()];persist();render();alert('Import complete.');}catch(_){alert('Import failed. Choose a DiVault local JSON export.');}};r.readAsText(f);}window.DiVaultLocal={addSharedNote(title,body){notes=[{id:String(Date.now())+Math.random().toString(16).slice(2),title:title||'Shared to DiVault',body:body||'',updated:Date.now()},...notes];persist();render();}};render();
                </script></body></html>
                """;
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

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }

    private interface PinCallback {
        void onPin(String pin);
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
        public void localVault() {
            runOnUiThread(() -> loadLocalVault());
        }
    }
}
