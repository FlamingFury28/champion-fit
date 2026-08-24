# Champion Fit webapp

Dashboard locale basata su SQLite per gli output di Champion Fit.

## Avvio locale

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python .\app.py
```

Apri `http://127.0.0.1:8787`.

Il primo avvio crea un database SQLite locale vuoto in `champion_fit.db`. Il database operativo e gli snapshot personali non fanno parte del repository pubblico.

Per importare un'analisi locale già prodotta:

```powershell
python .\app.py --source C:\percorso\champion_fit_v2 --rebuild
```

I dati sorgente non vengono mai modificati.

## Architettura

- `champion_fit.db`: database SQLite generato localmente; non viene distribuito nel repository.
- Il progetto considera esclusivamente le code della Landa degli Evocatori: Quickplay/Swiftplay, Draft, Ranked Flex, Ranked Solo/Duo, Scelta segreta (Blind Pick) e Clash. URF, ARAM, bot e ogni altra modalità sono escluse all'importazione e dalle statistiche; quelle già presenti vengono rimosse all'avvio dell'app.
- `app.py`: importatore SQLite, API JSON e server locale senza dipendenze esterne.
- `ingest.py`: adapter per snapshot JSON normalizzati; può essere alimentato in futuro da Riot API o exporter, senza chiamate remote e senza modificare il frontend.
- `riot_sync.py` e `check_new_matches.py`: sincronizzazione Riot opzionale; gli account vengono passati tramite `RIOT_ACCOUNTS` o `--account` e non sono memorizzati nel codice.
- `storage.py`: confine di persistenza; SQLite è l’implementazione attiva, sostituibile in futuro con PostgreSQL.
- `migrate_postgres.py`: migrazione opzionale SQLite → PostgreSQL; richiede `psycopg` solo quando viene eseguita.
- `web/`: frontend vanilla responsive.
- `web/profile.html`: profilo competitivo filtrabile e aggregabile per account, funzionante su snapshot locale e predisposto alla futura sincronizzazione API.
- `champions.icon_url`: URL remoti Riot Data Dragon. Le icone non sono scaricate né archiviate localmente; il browser le richiede direttamente al CDN.

### Algoritmo delle raccomandazioni

Le tre raccomandazioni sono calcolate dinamicamente per ogni selezione di account e per ogni coppia champion+ruolo. Le vittorie usano `win_evidence_weight`; le sconfitte usano `loss_attribution_weight`, azzerato quando un'annotazione indica AFK, griefer o partita invincibile. Per i match Riot che non forniscono già un peso, il modello `duration_bands_v2` usa il prior storico calibrato per durata: `<10m = 0`, `10-15m = 0,04`, `15-20m = 0,15`, `20-23m = 0,35`, `23-27m = 0,60`, `>=27m = 0,88`; AFK esplicito, quasi-AFK, resa anticipata, collasso precoce e forte deficit di kill lo riducono ulteriormente. Il peso è una stima di quanta parte della loss sia attribuibile al champion, non una probabilità letterale che ci fosse un AFK. Il prior Beta di ciascun ruolo è stimato esclusivamente dalle partite incluse nella selezione attiva: gli account non selezionati non influenzano il risultato. Il ranking usa il limite inferiore dell'intervallo credibile al 90% del fit posteriore: campioni con pochi game non possono quindi superare automaticamente evidenze più solide solo grazie a un win rate grezzo elevato. La blacklist è un risultato separato e non entra nel calcolo del punteggio.

Nel confronto matchup, `Ban consigliato` e `Ban sconsigliato` usano un punteggio composito: posterior bayesiana con shrinkage verso il baseline del profilo, intervallo credibile al 90%, confidenza nella direzione, evidenza effettivamente attribuibile alla partita, copertura qualitativa, recenza e solo marginalmente esposizione dell'avversario. Il win rate grezzo e il numero di game restano descrittivi, non sono il ranking. La direzione usa l'evidenza pesata: un avversario entra nella prima lista solo se la sua evidenza negativa supera quella positiva, nella seconda solo nel caso opposto; i pareggi e i segnali con confidenza direzionale inferiore al 60% vengono esclusi, così lo stesso champion non può comparire in entrambe le colonne.

### Formato snapshot normalizzato

```powershell
python .\ingest.py .\snapshot.json
```

Il file può contenere `{ "source": "riot_api", "matches": [...] }`. Ogni match richiede `account`, `match_id`, `date`, `patch`, `queue`, `champion`, `role`, `duration_minutes` e `win`; gli altri campi sono opzionali. L’import è idempotente per `account + match_id`.

### Sincronizzazione opzionale con Riot API

Le chiavi e gli account sono sempre configurazione locale. Non inserirli nei commit:

```powershell
$env:RIOT_API_KEY = "la-tua-chiave-locale"
python .\riot_sync.py --account "NomeAccount#EUW"
```

Per più account si può usare `RIOT_ACCOUNTS`, separandoli con virgole o punto e virgola:

```powershell
$env:RIOT_ACCOUNTS = "NomeAccount#EUW,AltroAccount#EUW"
python .\riot_sync.py
```

`.env.example` contiene solo nomi di variabili e valori dimostrativi.

### Migrazione opzionale

```powershell
pip install "psycopg[binary]"
python .\migrate_postgres.py "postgresql://user:password@host/champion_fit"
```

SQLite resta il default finché non viene eseguita esplicitamente la migrazione.

### Stack containerizzato

Per avviare PostgreSQL, migrare il database e servire l’applicazione:

```powershell
$env:POSTGRES_PASSWORD = "scegli-una-password-locale"
docker compose -f .\docker-compose.production.yml up -d --build
```

L’app sarà disponibile su `http://127.0.0.1:8787`. Il servizio `web` parte solo dopo la migrazione completata.

Per avviare direttamente il server sul PostgreSQL migrato:

```powershell
$env:CHAMPION_FIT_DATABASE_URL = "postgresql://champion_fit:champion_fit_local@localhost:55432/champion_fit"
python .\app.py --source C:\percorso\qualunque
```

Per un test locale del backend server:

```powershell
docker compose -f .\docker-compose.postgres.yml up -d
python .\migrate_postgres.py "postgresql://champion_fit:champion_fit_local@localhost:55432/champion_fit"
```

## Pubblicazione open source

Il repository include il codice, lo schema e i test, ma esclude database SQLite, snapshot personali, output generati e configurazione locale tramite `.gitignore` e `.dockerignore`.

La licenza prevista è MIT. Prima della pubblicazione sostituisci il titolare indicato come `[YOUR NAME OR ORGANIZATION]` nel file `LICENSE`.
