package it.trailtrack.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.location.OnNmeaMessageListener;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;

/**
 * Servizio in primo piano: tiene vivo il GPS (e l'app) anche a schermo spento e
 * inoltra ogni posizione all'interfaccia JavaScript.
 *
 * Misura anche il movimento del corpo (contapassi + accelerometro), che dice molto meglio
 * del GPS se sei fermo o stai camminando. Tutto finisce anche in un diario su file: se il
 * sistema chiude l'interfaccia, il servizio continua e l'app, quando si riapre, recupera
 * ciò che è successo nel frattempo.
 */
public class TrackingService extends Service implements LocationListener, SensorEventListener {

    static final String EXTRA_FRESH = "fresh";
    private static final String JOURNAL = "journal.jsonl";
    private static final Object JLOCK = new Object();
    private static final int JOURNAL_MAX_LINES = 60000; // ~16 ore di dati

    private static final String CHANNEL = "tracking";
    private static final int NOTIF_ID = 1;
    private static TrackingService running;

    private LocationManager lm;
    private PowerManager.WakeLock wakeLock;
    private OnNmeaMessageListener nmeaListener;
    private final Handler main = new Handler(Looper.getMainLooper());

    // Altitudine sul livello del mare dalla frase NMEA GGA: Location.getAltitude() è
    // l'altezza sull'ellissoide (in Italia ~45 m più alta della quota reale).
    private volatile double mslAlt = Double.NaN;
    private volatile long mslAt = 0;
    private String lastText = "Registrazione in corso";

    // movimento: passi e "agitazione" (deviazione standard dell'accelerazione) per ogni secondo
    private SensorManager sm;
    private boolean hasStepSensor;
    private int stepsInSecond;
    private double accSum, accSq;
    private int accN;
    private int journalLines;
    private final Runnable motionTick = new Runnable() {
        @Override public void run() { emitMotion(); main.postDelayed(this, 1000); }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Registrazione attività", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    @SuppressLint({"MissingPermission", "WakelockTimeout"})
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // nuova attività: diario azzerato. Riavvio del servizio da parte del sistema (intent null): si continua.
        if (intent != null && intent.getBooleanExtra(EXTRA_FRESH, false)) clearJournal(this);
        Notification n = buildNotification(lastText);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIF_ID, n);

        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TrailTrack:tracking");
            wakeLock.acquire();
        }
        if (lm == null) {
            lm = (LocationManager) getSystemService(LOCATION_SERVICE);
            try {
                if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                    MainActivity.jsCall("__nativeGeoErr", MainActivity.q("GPS disattivato: attiva la localizzazione nelle impostazioni del telefono"));
                }
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
                nmeaListener = (msg, ts) -> parseNmea(msg);
                lm.addNmeaListener(nmeaListener, main);
            } catch (SecurityException e) {
                MainActivity.jsCall("__nativeGeoErr", "'denied'");
                stopSelf();
            } catch (Exception e) {
                MainActivity.jsCall("__nativeGeoErr", MainActivity.q(e.getMessage()));
            }
        }
        if (sm == null) startMotion();
        // se il sistema chiude l'app per liberare memoria, il servizio riparte da solo
        return START_STICKY;
    }

    private void startMotion() {
        sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        if (sm == null) return;
        Sensor step = sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR);
        boolean stepPerm = Build.VERSION.SDK_INT < 29
                || checkSelfPermission(android.Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
        if (step != null && stepPerm) hasStepSensor = sm.registerListener(this, step, SensorManager.SENSOR_DELAY_FASTEST, 0);
        Sensor acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        if (acc != null) sm.registerListener(this, acc, SensorManager.SENSOR_DELAY_GAME, 0);
        main.postDelayed(motionTick, 1000);
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        if (e.sensor.getType() == Sensor.TYPE_STEP_DETECTOR) {
            stepsInSecond++;
        } else if (e.sensor.getType() == Sensor.TYPE_ACCELEROMETER) {
            double m = Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]);
            accSum += m; accSq += m * m; accN++;
        }
    }

    @Override public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    private void emitMotion() {
        // accelerometro fermo (alcuni telefoni lo sospendono a schermo spento): nessun dato,
        // così l'app usa il GPS invece di credere che tu sia fermo
        if (accN < 5) return;
        try {
            double mean = accSum / accN;
            double std = Math.sqrt(Math.max(0, accSq / accN - mean * mean));
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis());
            o.put("steps", hasStepSensor ? stepsInSecond : JSONObject.NULL);
            o.put("std", Math.round(std * 100) / 100.0);
            stepsInSecond = 0; accSum = 0; accSq = 0; accN = 0;
            String j = o.toString();
            journal("m", o);
            MainActivity.jsCall("__nativeMotion", j);
        } catch (Exception ignored) { }
    }

    // ───────────── Diario su file ─────────────

    private void journal(String kind, JSONObject o) {
        synchronized (JLOCK) {
            if (journalLines == 0) journalLines = countLines(this);
            if (journalLines >= JOURNAL_MAX_LINES) return;
            try (FileWriter w = new FileWriter(new File(getFilesDir(), JOURNAL), true)) {
                o.put("k", kind);
                w.write(o.toString());
                w.write('\n');
                journalLines++;
            } catch (Exception ignored) { }
        }
    }

    private static int countLines(Context c) {
        File f = new File(c.getFilesDir(), JOURNAL);
        if (!f.exists()) return 0;
        int n = 0;
        try (BufferedReader r = new BufferedReader(new FileReader(f))) { while (r.readLine() != null) n++; }
        catch (Exception ignored) { }
        return n;
    }

    static void clearJournal(Context c) {
        synchronized (JLOCK) {
            new File(c.getFilesDir(), JOURNAL).delete();
            TrackingService s = running;
            if (s != null) s.journalLines = 0;
        }
    }

    /** Eventi del diario successivi a "since" (ms), come array JSON. */
    static String readJournal(Context c, long since) {
        StringBuilder sb = new StringBuilder("[");
        synchronized (JLOCK) {
            File f = new File(c.getFilesDir(), JOURNAL);
            if (f.exists()) {
                try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                    String line;
                    boolean first = true;
                    while ((line = r.readLine()) != null) {
                        int i = line.indexOf("\"t\":");
                        if (i < 0) continue;
                        int j = i + 4, k = j;
                        while (k < line.length() && Character.isDigit(line.charAt(k))) k++;
                        try { if (Long.parseLong(line.substring(j, k)) <= since) continue; }
                        catch (NumberFormatException e) { continue; }
                        if (!first) sb.append(',');
                        sb.append(line);
                        first = false;
                    }
                } catch (Exception ignored) { }
            }
        }
        return sb.append(']').toString();
    }

    private void parseNmea(String msg) {
        // $GPGGA,hhmmss,lat,N,lon,E,fix,sats,hdop,ALT,M,geoid,M,...
        if (msg == null || msg.length() < 6 || !msg.startsWith("GGA", 3)) return;
        String[] f = msg.split(",");
        if (f.length > 9 && f[6].length() > 0 && !"0".equals(f[6]) && f[9].length() > 0) {
            try {
                mslAlt = Double.parseDouble(f[9]);
                mslAt = System.currentTimeMillis();
            } catch (NumberFormatException ignored) { }
        }
    }

    @Override
    public void onLocationChanged(Location l) {
        try {
            JSONObject o = new JSONObject();
            o.put("lat", l.getLatitude());
            o.put("lon", l.getLongitude());
            o.put("acc", l.hasAccuracy() ? l.getAccuracy() : 50);
            Double alt = null;
            if (Build.VERSION.SDK_INT >= 34 && l.hasMslAltitude()) alt = l.getMslAltitudeMeters();
            else if (!Double.isNaN(mslAlt) && System.currentTimeMillis() - mslAt < 3000) alt = mslAlt;
            else if (l.hasAltitude()) alt = l.getAltitude();
            o.put("alt", alt == null ? JSONObject.NULL : alt);
            o.put("speed", l.hasSpeed() ? l.getSpeed() : JSONObject.NULL);
            o.put("t", System.currentTimeMillis());
            String j = o.toString();
            journal("f", o);
            MainActivity.jsCall("__nativeFix", j);
        } catch (Exception ignored) { }
    }

    @Override public void onProviderDisabled(String provider) {
        MainActivity.jsCall("__nativeGeoErr", MainActivity.q("GPS disattivato"));
    }
    @Override public void onProviderEnabled(String provider) { }
    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle("TrailTrack · registrazione")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .build();
    }

    /** Aggiorna il testo della notifica (tempo, km, dislivello) — chiamato dal JS. */
    static void updateText(String text) {
        TrackingService s = running;
        if (s == null) return;
        s.main.post(() -> {
            s.lastText = text;
            s.getSystemService(NotificationManager.class).notify(NOTIF_ID, s.buildNotification(text));
        });
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // app tolta dalle recenti: la registrazione continua (si ferma solo con Stop),
        // riaprendo l'app dalla notifica si ritrova tutto
    }

    @Override
    public void onDestroy() {
        if (lm != null) {
            lm.removeUpdates(this);
            if (nmeaListener != null) lm.removeNmeaListener(nmeaListener);
        }
        if (sm != null) sm.unregisterListener(this);
        main.removeCallbacks(motionTick);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
