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
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.widget.ArrayAdapter;

import org.json.JSONArray;
import org.json.JSONObject;

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
    private boolean connected;
    private Integer battery;
    private int retries;

    private BluetoothLeScanner scanner;
    private ScanCallback scanCb;
    private AlertDialog picker;

    HeartRateManager(MainActivity act) { this.act = act; }

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
        device = d;
        wanted = true;
        retries = 0;
        battery = null;
        state(null);
        gatt = d.connectGatt(act, false, cb, BluetoothDevice.TRANSPORT_LE);
    }

    void disconnect() {
        wanted = false;
        stopScan();
        closeGatt();
        connected = false;
        device = null;
        state(null);
    }

    private void closeGatt() {
        if (gatt != null) {
            try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) { }
        }
        gatt = null;
    }

    private final BluetoothGattCallback cb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                main.post(g::discoverServices);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                boolean was = connected;
                connected = false;
                g.close();
                if (g == gatt) gatt = null;
                state(null);
                if (wanted && device != null && retries < 20) {
                    retries++;
                    if (was) MainActivity.jsCall("__nativeHrToast", MainActivity.q("Band disconnessa, riconnessione…"));
                    // autoConnect=true: Android si ricollega appena la band torna a portata
                    main.postDelayed(() -> { if (wanted && device != null && gatt == null) gatt = device.connectGatt(act, true, cb, BluetoothDevice.TRANSPORT_LE); }, 2000);
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            BluetoothGattService s = g.getService(HR_SERVICE);
            BluetoothGattCharacteristic c = s == null ? null : s.getCharacteristic(HR_MEASUREMENT);
            if (c == null) {
                wanted = false;
                String name = String.valueOf(device == null ? "" : device.getName());
                closeGatt();
                connected = false;
                state(name.matches("(?i).*(mi |band|xiaomi|redmi).*")
                        ? "La Mi Band non sta condividendo il battito.\n\nApri Zepp Life (o Mi Fitness) → Profilo → la tua band → attiva \"Condivisione frequenza cardiaca\", poi riprova."
                        : "Questo dispositivo non espone il servizio Bluetooth della frequenza cardiaca.");
                return;
            }
            g.setCharacteristicNotification(c, true);
            BluetoothGattDescriptor d = c.getDescriptor(CCCD);
            if (d != null) writeDescriptor(g, d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            connected = true;
            retries = 0;
            state(null);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            // dopo l'attivazione delle notifiche leggiamo la batteria (un'operazione GATT alla volta)
            BluetoothGattService b = g.getService(BATTERY_SERVICE);
            if (b != null && b.getCharacteristic(BATTERY_LEVEL) != null) g.readCharacteristic(b.getCharacteristic(BATTERY_LEVEL));
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

    @SuppressWarnings("deprecation")
    private void writeDescriptor(BluetoothGatt g, BluetoothGattDescriptor d, byte[] v) {
        if (Build.VERSION.SDK_INT >= 33) g.writeDescriptor(d, v);
        else { d.setValue(v); g.writeDescriptor(d); }
    }

    private void onRead(BluetoothGattCharacteristic c, byte[] v) {
        if (BATTERY_LEVEL.equals(c.getUuid()) && v != null && v.length > 0) {
            battery = v[0] & 0xff;
            state(null);
        }
    }

    private void onData(BluetoothGattCharacteristic c, byte[] v) {
        if (!HR_MEASUREMENT.equals(c.getUuid()) || v == null) return;
        JSONArray a = new JSONArray();
        for (byte b : v) a.put(b & 0xff);
        MainActivity.jsCall("__nativeHrData", a.toString());
    }

    /** Invia lo stato al JS; error != null mostra un messaggio. */
    private void state(String error) {
        try {
            JSONObject o = new JSONObject();
            o.put("connected", connected);
            o.put("connecting", wanted && !connected);
            o.put("name", device == null ? JSONObject.NULL : String.valueOf(device.getName()));
            o.put("battery", battery == null ? JSONObject.NULL : battery);
            o.put("error", error == null ? JSONObject.NULL : error);
            MainActivity.jsCall("__nativeHrState", o.toString());
        } catch (Exception ignored) { }
    }
}
