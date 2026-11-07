# TrailTrack — allenamenti e trekking

Web app (PWA) installabile sul telefono, senza server: tutti i dati restano sul dispositivo.

## Funzioni
- **Avvia / Pausa / Stop** per trekking, camminata, corsa, bici e allenamento al chiuso (senza GPS).
- **Pausa automatica**: a piedi usa il **contapassi** del telefono (o l'accelerometro): se per 12 s (8 s in corsa)
  non fai passi sei fermo, anche se il GPS "balla" — ad esempio mentre parli con qualcuno. Il *tempo in movimento*
  si ferma retrodatato all'ultimo passo e riparte da solo dopo 3 secondi di cammino. In bici, o senza sensori,
  decide il GPS (velocità Doppler e spostamento medio).
- **Non si interrompe**: se Android chiude l'app per liberare memoria, il servizio continua a registrare GPS e passi;
  riaprendo l'app l'attività riprende da sola con tutti i dati, senza premere nulla.
- **GPS preciso**: scarta posizioni imprecise e salti anomali, filtro di Kalman contro il "tremolio".
- **Dislivello**: quota GPS smussata con isteresi; nel dettaglio puoi **correggere le quote con il DEM**
  (modello del terreno Copernicus via Open-Meteo) per un D+ più affidabile.
- **Mappa** topografica / stradale / satellite, traccia colorabile per velocità, quota o battito,
  marcatori km e soste, profilo altimetrico interattivo, parziali per km.
- **Band / cardiofrequenzimetro** via Bluetooth (servizio Heart Rate standard): FC live, zone, FC max/media,
  HRV (RMSSD), misura FC a riposo, batteria; calorie stimate.
- **Foto nel recap**: dal riepilogo di un'attività puoi scattare foto o sceglierle dalla galleria; vengono
  ridimensionate e salvate sul dispositivo (anche nel backup JSON), con didascalia. Se la foto ha la posizione
  GPS o l'ora di scatto cade durante l'attività, compare sulla mappa nel punto in cui l'hai fatta.
- **Storico** con totali e filtri, export/import **GPX** (anche con battito), backup JSON.
- Recupero automatico dell'attività se l'app si chiude; funziona offline (mappe già viste in cache).

## Uso
Serve HTTPS (es. GitHub Pages: `https://<utente>.github.io/TrailTrack/trekking/`).
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
