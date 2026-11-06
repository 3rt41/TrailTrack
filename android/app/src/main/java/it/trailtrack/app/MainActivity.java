package it.trailtrack.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Ospita l'interfaccia (la web app in assets/www) in una WebView e le fornisce, tramite
 * il bridge "AndroidBridge", le funzioni native: GPS in background, band Bluetooth, file.
 */
public class MainActivity extends Activity {

    static final String HOST = "app.trailtrack.local";
    static final String BASE = "https://" + HOST + "/";
    private static final int REQ_PERMS = 10;
    private static final int REQ_FILE = 11;

    static MainActivity instance;
    WebView web;
    HeartRateManager hr;

    private Runnable pendingGranted, pendingDenied;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        getWindow().setStatusBarColor(Color.parseColor("#0F1A14"));
        getWindow().setNavigationBarColor(Color.parseColor("#0F1A14"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0F1A14"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " TrailTrackAndroid/" + versionName());

        hr = new HeartRateManager(this);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
                try {
                    InputStream in = getAssets().open("www" + path);
                    return new WebResourceResponse(mime(path), "utf-8", in);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                withPermissions(locationPerms(),
                        () -> callback.invoke(origin, true, false),
                        () -> callback.invoke(origin, false, false));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                // tipo di file richiesto dalla pagina (es. "image/*" per le foto); ".gpx" e simili → qualsiasi file
                String type = "*/*";
                String[] acc = params.getAcceptTypes();
                if (acc != null && acc.length > 0 && acc[0] != null && acc[0].contains("/")) type = acc[0];
                // <input capture>: apre direttamente la fotocamera, la foto finisce anche in Immagini/TrailTrack
                if (params.isCaptureEnabled() && type.startsWith("image/") && Build.VERSION.SDK_INT >= 29) {
                    try {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.Images.Media.DISPLAY_NAME, "TrailTrack_" + System.currentTimeMillis() + ".jpg");
                        v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                        v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/TrailTrack");
                        cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                        Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                        cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivityForResult(cam, REQ_FILE);
                        return true;
                    } catch (Exception e) {
                        if (cameraUri != null) { try { getContentResolver().delete(cameraUri, null, null); } catch (Exception ignored) { } }
                        cameraUri = null; // nessuna app fotocamera: si ripiega sulla galleria
                    }
                }
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(type);
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(i, "Scegli file"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.loadUrl(BASE + "index.html");
    }

    String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "1"; }
    }

    static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        return "application/octet-stream";
    }

    // ───────────── Comunicazione con il JavaScript ─────────────

    /** Esegue una funzione JS (sempre sul thread UI). */
    void js(String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    static void jsCall(String fn, String jsonArg) {
        MainActivity a = instance;
        if (a != null) a.js("window." + fn + " && window." + fn + "(" + jsonArg + ")");
    }

    class Bridge {
        @JavascriptInterface
        public boolean isNative() { return true; }

        @JavascriptInterface
        public void startTracking() {
            runOnUiThread(() -> {
                List<String> perms = new ArrayList<>(locationPerms());
                if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS);
                withPermissions(perms, () -> {
                    if (!hasAll(locationPerms())) { jsCall("__nativeGeoErr", "'denied'"); return; }
                    Intent i = new Intent(MainActivity.this, TrackingService.class);
                    startForegroundService(i);
                }, () -> jsCall("__nativeGeoErr", "'denied'"));
            });
        }

        @JavascriptInterface
        public void stopTracking() {
            runOnUiThread(() -> stopService(new Intent(MainActivity.this, TrackingService.class)));
        }

        @JavascriptInterface
        public void updateNotification(String text) { TrackingService.updateText(text); }

        @JavascriptInterface
        public void hrConnect() { runOnUiThread(() -> hr.connect()); }

        @JavascriptInterface
        public void hrDisconnect() { runOnUiThread(() -> hr.disconnect()); }

        @JavascriptInterface
        public void saveFile(String name, String mime, String content) {
            runOnUiThread(() -> MainActivity.this.saveFile(name, mime, content));
        }

        @JavascriptInterface
        public boolean batteryOptimized() {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            return !pm.isIgnoringBatteryOptimizations(getPackageName());
        }

        @SuppressLint("BatteryLife")
        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                } catch (Exception e) {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            });
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        }

        @JavascriptInterface
        public void toast(String msg) { runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show()); }
    }

    // ───────────── Salvataggio file (GPX, backup) in Download ─────────────

    void saveFile(String name, String mime, String content) {
        byte[] data = content.getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/TrailTrack");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("impossibile creare il file");
                try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(data); }
                Toast.makeText(this, "Salvato in Download/TrailTrack/" + name, Toast.LENGTH_LONG).show();
            } else {
                File dir = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "TrailTrack");
                dir.mkdirs();
                File f = new File(dir, name);
                try (FileOutputStream os = new FileOutputStream(f)) { os.write(data); }
                Toast.makeText(this, "Salvato in " + f.getAbsolutePath(), Toast.LENGTH_LONG).show();
            }
        } catch (Exception e) {
            Toast.makeText(this, "Errore salvataggio: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    // ───────────── Permessi ─────────────

    static List<String> locationPerms() {
        List<String> l = new ArrayList<>();
        l.add(Manifest.permission.ACCESS_FINE_LOCATION);
        l.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        return l;
    }

    boolean hasAll(List<String> perms) {
        for (String p : perms) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        return true;
    }

    /** Chiede i permessi mancanti; poi esegue onGranted (se i permessi essenziali ci sono) o onDenied. */
    void withPermissions(List<String> perms, Runnable onGranted, Runnable onDenied) {
        List<String> missing = new ArrayList<>();
        for (String p : perms) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        if (missing.isEmpty()) { onGranted.run(); return; }
        pendingGranted = onGranted;
        pendingDenied = onDenied;
        requestPermissions(missing.toArray(new String[0]), REQ_PERMS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_PERMS) return;
        boolean essentialOk = true;
        for (int i = 0; i < permissions.length; i++) {
            // le notifiche sono facoltative: senza, la registrazione funziona comunque
            if (Manifest.permission.POST_NOTIFICATIONS.equals(permissions[i])) continue;
            if (Manifest.permission.ACCESS_COARSE_LOCATION.equals(permissions[i])) continue;
            if (results[i] != PackageManager.PERMISSION_GRANTED) essentialOk = false;
        }
        Runnable r = essentialOk ? pendingGranted : pendingDenied;
        pendingGranted = null;
        pendingDenied = null;
        if (r != null) r.run();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            Uri[] res = null;
            if (cameraUri != null) {
                if (resultCode == RESULT_OK) res = new Uri[]{cameraUri};
                else { try { getContentResolver().delete(cameraUri, null, null); } catch (Exception ignored) { } }
                cameraUri = null;
            } else if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    res = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < res.length; i++) res[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    res = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(res);
            fileCallback = null;
        } else if (requestCode == HeartRateManager.REQ_ENABLE_BT && resultCode == RESULT_OK) {
            hr.connect();
        }
    }

    // Indietro: chiude prima il dettaglio/le schede; poi manda l'app in background senza fermare la registrazione.
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.__nativeBack ? window.__nativeBack() : false", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        hr.disconnect();
        hr.release();
        stopService(new Intent(this, TrackingService.class));
        if (instance == this) instance = null;
        web.destroy();
        web = null;
        super.onDestroy();
    }

    static String q(String s) { return JSONObject.quote(s == null ? "" : s); }
}
