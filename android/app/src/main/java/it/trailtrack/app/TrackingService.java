package it.trailtrack.app;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
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

/**
 * Servizio in primo piano: tiene vivo il GPS (e l'app) anche a schermo spento e
 * inoltra ogni posizione all'interfaccia JavaScript.
 */
public class TrackingService extends Service implements LocationListener {

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
        return START_NOT_STICKY;
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
            o.put("t", l.getTime());
            MainActivity.jsCall("__nativeFix", o.toString());
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
        // l'app è stata chiusa dalle recenti: lo stato è salvato, al riavvio si può riprendere
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (lm != null) {
            lm.removeUpdates(this);
            if (nmeaListener != null) lm.removeNmeaListener(nmeaListener);
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
