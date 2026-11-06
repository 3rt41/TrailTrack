package it.trailtrack.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.widget.ArrayAdapter;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Collegamento a band e fasce cardio tramite il servizio Bluetooth standard "Heart Rate" (0x180D).
 * Le Xiaomi Mi Band lo espongono quando nell'app Zepp Life / Mi Fitness è attiva
 * "Condivisione frequenza cardiaca".
 */
@SuppressLint("MissingPermission")
public class HeartRateManager {

    static final int REQ_ENABLE_BT = 20;
    static final UUID HR_SERVICE = UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb");
    static final UUID HR_MEASUREMENT = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb");
    static final UUID BATTERY_SERVICE = UUID.fromString("0000180f-0000-1000-8000-00805f9b34fb");
    static final UUID BATTERY_LEVEL = UUID.fromString("00002a19-0000-1000-8000-00805f9b34fb");
    static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    static final Pattern WEARABLE = Pattern.compile("(?i)band|mi |xiaomi|redmi|amazfit|polar|garmin|wahoo|coros|hrm|heart|tickr|suunto|huawei|honor|fitbit|watch|forerunner|venu|fenix");

    private final MainActivity act;
    private final Handler main = new Handler(Looper.getMainLooper());
    private BluetoothAdapter adapter;
    private BluetoothGatt gatt;
    private BluetoothDevice device;
    private boolean wanted;          // l'utente vuole restare collegato (riconnessione automatica)
    private boolean connected;       // collegato e notifiche del battito attive
    private boolean everConnected;   // la sessione ha funzionato almeno una volta
    private Integer battery;
    private int attempts, discoverRetries, cccdRetries;
    private long lastDataAt;
    private boolean refreshNext;     // dopo un errore 133 svuota la cache dei servizi
    private String phase = "";

    private BluetoothLeScanner scanner;
    private ScanCallback scanCb;
    private AlertDialog picker;

    HeartRateManager(MainActivity act) {
        this.act = act;
        IntentFilter f = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(bondReceiver, f, Context.RECEIVER_EXPORTED);
        else act.registerReceiver(bondReceiver, f);
    }

    void release() {
        try { act.unregisterReceiver(bondReceiver); } catch (Exception ignored) { }
    }

    private List<String> perms() {
        List<String> l = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            l.add(Manifest.permission.BLUETOOTH_SCAN);
            l.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            l.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        return l;
    }

    void connect() {
        act.withPermissions(perms(), this::connectGranted,
                () -> state("Permesso Bluetooth negato: abilitalo nelle impostazioni dell'app."));
    }

    private void connectGranted() {
        BluetoothManager bm = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null) { state("Questo telefono non ha il Bluetooth."); return; }
        if (!adapter.isEnabled()) {
            act.startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE_BT);
            return;
        }
        showPicker(bm);
    }

    /** Elenco dispositivi: già collegati al telefono, associati, e trovati con la scansione. */
    private void showPicker(BluetoothManager bm) {
        final Map<String, BluetoothDevice> devices = new LinkedHashMap<>();
        final List<String> labels = new ArrayList<>();
        final ArrayAdapter<String> list = new ArrayAdapter<>(act, android.R.layout.simple_list_item_1, labels);

        Runnable refresh = () -> {
            labels.clear();
            for (BluetoothDevice d : devices.values()) labels.add(label(d));
            list.notifyDataSetChanged();
        };

        for (BluetoothDevice d : bm.getConnectedDevices(BluetoothProfile.GATT)) devices.put(d.getAddress(), d);
        log("Dispositivi già collegati al telefono: " + devices.size());
        for (BluetoothDevice d : adapter.getBondedDevices()) {
            if (d.getType() != BluetoothDevice.DEVICE_TYPE_CLASSIC && WEARABLE.matcher(String.valueOf(d.getName())).find()) devices.put(d.getAddress(), d);
        }
        refresh.run();

        scanner = adapter.getBluetoothLeScanner();
        scanCb = new ScanCallback() {
            @Override
            public void onScanResult(int type, ScanResult r) {
                BluetoothDevice d = r.getDevice();
                String name = d.getName();
                boolean hr = false;
                if (r.getScanRecord() != null && r.getScanRecord().getServiceUuids() != null) {
                    for (ParcelUuid u : r.getScanRecord().getServiceUuids()) if (HR_SERVICE.equals(u.getUuid())) hr = true;
                }
                if (name == null && !hr) return;
                if (!hr && !WEARABLE.matcher(name).find()) return;
                if (devices.containsKey(d.getAddress())) return;
                devices.put(d.getAddress(), d);
                main.post(refresh);
            }
        };
        if (scanner != null) {
            scanner.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCb);
            main.postDelayed(this::stopScan, 20000);
        }

        picker = new AlertDialog.Builder(act)
                .setTitle("Scegli la band (ricerca in corso…)")
                .setAdapter(list, (dlg, which) -> {
                    stopScan();
                    List<BluetoothDevice> arr = new ArrayList<>(devices.values());
                    if (which < arr.size()) open(arr.get(which));
                })
                .setNegativeButton("Annulla", (dlg, w) -> stopScan())
                .setOnCancelListener(d -> stopScan())
                .create();
        picker.show();
    }

    private String label(BluetoothDevice d) {
        String n = d.getName();
        return (n == null || n.isEmpty() ? "Dispositivo" : n) + "  ·  " + d.getAddress().substring(9);
    }

    private void stopScan() {
        if (scanner != null && scanCb != null) {
            try { scanner.stopScan(scanCb); } catch (Exception ignored) { }
        }
        scanCb = null;
    }

    private void open(BluetoothDevice d) {
        closeGatt();
        main.removeCallbacksAndMessages(null);
        device = d;
        wanted = true;
        connected = false;
        everConnected = false;
        battery = null;
        attempts = 0;
        lastDataAt = 0;
        log("Dispositivo scelto: " + nameOf(d) + " (" + d.getAddress() + "), associato: " + (d.getBondState() == BluetoothDevice.BOND_BONDED ? "sì" : "no"));
        doConnect(false);
    }

    private void doConnect(boolean auto) {
        if (!wanted || device == null) return;
        closeGatt();
        discoverRetries = 0;
        cccdRetries = 0;
        phase("Connessione a " + nameOf(device) + (attempts > 0 ? " (tentativo " + (attempts + 1) + ")" : "") + "…");
        gatt = device.connectGatt(act, auto, cb, BluetoothDevice.TRANSPORT_LE);
        main.removeCallbacks(connectTimeout);
        if (!auto) main.postDelayed(connectTimeout, 15000);
    }

    private final Runnable connectTimeout = () -> {
        if (connected || !wanted) return;
        log("Nessuna risposta dalla band in 15 s");
        retryOrFail();
    };

    private final Runnable dataTimeout = () -> {
        if (connected && lastDataAt == 0) {
            log("Collegato, ma la band non invia il battito");
            MainActivity.jsCall("__nativeHrToast", MainActivity.q("Collegato, ma nessun battito: avvia un allenamento sulla band"));
            phase("Collegato · in attesa del battito (avvia un allenamento sulla band)");
        }
    };

    /** Il primo collegamento è fallito: riprova qualche volta, poi spiega cosa controllare. */
    private void retryOrFail() {
        closeGatt();
        if (!wanted) return;
        if (++attempts <= 3) {
            main.postDelayed(() -> doConnect(false), 1200L * attempts);
            return;
        }
        wanted = false;
        phase("");
        state("Non riesco a collegarmi a " + nameOf(device) + ".\n\n"
                + "Controlla che:\n"
                + "• in Zepp Life / Mi Fitness siano attive \"Condivisione frequenza cardiaca\" e, se c'è, \"Rilevabile\";\n"
                + "• la band sia vicina al telefono e non collegata a un altro telefono;\n"
                + "• il Bluetooth del telefono funzioni (prova a spegnerlo e riaccenderlo).\n\n"
                + "Poi riprova. In Salute → Diagnostica trovi i dettagli del tentativo.");
        device = null;
    }

    void disconnect() {
        wanted = false;
        main.removeCallbacksAndMessages(null);
        stopScan();
        closeGatt();
        connected = false;
        device = null;
        phase = "";
        state(null);
    }

    private void closeGatt() {
        if (gatt != null) {
            try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) { }
        }
        gatt = null;
    }

    /** Svuota la cache dei servizi di Android (a volte resta quella vecchia e il servizio cardiaco "non c'è"). */
    private static void refreshCache(BluetoothGatt g) {
        try {
            Method m = g.getClass().getMethod("refresh");
            m.invoke(g);
        } catch (Exception ignored) { }
    }

    private final BluetoothGattCallback cb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            main.post(() -> onState(g, status, newState));
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            main.post(() -> onServices(g, status));
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            main.post(() -> onCccdWritten(g, status));
        }

        // Android 13+
        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
            onRead(c, value);
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            onRead(c, c.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            onData(c, value);
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            onData(c, c.getValue());
        }
    };

    private void onState(BluetoothGatt g, int status, int newState) {
        if (g != gatt) { g.close(); return; } // callback di una connessione vecchia
        log("Stato connessione: " + (newState == BluetoothProfile.STATE_CONNECTED ? "collegato" : "scollegato") + " (codice " + status + ")");
        if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
            main.removeCallbacks(connectTimeout);
            phase("Collegato, cerco il servizio del battito…");
            if (refreshNext) { refreshCache(g); refreshNext = false; }
            // piccola attesa: con dispositivi associati Android completa prima la cifratura
            main.postDelayed(() -> { if (g == gatt && !g.discoverServices()) { log("Ricerca servizi non avviata"); retryOrFail(); } }, 700);
            return;
        }
        // disconnessione o errore (es. codice 133, il classico errore generico di Android)
        boolean was = connected;
        connected = false;
        main.removeCallbacks(dataTimeout);
        g.close();
        gatt = null;
        state(null);
        if (!wanted || device == null) return;
        if (was || everConnected) {
            MainActivity.jsCall("__nativeHrToast", MainActivity.q("Band disconnessa, riconnessione…"));
            phase("Riconnessione a " + nameOf(device) + "…");
            // autoConnect: Android si ricollega da solo appena la band torna a portata
            main.postDelayed(() -> doConnect(true), 1500);
        } else {
            if (status == 133) refreshNext = true;
            retryOrFail();
        }
    }

    private void onServices(BluetoothGatt g, int status) {
        if (g != gatt) return;
        List<String> found = new ArrayList<>();
        for (BluetoothGattService sv : g.getServices()) found.add(shortUuid(sv.getUuid()));
        log("Servizi trovati (" + status + "): " + (found.isEmpty() ? "nessuno" : String.join(", ", found)));
        BluetoothGattService s = g.getService(HR_SERVICE);
        BluetoothGattCharacteristic c = s == null ? null : s.getCharacteristic(HR_MEASUREMENT);
        if (c == null && discoverRetries < 2) {
            discoverRetries++;
            log("Servizio battito non visto: svuoto la cache e riprovo");
            refreshCache(g);
            main.postDelayed(() -> { if (g == gatt) g.discoverServices(); }, 1000);
            return;
        }
        if (c == null) {
            wanted = false;
            String name = nameOf(device);
            closeGatt();
            connected = false;
            phase("");
            state(name.matches("(?i).*(mi |band|xiaomi|redmi).*")
                    ? "La band è collegata ma non condivide il battito.\n\nApri Zepp Life (o Mi Fitness) → Profilo → la tua band e attiva \"Condivisione frequenza cardiaca\" (e \"Rilevabile\", se c'è). Poi avvia un allenamento sulla band e riprova."
                    : "Questo dispositivo non espone il servizio Bluetooth della frequenza cardiaca.");
            return;
        }
        enableNotifications(g, c);
    }

    private void enableNotifications(BluetoothGatt g, BluetoothGattCharacteristic c) {
        phase("Attivo la lettura del battito…");
        boolean ok = g.setCharacteristicNotification(c, true);
        BluetoothGattDescriptor d = c.getDescriptor(CCCD);
        if (d == null) { log("Descrittore notifiche assente: provo comunque"); onCccdWritten(g, BluetoothGatt.GATT_SUCCESS); return; }
        int props = c.getProperties();
        byte[] v = (props & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.ENABLE_INDICATION_VALUE;
        boolean started = writeDescriptor(g, d, v);
        log("Notifiche: setNotification=" + ok + ", scrittura avviata=" + started);
        if (!started) main.postDelayed(() -> { if (g == gatt && !connected) retryCccd(g); }, 800);
    }

    private void retryCccd(BluetoothGatt g) {
        if (cccdRetries++ >= 3) { log("Impossibile attivare le notifiche"); retryOrFail(); return; }
        BluetoothGattService s = g.getService(HR_SERVICE);
        if (s != null && s.getCharacteristic(HR_MEASUREMENT) != null) enableNotifications(g, s.getCharacteristic(HR_MEASUREMENT));
    }

    private void onCccdWritten(BluetoothGatt g, int status) {
        if (g != gatt) return;
        log("Attivazione notifiche: codice " + status);
        if (status == BluetoothGatt.GATT_SUCCESS) {
            connected = true;
            everConnected = true;
            attempts = 0;
            phase(lastDataAt > 0 ? "" : "Collegato · in attesa del battito…");
            state(null);
            main.removeCallbacks(dataTimeout);
            main.postDelayed(dataTimeout, 20000);
            BluetoothGattService b = g.getService(BATTERY_SERVICE);
            if (b != null && b.getCharacteristic(BATTERY_LEVEL) != null) g.readCharacteristic(b.getCharacteristic(BATTERY_LEVEL));
            return;
        }
        // 5 / 15 / 137: serve l'associazione (cifratura) prima di leggere il battito
        if ((status == 5 || status == 15 || status == 137 || status == 8) && device.getBondState() != BluetoothDevice.BOND_BONDED) {
            log("La band richiede l'associazione: avvio il pairing");
            phase("Associazione con la band… conferma sul telefono/band se richiesto");
            device.createBond();
            return;
        }
        main.postDelayed(() -> { if (g == gatt) retryCccd(g); }, 1000);
    }

    private final BroadcastReceiver bondReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
            if (d == null || device == null || !d.getAddress().equals(device.getAddress())) return;
            int st = i.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, -1);
            log("Associazione: " + (st == BluetoothDevice.BOND_BONDED ? "completata" : st == BluetoothDevice.BOND_BONDING ? "in corso" : "non associato"));
            if (st == BluetoothDevice.BOND_BONDED && gatt != null && !connected) main.postDelayed(() -> { if (gatt != null) retryCccd(gatt); }, 800);
        }
    };

    @SuppressWarnings("deprecation")
    private boolean writeDescriptor(BluetoothGatt g, BluetoothGattDescriptor d, byte[] v) {
        if (Build.VERSION.SDK_INT >= 33) return g.writeDescriptor(d, v) == BluetoothGatt.GATT_SUCCESS;
        d.setValue(v);
        return g.writeDescriptor(d);
    }

    private void onRead(BluetoothGattCharacteristic c, byte[] v) {
        if (BATTERY_LEVEL.equals(c.getUuid()) && v != null && v.length > 0) {
            battery = v[0] & 0xff;
            state(null);
        }
    }

    private void onData(BluetoothGattCharacteristic c, byte[] v) {
        if (!HR_MEASUREMENT.equals(c.getUuid()) || v == null) return;
        if (lastDataAt == 0) main.post(() -> { log("Battito ricevuto ✓"); phase(""); state(null); });
        lastDataAt = System.currentTimeMillis();
        JSONArray a = new JSONArray();
        for (byte b : v) a.put(b & 0xff);
        MainActivity.jsCall("__nativeHrData", a.toString());
    }

    private static String nameOf(BluetoothDevice d) {
        String n = d == null ? null : d.getName();
        return n == null || n.isEmpty() ? "la band" : n;
    }

    private static String shortUuid(UUID u) {
        String s = u.toString();
        return s.endsWith("-0000-1000-8000-00805f9b34fb") && s.startsWith("0000") ? s.substring(4, 8) : s.substring(0, 8);
    }

    private void log(String line) {
        MainActivity.jsCall("__nativeHrLog", MainActivity.q(line));
    }

    private void phase(String p) {
        phase = p == null ? "" : p;
        if (!phase.isEmpty()) log(phase);
        state(null);
    }

    /** Invia lo stato al JS; error != null mostra un messaggio. */
    private void state(String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("connected", connected);
            o.put("connecting", wanted && !connected);
            o.put("phase", phase);
            o.put("name", device == null ? JSONObject.NULL : nameOf(device));
            o.put("battery", battery == null ? JSONObject.NULL : battery);
            o.put("error", error == null ? JSONObject.NULL : error);
            MainActivity.jsCall("__nativeHrState", o.toString());
        } catch (Exception ignored) { }
    }
}
