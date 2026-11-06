# TrailTrack — allenamenti e trekking

Web app (PWA) installabile sul telefono, senza server: tutti i dati restano sul dispositivo.

## Funzioni
- **Avvia / Pausa / Stop** per trekking, camminata, corsa, bici e allenamento al chiuso (senza GPS).
- **Pausa automatica**: se per 10–30 s (in base all'attività) tutte le posizioni restano in un cerchio
  di pochi metri, l'app capisce che sei fermo, ferma il *tempo in movimento* (retrodatandolo all'inizio
  della sosta) e lascia correre il *tempo totale*. Riparte da sola appena ti allontani.
- **GPS preciso**: scarta posizioni imprecise e salti anomali, filtro di Kalman contro il "tremolio".
- **Dislivello**: quota GPS smussata con isteresi; nel dettaglio puoi **correggere le quote con il DEM**
  (modello del terreno Copernicus via Open-Meteo) per un D+ più affidabile.
- **Mappa** topografica / stradale / satellite, traccia colorabile per velocità, quota o battito,
  marcatori km e soste, profilo altimetrico interattivo, parziali per km.
- **Band / cardiofrequenzimetro** via Bluetooth (servizio Heart Rate standard): FC live, zone, FC max/media,
  HRV (RMSSD), misura FC a riposo, batteria; calorie stimate.
- **Storico** con totali e filtri, export/import **GPX** (anche con battito), backup JSON.
- Recupero automatico dell'attività se l'app si chiude; funziona offline (mappe già viste in cache).

## Uso
Serve HTTPS (es. GitHub Pages: `https://<utente>.github.io/codexdemo/trekking/`).
Apri il link dal telefono → menu del browser → "Aggiungi a schermata Home".
In *Impostazioni* c'è una **modalità demo** che simula GPS e battito per provarla da PC.

## Limiti da conoscere
- Le web app non registrano il GPS con lo schermo spento: l'app tiene lo schermo acceso durante
  l'attività (Wake Lock). Puoi abbassare la luminosità, ma non bloccare il telefono.
- Il Bluetooth web funziona su **Chrome per Android / PC**, non su Safari iPhone.

## Collegare la Xiaomi Mi Band 6
1. Nell'app **Zepp Life** (o **Mi Fitness**, a seconda di come l'hai associata): Profilo → *Mi Smart Band 6* →
   attiva **"Condivisione frequenza cardiaca"** (Heart rate sharing).
2. Sulla band avvia un **allenamento** (es. *Camminata all'aperto*): così misura il battito ogni secondo
   invece che ogni qualche minuto.
3. In TrailTrack: *Salute* → **Collega band** → scegli *Mi Smart Band 6*.

L'app legge solo il battito (e l'HRV, se la band invia gli intervalli R-R). Passi, sonno, SpO₂ e stress della
Mi Band sono cifrati con una chiave di Xiaomi e non sono leggibili da un'app esterna.
