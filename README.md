# Champion Fit webapp

Dashboard locale basata su SQLite per gli output di Champion Fit.

## Avvio locale

Servono Python 3.12+ e Node.js 24. Per lo sviluppo con hot reload, avvia il backend in un terminale:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python .\app.py
```

In un secondo terminale avvia Vite:

```powershell
npm --prefix frontend ci
npm --prefix frontend run dev
```

Apri `http://127.0.0.1:5173`. Vite inoltra `/api/*` al server Python su `http://127.0.0.1:8787`.

Per verificare la stessa topologia usata in produzione, compila prima gli asset e lascia che Python serva `frontend/dist`:

```powershell
npm --prefix frontend ci
npm --prefix frontend run build
python .\app.py
```

In questo caso apri `http://127.0.0.1:8787`. Se la build non esiste, il server continua a esporre le API e stampa un warning esplicito.

### Indirizzo fisso e avvio automatico su Windows

L'indirizzo locale stabile della dashboard è `http://championfit.localhost/app/overview` (la pagina iniziale è `http://championfit.localhost/`). Il nome `championfit.localhost` punta al PC stesso; il server resta accessibile solo da qui e non richiede modifiche al file hosts né privilegi amministrativi. Per avviare il server e aprire la dashboard in Firefox a ogni accesso a Windows, esegui una volta:

```powershell
.\scripts\install_champion_fit_startup.ps1
```

Lo script prepara la build frontend quando manca o è più vecchia dei sorgenti, poi avvia il server sulla porta `80` così `http://championfit.localhost` si apre senza specificare la porta. Apre l'indirizzo in Firefox, dove puoi aggiungerlo ai preferiti con `Ctrl+D`.

Il primo avvio crea un database SQLite locale vuoto in `champion_fit.db`. Il database operativo e gli snapshot personali non fanno parte del repository pubblico.

Per importare un'analisi locale già prodotta:

```powershell
python .\app.py --source C:\percorso\champion_fit_v2 --rebuild
```

I dati sorgente non vengono mai modificati.

## Architettura

- `champion_fit.db`: database SQLite generato localmente; non viene distribuito nel repository.
- Il progetto considera esclusivamente le code della Landa degli Evocatori: Quickplay/Swiftplay, Draft, Ranked Flex, Ranked Solo/Duo, Scelta segreta (Blind Pick) e Clash. URF, ARAM, bot e ogni altra modalità sono escluse all'importazione e dalle statistiche; quelle già presenti vengono rimosse all'avvio dell'app.
- `app.py`: importatore SQLite, API JSON e server degli asset Vite compilati; gestisce anche il fallback delle route SPA `/app/*`.
- `ingest.py`: adapter per snapshot JSON normalizzati; può essere alimentato in futuro da Riot API o exporter, senza chiamate remote e senza modificare il frontend.
- `check_new_matches.py`: aggiornamento Riot incrementale; `riot_sync.py`: prima importazione completa e rielaborazione dei raw locali. Vedi [RIOT_SYNC_RUNBOOK.md](RIOT_SYNC_RUNBOOK.md).
- `storage.py`: confine di persistenza; SQLite è l’implementazione attiva, sostituibile in futuro con PostgreSQL.
- `migrate_postgres.py`: migrazione opzionale SQLite → PostgreSQL; richiede `psycopg` solo quando viene eseguita.
- `frontend/`: applicazione React + TypeScript + Vite. `frontend/dist` è generata e non viene versionata.
- `champions.icon_url`: URL remoti Riot Data Dragon. Le icone non sono scaricate né archiviate localmente; il browser le richiede direttamente al CDN.

### Navigazione e lettura dei risultati

Il percorso principale è **Riepilogo**, **Campioni** e **Le mie partite**. Il riepilogo mette in primo piano le due analisi competitive: **Quali giochi meglio?** confronta il rendimento storico e **Piano da 400 partite** distribuisce un budget competitivo modificabile. In Campioni, **Altri strumenti** raccoglie **Avversari e alleati** e, come funzioni facoltative, **Familiari e preferiti**, i candidati affini e il breve **Piano di prove**. I collegamenti precedenti restano accessibili e aprono il gruppo aggiuntivo. Nel menu, **Compagni** e **Algoritmi** sono raccolti sotto **Strumenti**; la mappa del sito dà accesso a tutte le funzioni. Compagni riguarda le persone e i loro Riot ID.

La scheda di un campione si apre sopra la lista e ha un URL condivisibile. La chiusura conserva i filtri della lista; il ruolo della scheda è indipendente. I precedenti indirizzi delle pagine restano utilizzabili e portano all'area corrispondente con i parametri compatibili. **Dati usati**, in alto, permette di gestire account, profili salvati e filtro sui compagni. Questi filtri sono globali; quelli delle singole analisi restano locali.

Risultati personali, indici storici e ipotesi teoriche sono distinti anche quando riguardano lo stesso campione. Riunire i contenuti non modifica soglie, calcoli o significato statistico delle raccomandazioni.

### Viste dei dati

Il menu **Visualizzazione**, in alto, raccoglie **Vista dati** e **Aspetto**. Vista dati sceglie la rappresentazione per tutte le pagine: elenco, schede, barre, mappa a punti o radar dei comportamenti. La preferenza viene ripristinata una sola volta all’avvio, condivisa in memoria e applicata subito anche durante la navigazione. Cambiare vista conserva risultati e filtri senza nuove richieste API. Le sezioni che non supportano la rappresentazione scelta usano barre, schede o elenco secondo le misure disponibili, senza modificare la preferenza globale. Il browser salva la scelta e la sincronizza fra le schede aperte.

Le mappe confrontano la quantità indicata sull’asse orizzontale con la misura sull’asse verticale. Le barre mostrano intervalli e riferimenti solo quando appartengono alla stessa misura. Le viste teoriche dei champion mai provati offrono schede e barre. Negli stili, il radar confronta le mediane dei percentili delle vittorie e delle sconfitte quando almeno tre metriche hanno dati validi in entrambi gli esiti; i dati mancanti restano esclusi.

### Algoritmo delle raccomandazioni

Le raccomandazioni personali descrivono **preferenze osservate**. Nel perimetro attivo, `known` ordina i champion già scelti per quota di utilizzo recente con uguale peso per account; `discover` propone champion mai provati usando ruolo e similarità Jaccard di classi e stili. Il ranking non usa vittorie, sconfitte, prior Beta o pesi di attribuzione.

Con un solo account e poche partite il risultato è già leggibile come profilo provvisorio. Non diventa però una previsione di gradimento: ownership, ban, autofill, patch e intenzione del giocatore influenzano la scelta. Un account senza osservazioni resta mancante e non riceve una preferenza neutrale inventata. `like`, `dislike` e `neutral` sono feedback espliciti, versionati separatamente dai match.

Il riepilogo `performance` è distinto dal ranking. Mostra esiti grezzi, baseline complementare disgiunta e intervalli binomiali esatti senza prior o pseudopartite. Serve a leggere lo storico competitivo, non a ordinare `known` o `discover` e non dimostra che scegliere un champion causi vittorie.

Il contesto predefinito usa tutto lo storico e aggrega tutte le code, scegliendo automaticamente il ruolo più osservato. Il periodo può essere impostato a un numero di giorni o di partite per account; `0` usa tutto lo storico. Una selezione esplicita resta invariata anche senza dati. Ogni sezione mostra fino a sei elementi e il piano propone tre prove da una partita per default. Dettagli: [RECOMMENDATIONS.md](RECOMMENDATIONS.md) e [METODOLOGIA_STATISTICA.md](METODOLOGIA_STATISTICA.md).

Matchup, sinergie, blacklist, compagni e playstyle restano analisi outcome separate. Playstyle v3 usa tassi grezzi e intervalli binomiali esatti senza prior: una baseline mancante resta assente e la graduatoria non richiede 20 partite; il supporto sull’intera famiglia è una verifica separata. Quando le altre analisi usano posteriori, soglie o pesi di attribuzione, quei parametri non entrano nelle preferenze personali. Le colonne storiche e le annotazioni manuali rimangono disponibili per audit e provenienza.

### Impostazioni degli algoritmi

La pagina `/app/settings/algorithms` espone configurazione condivisa, anteprima senza salvataggio, revisione attiva e ripristino dei default. `GET /api/algorithm-settings`, `POST /api/algorithm-settings/preview` e `PUT /api/algorithm-settings` usano revisioni immutabili; il salvataggio richiede `expected_revision` e risponde `409` in caso di conflitto.

`/api/recommendations` restituisce profilo, scelte familiari, scoperte, piano di prova breve, performance separata e contesto effettivo. `/api/champions` espone la matrice di rendimento; `/api/training-plan` ricalcola la ripartizione competitiva per il budget richiesto (400 per default). `/api/recommendation-feedback` salva preferenze esplicite con controllo di revisione. `/api/exploration`, `/api/plan` e `/api/screen` conservano i rispettivi contratti legacy. Dettagli della configurazione: [ALGORITHM_SETTINGS.md](ALGORITHM_SETTINGS.md).

Il replay della nuova architettura si esegue con `python validate_preferences.py --db <copia.db> --output <report.json>`. Congela prefissi di 3, 5, 10 e 20 partite per account×ruolo×coda e confronta il champion successivo con frequenza grezza e ultimo champion. Il riutilizzo osservato è un proxy comportamentale: non certifica soddisfazione, qualità predittiva o beneficio causale. `validate_algorithm_settings.py` resta l’audit storico dei modelli outcome con prior e non giustifica il ranking delle preferenze.

La UI espone separatamente partite raw, eleggibili e analizzate. Lo stato per account+match è persistito, così code escluse e identità storiche non risolte non spariscono in un generico conteggio filtrato.

### Formato snapshot normalizzato

```powershell
python .\ingest.py .\snapshot.json
```

Il file può contenere `{ "source": "riot_api", "matches": [...] }`. Ogni match richiede `account`, `match_id`, `date`, `patch`, `queue`, `champion`, `role`, `duration_minutes` e `win`; gli altri campi sono opzionali. Ripetere l’import aggiorna i dati della stessa partita, preservando l’ID della riga e le annotazioni. Il risultato distingue `inserted`, `updated` e `skipped`.

I valori di peso, qualità, flag e motivazione forniti esplicitamente dallo snapshot sono conservati in `match_import_provenance`: un successivo reprocess Riot aggiorna i fatti della partita senza cancellare questi override. Omettere un campo mantiene l’override precedente; inviare esplicitamente `null` lo rimuove e consente i successivi calcoli automatici. La provenienza legacy incerta viene preservata. Un valore legacy identico al vecchio default Riot, con identica provenienza e senza altre informazioni, non può essere distinto da quel default.

Gli account Riot hanno un’identità interna persistente legata al PUUID. I cambi di nome riconciliati mantengono lo storico e i filtri salvati; i nomi storici verificati sono esposti come `aliases` da `/api/accounts`. Un nome ambiguo non unisce proprietari diversi e una selezione browser irrisolta non si allarga automaticamente a tutti gli account.

Le associazioni storiche accettate manualmente sono registrate in `riot_identity_policy`: `assumed` indica un’assunzione, `verified` una conferma esplicita e `exception` un collegamento sospeso. Motivazioni e cambi di stato restano nella cronologia. Per gestire un’eccezione senza modificare direttamente SQLite:

```powershell
python .\manage_identities.py --db .\champion_fit.db list --account "Nome#TAG"
python .\manage_identities.py --db .\champion_fit.db show "PUUID"
python .\manage_identities.py --db .\champion_fit.db exclude "PUUID" --reason "Identità storica da correggere"
python .\manage_identities.py --db .\champion_fit.db restore "PUUID" --reason "Collegamento ricontrollato"
```

L’esclusione sospende le successive riconciliazioni del gruppo e conserva i dati esistenti. Non separa automaticamente partite storiche la cui attribuzione non è certa. `restore` recupera lo stato precedente, senza trasformare un’assunzione in una verifica.

### Sincronizzazione opzionale con Riot API

La procedura incrementale ordinaria, la prima importazione, la scelta del database, le precauzioni sulle identità e le verifiche sono descritte in [RIOT_SYNC_RUNBOOK.md](RIOT_SYNC_RUNBOOK.md). Per gli aggiornamenti normali usare `check_new_matches.py`; `riot_sync.py` è riservato alla prima importazione completa.

Chiavi e account sono configurazione locale: non inserirli nei commit o nei log persistenti. Le variabili mostrate qui sono segnaposto; valorizzarle solo nell'ambiente locale:

```powershell
$env:RIOT_API_KEYS = "<chiave configurata localmente>"
python .\check_new_matches.py --db .\champion_fit.db
```

Per la sola importazione iniziale di uno storico completo:

```powershell
python .\riot_sync.py --db .\champion_fit.db --account "<Riot ID configurato localmente>"
```

`.env.example` contiene solo nomi di variabili e valori dimostrativi. Le istruzioni dettagliate e i casi di errore sono nel runbook.

I payload già presenti possono essere verificati e rimaterializzati senza nuove chiamate Riot:

```powershell
python .\riot_sync.py --db .\champion_fit.db --reprocess-raw --dry-run
python .\riot_sync.py --db .\champion_fit.db --reprocess-raw
```

Il dry-run è in sola lettura e riporta la copertura; non conta le righe i cui campi saranno aggiornati. Il reprocess aggiorna le righe derivate, ripara proiezioni incomplete e preserva le annotazioni. Una cancellazione per identità assente richiede un roster completo e coerente. Raw, partecipanti, identità, provenienza e stato vengono confermati insieme; il reprocess completo usa un’unica transazione, mentre il full sync conferma un account per volta. Le liste conservano anche gli ID storici già acquisiti.

### Migrazione opzionale

```powershell
pip install "psycopg[binary]"
python .\migrate_postgres.py --sqlite .\champion_fit.db "postgresql://user:password@host/champion_fit"
```

La migrazione crea prima una snapshot SQLite coerente con l'API backup, quindi esegue una sola transazione PostgreSQL. Per default applica un merge: inserisce e aggiorna le righe della sorgente, conservando quelle presenti soltanto nel target. Il resoconto indica quante righe SQLite sono state sottoposte al merge.

Dopo che PostgreSQL è diventato il database operativo, gli script Riot continuano a usare SQLite come staging. Per trasferire soltanto le tabelle Riot, senza sovrascrivere impostazioni, feedback, annotazioni e gruppi gestiti dall'app PostgreSQL:

```powershell
python .\check_new_matches.py --db .\champion_fit.db
python .\migrate_postgres.py --scope riot --sqlite .\champion_fit.db "postgresql://user:password@host/champion_fit"
```

`--replace-target` ricostruisce tutte le tabelle gestite e rimuove i dati presenti soltanto in PostgreSQL. È riservato a bootstrap o disaster recovery, dopo un backup `pg_dump` verificato; non può essere combinato con `--scope riot`.

SQLite resta il default finché non viene eseguita esplicitamente la migrazione.

### Stack containerizzato

Al primo deployment, eseguire una volta il bootstrap completo da SQLite. Il servizio `migrate` appartiene al profilo Compose `bootstrap` e non viene avviato dai normali `up`:

```powershell
$env:POSTGRES_PASSWORD = "scegli-una-password-locale"
$env:CHAMPION_FIT_SQLITE_PATH = (Resolve-Path .\champion_fit.db).Path
docker compose -f .\docker-compose.production.yml --profile bootstrap run --rm --build migrate
```

Completato il bootstrap, avviare normalmente PostgreSQL e web. Per default la porta è pubblicata soltanto su loopback:

```powershell
docker compose -f .\docker-compose.production.yml up -d --build
```

Il database SQLite sorgente viene montato in sola lettura nel container di migrazione e non entra mai nell’immagine. L'app sarà disponibile su `http://127.0.0.1:8787`; negli avvii successivi `web` attende soltanto l'healthcheck PostgreSQL. Il bootstrap completo non viene quindi ripetuto e non può riportare indietro dati applicativi modificati direttamente in PostgreSQL. Ripeterlo è un'operazione esplicita: prima creare e verificare un backup PostgreSQL. Gli aggiornamenti Riot successivi usano il comando `--scope riot` descritto sopra.

Lo stack PostgreSQL di test usa il progetto Compose dedicato `champion-fit-postgres-test` e il volume `champion_fit_pgdata_test`; non condivide servizio o volume con la produzione, che conserva `champion_fit_pgdata`. PostgreSQL e web vengono riavviati dopo un arresto inatteso; durante il bootstrap esplicito la migrazione attende l'healthcheck del database e ritenta solo in caso di errore.

L'app non implementa credenziali proprie. Il Compose di produzione usa `CHAMPION_FIT_BIND_ADDRESS`, con default `127.0.0.1`, quindi non espone la porta alla rete locale o a Internet. Per accesso remoto mantenere il bind su loopback e pubblicare il servizio tramite un reverse proxy sullo stesso host con TLS e autenticazione. In alternativa impostare `CHAMPION_FIT_BIND_ADDRESS` sull'indirizzo di un'interfaccia VPN privata e limitare la porta con il firewall; non usare un indirizzo pubblico senza un livello di autenticazione esterno.

### Backup e ripristino PostgreSQL

Prima di una migrazione sostitutiva o di un aggiornamento, creare un dump in formato custom fuori dal volume Docker:

```powershell
New-Item -ItemType Directory -Force .\backups | Out-Null
docker compose -f .\docker-compose.production.yml exec -T postgres pg_dump -U champion_fit -d champion_fit -Fc -f /tmp/champion_fit.dump
docker compose -f .\docker-compose.production.yml cp postgres:/tmp/champion_fit.dump .\backups\champion_fit.dump
docker compose -f .\docker-compose.production.yml exec -T postgres rm -f /tmp/champion_fit.dump
```

Verificare che il file esista e non sia vuoto. Per ripristinarlo, fermare il web, ricreare il database e usare `pg_restore`:

```powershell
docker compose -f .\docker-compose.production.yml stop web
docker compose -f .\docker-compose.production.yml cp .\backups\champion_fit.dump postgres:/tmp/champion_fit.dump
docker compose -f .\docker-compose.production.yml exec -T postgres pg_restore -U champion_fit -d champion_fit --clean --if-exists --no-owner /tmp/champion_fit.dump
docker compose -f .\docker-compose.production.yml exec -T postgres rm -f /tmp/champion_fit.dump
docker compose -f .\docker-compose.production.yml start web
```

Eseguire periodicamente una prova di ripristino su un database separato: la sola presenza del file non dimostra che il backup sia utilizzabile.

Per avviare direttamente il server sul PostgreSQL migrato:

```powershell
$env:CHAMPION_FIT_DATABASE_URL = "postgresql://champion_fit:champion_fit_local@127.0.0.1:55432/champion_fit"
python .\app.py --source C:\percorso\qualunque
```

Per un test locale del backend server:

```powershell
docker compose -f .\docker-compose.postgres.yml up -d
python .\migrate_postgres.py --sqlite .\champion_fit.db "postgresql://champion_fit:champion_fit_local@localhost:55432/champion_fit"
```

Il test d'integrazione PostgreSQL reale è opt-in e usa uno schema temporaneo isolato:

```powershell
$env:CHAMPION_FIT_TEST_POSTGRES_DSN = "postgresql://champion_fit:champion_fit_local@127.0.0.1:55432/champion_fit"
python -m pytest -q .\test_migrate_postgres.py
```

## Verifica

La suite browser crea una SQLite temporanea sintetica, serve la build tramite Python sulla porta `18787` e non apre né modifica `champion_fit.db`:

```powershell
python -m pytest -q
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend run test:unit
npm --prefix frontend run build
npm --prefix frontend run test:e2e
docker build -t champion-fit:local .
```

## Pubblicazione open source

Il repository include il codice, lo schema e i test, ma esclude database SQLite, snapshot personali, output generati e configurazione locale tramite `.gitignore` e `.dockerignore`.

La licenza prevista è MIT. Prima della pubblicazione sostituisci il titolare indicato come `[YOUR NAME OR ORGANIZATION]` nel file `LICENSE`.
