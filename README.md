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
- `storage.py`: confine di persistenza, con implementazioni SQLite e PostgreSQL selezionate dalla configurazione.
- `migrate_postgres.py`: migrazione opzionale SQLite → PostgreSQL; richiede `psycopg` solo quando viene eseguita.
- `frontend/`: applicazione React + TypeScript + Vite. `frontend/dist` è generata e non viene versionata.
- `champions.icon_url`: URL remoti Riot Data Dragon. Le icone non sono scaricate né archiviate localmente; il browser le richiede direttamente al CDN.

### Navigazione e lettura dei risultati

Il percorso principale è **Riepilogo**, **Campioni** e **Le mie partite**. Il riepilogo mette in primo piano le due analisi competitive: **Quali giochi meglio?** confronta il rendimento storico e **Piano da 400 partite** distribuisce un budget competitivo modificabile. In Campioni, **Altri strumenti** raccoglie **Avversari e alleati** e, come funzioni facoltative, **Familiari e preferiti**, i candidati affini e il breve **Piano di prove**. I collegamenti precedenti restano accessibili e aprono il gruppo aggiuntivo. Nel menu, **Compagni** e **Algoritmi** sono raccolti sotto **Strumenti**; la mappa del sito dà accesso a tutte le funzioni. Compagni riguarda le persone e i loro Riot ID.

La scheda di un campione si apre sopra la lista e ha un URL condivisibile. La chiusura conserva i filtri della lista; il ruolo della scheda è indipendente. I precedenti indirizzi delle pagine restano utilizzabili e portano all'area corrispondente con i parametri compatibili. **Dati usati**, in alto, permette di gestire account, profili salvati e filtro sui compagni. Questi filtri sono globali; quelli delle singole analisi restano locali.

Il Riepilogo mostra fino a tre campioni con stime e intervalli, insieme a un’anteprima del piano competitivo. Nel riquadro dei dati, i filtri **Ruolo**, **Modalità** e **Periodo** aggiornano entrambe le analisi e ricordano l’ultima selezione effettuata in questo browser. **Ripristina** torna ai valori predefiniti degli algoritmi. I filtri espliciti di un link hanno precedenza sulla selezione salvata; i collegamenti alle analisi conservano il contesto visualizzato. Una selezione senza risultati resta attiva finché non viene modificata. Lo stesso riquadro mostra data e ora locali dell’ultimo aggiornamento dell’intero archivio, indipendente dai filtri; se la data manca o non è verificabile, indica «non disponibile».

Nel riquadro del piano, **Partite del piano** permette di scegliere da 20 a 2000 partite. Invio o l’uscita dal campo applicano il numero e ricalcolano il piano; Esc annulla la modifica in corso. Il valore confermato resta nell’URL dopo il refresh e viene trasferito al piano completo, insieme al contesto selezionato. Il budget scelto viene ricordato e riusato in entrambe le direzioni tra Riepilogo e Piano competitivo; ruolo, modalità e periodo restano indipendenti tra le sezioni. Un link esplicito mantiene il proprio contesto e, se omette il budget, usa il default di 400 senza sostituire la preferenza salvata. Cambiare i filtri dal Riepilogo conserva invece il budget già visualizzato. Queste modifiche ricalcolano l’anteprima e lasciano intatti i piani già seguiti.

Risultati personali, indici storici e ipotesi teoriche sono distinti anche quando riguardano lo stesso campione. Riunire i contenuti non modifica soglie, calcoli o significato statistico delle raccomandazioni.

Le notifiche compaiono una alla volta, con il numero di messaggi in attesa. Ogni messaggio, inclusi gli errori, resta in coda fino alla sua presentazione e riceve l’intera durata prevista. I dettagli lunghi scorrono separatamente dal pulsante di chiusura; `F8` e `Tab` permettono di raggiungere la notifica, che si può chiudere con `Esc` quando ha il focus.

### Viste dei dati

Il menu **Visualizzazione**, in alto, raccoglie **Vista dati** e **Aspetto**. Vista dati sceglie la rappresentazione per tutte le pagine: elenco, schede, barre, mappa a punti o radar dei comportamenti. La preferenza viene ripristinata una sola volta all’avvio, condivisa in memoria e applicata subito anche durante la navigazione. Cambiare vista conserva risultati e filtri senza nuove richieste API. Le sezioni che non supportano la rappresentazione scelta usano barre, schede o elenco secondo le misure disponibili, senza modificare la preferenza globale. Il browser salva la scelta e la sincronizza fra le schede aperte.

Le mappe confrontano la quantità indicata sull’asse orizzontale con la misura sull’asse verticale. Le barre mostrano intervalli e riferimenti solo quando appartengono alla stessa misura. Le viste teoriche dei champion mai provati offrono schede e barre. Negli stili, il radar confronta le mediane dei percentili delle vittorie e delle sconfitte quando almeno tre metriche hanno dati validi in entrambi gli esiti; i dati mancanti restano esclusi.

### Algoritmo delle raccomandazioni

Le raccomandazioni personali descrivono **preferenze osservate**. Nel perimetro attivo, `known` ordina i champion già scelti per quota di utilizzo recente con uguale peso per account; `discover` propone champion mai provati usando ruolo e similarità Jaccard di classi e stili. Il ranking non usa vittorie, sconfitte, prior Beta o pesi di attribuzione.

Con un solo account e poche partite il risultato è già leggibile come profilo provvisorio. Non diventa però una previsione di gradimento: ownership, ban, autofill, patch e intenzione del giocatore influenzano la scelta. Un account senza osservazioni resta mancante e non riceve una preferenza neutrale inventata. `like`, `dislike` e `neutral` sono feedback espliciti, versionati separatamente dai match.

Il riepilogo `performance` è distinto dal ranking. Mostra esiti grezzi, baseline complementare disgiunta e intervalli binomiali esatti senza prior o pseudopartite. Serve a leggere lo storico competitivo, non a ordinare `known` o `discover` e non dimostra che scegliere un champion causi vittorie.

Il contesto predefinito usa tutto lo storico, aggrega tutte le code e include tutti i ruoli. `role=AUTO` conserva la selezione del ruolo più osservato per i link che la richiedono esplicitamente. Il periodo può essere impostato a un numero di giorni o di partite per account; `0` usa tutto lo storico. Una selezione esplicita resta invariata anche senza dati. Ogni sezione mostra fino a sei elementi e il piano propone tre prove da una partita per default. Dettagli: [RECOMMENDATIONS.md](RECOMMENDATIONS.md) e [METODOLOGIA_STATISTICA.md](METODOLOGIA_STATISTICA.md).

Matchup, sinergie, blacklist, compagni e playstyle restano analisi outcome separate. Playstyle v3 usa tassi grezzi e intervalli binomiali esatti senza prior: una baseline mancante resta assente e la graduatoria non richiede 20 partite; il supporto sull’intera famiglia è una verifica separata. Quando le altre analisi usano posteriori, soglie o pesi di attribuzione, quei parametri non entrano nelle preferenze personali. Le colonne storiche e le annotazioni manuali rimangono disponibili per audit e provenienza.

### Impostazioni degli algoritmi

La pagina `/app/settings/algorithms` espone configurazione condivisa, anteprima senza salvataggio, revisione attiva e ripristino dei default. `GET /api/algorithm-settings`, `POST /api/algorithm-settings/preview` e `PUT /api/algorithm-settings` usano revisioni immutabili; il salvataggio richiede `expected_revision` e risponde `409` in caso di conflitto.

Gli errori di aggiornamento conservano anche i valori ancora in digitazione e la revisione originaria della bozza. Anteprima e applicazione attendono il recupero del registro e la conferma dei campi incompleti, senza inviare al loro posto i valori precedenti. Le conferme delle preferenze riportano campione, ruolo e account della richiesta inviata, anche se nel frattempo la selezione cambia; dopo un conflitto il registro viene ricaricato prima di consentire un altro invio.

Il client verifica le risposte delle impostazioni prima di aggiornare cache, bozza o anteprima. Un documento incompleto con stato `200` conserva l’ultima configurazione valida e mostra un errore recuperabile. Il salvataggio deve confermare una revisione successiva a quella inviata; l’anteprima deve riferirsi alla base richiesta. Il recupero richiede un nuovo tentativo esplicito e conserva la bozza, compresi i valori ancora in digitazione. Lo storico parziale delle versioni precedenti resta leggibile.

`/api/recommendations` restituisce profilo, scelte familiari, scoperte, piano di prova breve, performance separata e contesto effettivo. `/api/champions` espone la matrice di rendimento; `/api/training-plan` ricalcola la ripartizione competitiva per il budget richiesto (400 per default). `/api/recommendation-feedback` salva preferenze esplicite con controllo di revisione. `/api/exploration`, `/api/plan` e `/api/screen` conservano i rispettivi contratti legacy. Dettagli della configurazione: [ALGORITHM_SETTINGS.md](ALGORITHM_SETTINGS.md).

Il replay della nuova architettura si esegue con `python validate_preferences.py --db <copia.db> --output <report.json>`. Congela prefissi di 3, 5, 10 e 20 partite per account×ruolo×coda e confronta il champion successivo con frequenza grezza e ultimo champion. Il riutilizzo osservato è un proxy comportamentale: non certifica soddisfazione, qualità predittiva o beneficio causale. `validate_algorithm_settings.py` resta l’audit storico dei modelli outcome con prior e non giustifica il ranking delle preferenze.

La UI espone separatamente partite raw, eleggibili e analizzate. Lo stato per account+match è persistito, così code escluse e identità storiche non risolte non spariscono in un generico conteggio filtrato.

Le bozze delle annotazioni richiedono conferma prima di uscire con Indietro, cambiare pagina o passare alla sezione Stile. Rifiutare conserva l’editor e i testi; durante il salvataggio l’uscita viene annullata e non riprende automaticamente all’arrivo della risposta. Anche chiusura e ricaricamento del browser sono protetti quando ci sono modifiche o una richiesta in corso.

Una risposta di salvataggio incompleta non conferma annotazioni, preferenze o gruppi dei compagni: il modulo resta aperto e conserva la bozza. Dopo un conflitto nelle annotazioni, una lettura con lo stesso token rifiutato consente soltanto di ricaricare; una versione diversa richiede il confronto esplicito prima della sostituzione. Il recupero non ripete automaticamente il POST. Le preferenze già presenti possono invece essere confermate senza aumento della revisione.

Anche nelle schede dei suggerimenti, attesa ed esito indicano gli account della richiesta inviata senza sovrascrivere una nuova selezione. Dopo un conflitto i tre giudizi attendono una revisione aggiornata dei suggerimenti; una lettura fallita o ancora obsoleta permette soltanto di ricaricare. Nei gruppi, gli errori di rinomina e rimozione sono visibili anche dentro il pannello aperto.

### Formato snapshot normalizzato

```powershell
python .\ingest.py .\snapshot.json
```

Il file può contenere `{ "source": "riot_api", "matches": [...] }`. Ogni match richiede `account`, `match_id`, `date`, `patch`, `queue`, `champion`, `role`, `duration_minutes` e `win`; gli altri campi sono opzionali. Ripetere l’import aggiorna i dati della stessa partita, preservando l’ID della riga e le annotazioni. Il risultato distingue `inserted`, `updated` e `skipped`.

Le righe con un carattere NUL (`\u0000`) o un surrogato Unicode isolato nei campi testuali importati vengono scartate senza sovrascrivere partite e annotazioni esistenti. Un testo malformato in `source` rifiuta l’intero snapshot prima di aprire il database. I caratteri Unicode validi, comprese emoji e sequenze combinate, restano invariati.

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

### Backup locale SQLite verificato

Prima di migrazioni o interventi sull’archivio, crea una copia coerente con il comando locale:

```powershell
New-Item -ItemType Directory -Force .\.backups | Out-Null
python .\backup_database.py backup --source .\champion_fit.db --output .\.backups\prima-della-migrazione.db
python .\backup_database.py verify --database .\.backups\prima-della-migrazione.db
```

Il backup apre la sorgente in sola lettura e usa l’API SQLite, includendo le modifiche confermate nel WAL anche quando l’app è aperta. Controlla l’integrità e i vincoli prima di rendere disponibile il file finale; una destinazione esistente non viene sovrascritta. La copia comprende anche annotazioni, preferenze, impostazioni e piani salvati. Non avvia importazioni né chiamate Riot. I file in `.backups/` restano esclusi dal repository.

`verify` controlla una copia esistente senza modificarla. Prima di usarla come archivio operativo, conserva il database corrente e prova la copia separatamente; il comando non effettua ripristini distruttivi. Per un database PostgreSQL usa la procedura dedicata sotto.

### Migrazione opzionale

```powershell
pip install "psycopg[binary]"
python .\migrate_postgres.py --sqlite .\champion_fit.db "postgresql://user:password@host/champion_fit"
```

La migrazione crea prima una snapshot SQLite coerente con l'API backup, quindi esegue una sola transazione PostgreSQL. Per default applica un merge: inserisce e aggiorna le righe della sorgente, conservando quelle presenti soltanto nel target. Il resoconto indica quante righe SQLite sono state sottoposte al merge.

Impostazioni e feedback sono archivi versionati indivisibili. Il merge completo li importa in una destinazione vuota oppure accetta una snapshot identica; un archivio sorgente realmente vuoto lascia intatto quello di destinazione, incluso il numero di revisione. Se le storie divergono, interrompe l’intera transazione prima di sovrascrivere revisioni, eventi o puntatori attivi. Anche una selezione parziale delle loro tabelle viene rifiutata. Una scrittura concorrente produce un conflitto immediato, da riprovare dopo la sua conclusione. Per trasferire le partite lasciando autorevoli le modifiche dell’app PostgreSQL, usare `--scope riot`.

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

La build frontend copia separatamente dipendenze e sorgenti di produzione: modificare test unitari, test browser o relativi strumenti non ricompila il bundle. Gli asset di `frontend/public` restano inclusi.

Le installazioni npm e pip usano due [cache persistenti BuildKit](https://docs.docker.com/build/cache/optimize/#use-cache-mounts), separate e condivise in modo esclusivo durante ciascuna installazione. Se cambiano i manifest, i pacchetti già scaricati restano riutilizzabili anche quando il layer di installazione deve essere ricostruito. Queste cache appartengono al builder locale e non entrano nell'immagine finale; un nuovo builder CI parte senza di esse.

Per verificare il riuso della compilazione frontend con tre build reali su una copia temporanea dei file correnti:

```powershell
python .\scripts\verify_docker_cache.py
```

Il controllo richiede Docker attivo e conserva log e resoconto JSON in `outputs/`. Dopo la build iniziale, una modifica ai soli test deve riusare la compilazione; una modifica al CSS di produzione deve ricompilare. Usa l'output `cacheonly`, senza esportare immagini o creare container, e conserva la cache Docker.

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

I test d'integrazione PostgreSQL reali sono opt-in e usano schemi temporanei isolati. Verificano migrazione, filtri delle date, letture e scritture delle API, conflitti di revisione e pulizia delle fixture senza modificare i dati esistenti:

```powershell
$env:CHAMPION_FIT_TEST_POSTGRES_DSN = "postgresql://champion_fit:champion_fit_local@127.0.0.1:55432/champion_fit"
python -m pytest -q .\test_migrate_postgres.py .\test_analysis_postgres.py .\test_postgres_api.py .\test_postgres_mutations.py .\test_e2e_postgres_fixture.py .\test_recommendation_evidence_dates.py .\test_friend_utc_dates.py .\test_account_utc_dates.py .\test_playstyle_utc_dates.py .\test_postgres_metadata_scope.py .\test_api_numeric_boundaries.py .\test_revision_numeric_boundaries.py .\test_postgres_group_id_width.py .\test_friend_group_wire_ids.py .\test_friend_group_names.py .\test_friend_group_name_migration.py .\test_friend_group_text_boundaries.py .\test_annotation_feedback_text_boundaries.py .\test_sync_run_dates.py .\test_migration_versioned_ledgers.py
```

Le regressioni sulle risposte concorrenti di impostazioni e preferenze, e sulla precisione delle finestre recenti, usano lo stesso database di test e schemi isolati:

```powershell
python -m pytest -q .\test_algorithm_settings_snapshots.py .\test_recommendation_feedback_snapshots.py .\test_recommendation_time_precision.py
```

Anche i test browser possono usare PostgreSQL. Il server genera una fixture sintetica in uno schema dedicato; la chiusura del server e il teardown di Playwright ne gestiscono la pulizia:

```powershell
$env:CHAMPION_FIT_E2E_POSTGRES_DSN = "postgresql://champion_fit:champion_fit_local@127.0.0.1:55432/champion_fit"
npm --prefix frontend run build
Push-Location frontend
npx playwright test e2e/navigation.spec.ts e2e/profile-companion.spec.ts e2e/preference-dates.spec.ts e2e/recent-performance-dates.spec.ts e2e/account-metadata.spec.ts e2e/responsive-menu-focus.spec.ts e2e/role-filter-links.spec.ts e2e/queue-filter-links.spec.ts e2e/period-filter-links.spec.ts e2e/role-transition-links.spec.ts e2e/automatic-transition-links.spec.ts e2e/synergy-period-links.spec.ts e2e/synergy-queue-links.spec.ts --grep '@smoke'
Pop-Location
```

La CI esegue tre gruppi di controlli, con un limite di 30 minuti per job: test Python su PostgreSQL 16; controlli frontend, suite browser completa su SQLite e verifica del container; flussi browser essenziali su PostgreSQL 16, incluso l'avanzamento del piano. I controlli browser sono divisi in job indipendenti per Chromium, Firefox e WebKit, senza condividere fixture mutabili. Ogni job PostgreSQL usa un servizio e schemi di test separati. I normali test browser continuano a usare SQLite quando `CHAMPION_FIT_E2E_POSTGRES_DSN` non è impostata.

Il workflow parte per le pull request, per i push su `main` e su avvio manuale da GitHub Actions. I push dei branch con una pull request aperta non generano una seconda esecuzione; un nuovo aggiornamento della stessa pull request interrompe il collaudo della revisione precedente. In caso di errore, gli artefatti browser SQLite e PostgreSQL vengono salvati separatamente per 14 giorni.

L’introspezione PostgreSQL segue il `search_path` della connessione, come le normali query. Le tabelle omonime in altri schemi non possono far saltare l’aggiornamento delle colonne legacy; i test verificano anche nomi qualificati e tabelle temporanee.

I riferimenti degli alias ai gruppi usano interi a 64 bit anche su PostgreSQL. L’avvio e la migrazione ampliano nella stessa transazione l’eventuale vecchia colonna a 32 bit, preservando righe e vincoli; i successivi avvii non ripetono la conversione. Il merge continua ad associare i gruppi per nome, mentre `--replace-target` conserva gli ID della sorgente.

Nomi dei gruppi e alias vengono confrontati con `casefold` Unicode sia nelle API sia nel merge: `Équipe` equivale a `éQUIPE`, e `Straße` a `STRASSE`. Il riuso conserva ID e grafia già presenti; una rinomina verso un altro gruppo equivalente restituisce `409`. Le ambiguità legacy vengono segnalate senza fondere automaticamente i gruppi. Le mutazioni concorrenti e la migrazione condividono lo stesso lock PostgreSQL.

I nomi e gli alias contenenti NUL vengono rifiutati con `400` prima della connessione su entrambi i database: un batch misto non salva nemmeno gli alias validi.

Lo stesso controllo copre i testi delle annotazioni e gli account delle preferenze, incluse le letture del registro. I normali testi Unicode restano validi.

Anche le sincronizzazioni recenti esposte da `/api/sync-status` vengono ordinate per istante UTC prima del limite. Il testo originale resta disponibile; le date legacy non valide rimangono in coda. Soltanto gli ID e le date vengono letti per l’ordinamento: i dettagli diagnostici sono caricati per i run selezionati.

Gli offset, gli ID dei gruppi e le revisioni ricevuti dalle API vengono controllati prima di passarli al database. Valori oltre l’intervallo SQL a 64 bit ricevono `400`; una revisione rappresentabile ma obsoleta conserva la risposta `409` con lo snapshot corrente. Le richieste rifiutate non modificano i dati.

Nelle risposte JSON, gli ID dei gruppi fino a `2^53−1` restano numeri; quelli superiori sono stringhe decimali. I client devono riusare l’ID ricevuto senza convertirlo in un numero JavaScript, per mantenere distinte anche le risorse con ID adiacenti.

## Verifica

### Un comando per i controlli locali

Con le dipendenze Python e frontend già installate, dalla radice del progetto:

```powershell
python .\scripts\verify_project.py
```

Il comando esegue test Python, lint frontend, controllo dei tipi dei test browser, test unitari frontend e build di produzione con controllo TypeScript. Si ferma al primo errore, conserva il relativo output e distingue controlli falliti da prerequisiti mancanti. Non installa pacchetti o browser automaticamente. La CI usa lo stesso comando per backend e frontend, mantenendo in aggiunta audit delle dipendenze, test browser su SQLite e PostgreSQL e verifica del container.

Per scegliere il livello di verifica:

```powershell
python .\scripts\verify_project.py --scope backend
python .\scripts\verify_project.py --scope frontend --smoke
python .\scripts\verify_project.py --e2e
python .\scripts\verify_project.py --dry-run
```

`--smoke` aggiunge i flussi browser essenziali; `--e2e` esegue l’intera suite Playwright. Entrambi avviano una fixture temporanea con un server nuovo, senza riutilizzare il database operativo, e richiedono i browser Playwright già installati. `--dry-run` mostra soltanto i comandi. I test PostgreSQL restano facoltativi tramite le variabili descritte sopra: senza un database di test configurato vengono saltati, non dichiarati verificati.

`pytest.ini` esclude dalla raccolta output, dati locali, backup e dipendenze generate: eventuali script sperimentali in quelle cartelle non vengono eseguiti come test. La suite frontend resta separata. Le verifiche delle modifiche all’interfaccia includono un refresh completo della pagina.

### Diagnostica del backend

Le partite recenti del profilo, della scheda campione e di `/api/matches`, e le prove di `/api/recommendation-evidence` e `/api/playstyle-evidence`, sono ordinate per istante UTC prima di applicare limite e paginazione. `date` conserva il testo originale; `date_utc` contiene l'istante normalizzato usato dal grafico e dalle date mostrate. Anche gli estremi temporali e i giorni della settimana del profilo sono calcolati in UTC. Nei compagni, prima e ultima partita, filtri temporali e ordinamento per data usano la stessa convenzione UTC.

In **Le mie partite**, campione, ruolo, modalità e periodo filtrano insieme statistiche e storico degli account selezionati. I filtri restano nell’URL anche dopo un refresh; **Azzera filtri** ripristina tutto lo storico. Le statistiche coprono tutte le osservazioni filtrate, il grafico fino a 20 recenti e **Carica altre partite** aggiunge 24 righe per volta. **Mostra** restringe soltanto l’elenco da annotare. `/api/matches` espone `total`, `limit`, `offset` e `next_offset` (null all’ultima pagina); `/api/profile` accetta anche `champion` e restituisce `champion_options` per l’intero contesto di ruolo, modalità e periodo.

Le modifiche ai quattro filtri di **Le mie partite** e a budget e contesto del **Piano competitivo** vengono ricordate separatamente in questo browser. Tornando alla sezione senza filtri nel link si ritrova l’ultima selezione; un link esplicito conserva invece il proprio contesto completo, senza ereditare valori mancanti dalle preferenze e senza sovrascriverle alla sola apertura. Se il browser blocca il salvataggio locale, i controlli continuano a funzionare tramite URL e mostrano la limitazione. La sincronizzazione Riot resta manuale: questi automatismi operano sui dati già importati e non avviano controlli periodici su API esterne.

Nel **Piano competitivo**, **Segui questo piano** salva le assegnazioni nel database e ricorda il piano nel browser; il link permette di recuperarlo anche altrove. Il riquadro compatto mostra completate e rimanenti, con il dettaglio per campione e account richiudibile. Cambiare filtri, budget o impostazioni ricalcola l’anteprima ma lascia invariato il piano seguito. **Smetti di seguire** disattiva il riquadro senza cancellare il piano salvato.

**Prossima partita** suggerisce il campione e ruolo con più partite ancora da completare nel piano seguito e, per quella coppia, l’account con più partite rimanenti. A parità usa l’ordine alfabetico, così l’ordine dei dati non cambia il consiglio. Il suggerimento e la sua breve motivazione si aggiornano insieme ai conteggi locali dopo un’importazione manuale, senza nuove richieste API; i filtri dell’anteprima non lo modificano. Un piano completato non propone altre partite. Durante l’aggiornamento o in presenza di errori o conteggi incompleti il consiglio è sospeso.

L’avanzamento legge soltanto l’archivio locale e si aggiorna alla riapertura della pagina e dopo un’importazione manuale rilevata dall’app. Contano le partite giocate dopo l’attivazione, della modalità e del contesto compagni scelti, per i campioni, ruoli e account assegnati. Reimportazioni, vecchie partite recuperate e partite oltre l’assegnazione non gonfiano il completamento. Le assegnazioni a due account nella stessa partita sono due osservazioni distinte, coerenti con il budget del piano. I cambi di nome verificati seguono l’identità interna; le identità sospese mostrano conteggi incompleti. Annotazioni e dati originali rimangono intatti. Le copie immutabili sono conservate in `training_plan_runs`, inclusa nella migrazione completa PostgreSQL ed esclusa dalla migrazione dei soli dati Riot.

I link di Compagni possono usare date ISO estese, compatte o settimanali nei parametri `games_from` e `last_game_from`. I calendari mostrano il giorno corrispondente nel formato `YYYY-MM-DD`, così il filtro attivo resta visibile e può essere modificato o rimosso. Il conteggio dal giorno scelto e il limite sull’ultima partita restano filtri distinti. Anche la data mostrata in tabella e nelle schede dei compagni usa UTC, come i calendari; la convenzione è indicata accanto ai filtri.

L’analisi degli stili e le sue prove applicano gli stessi estremi UTC: inizio del periodo a mezzanotte e limite superiore all’istante di riferimento. Le date non valide e le partite successive a tale istante sono escluse dal periodo analizzato, anche con tutto lo storico selezionato. Il controllo dei campioni già provati continua a usare lo storico completo.

`/api/accounts` mantiene i conteggi dello storico raw e gli alias esistenti. Prima e ultima partita derivano dagli istanti UTC validi, senza filtrare ruoli o date future; se nessuna data è convertibile, entrambi gli estremi sono `null`.

Le risposte API conservano i contratti esistenti. Gli errori transitori del database restituiscono JSON con stato `503`; gli errori interni restituiscono `500`, senza dettagli del database nel messaggio pubblico. `X-Request-ID` collega la risposta ai log JSON del server. I log riportano durata, conteggi e tempi di proiezione, esecuzione SQL, modello e allocatore, senza query, parametri, account o credenziali. `sql_ms` misura `execute`/`executemany`, non l'intera iterazione dei risultati; una chiamata batch conta come una chiamata SQL.

Anche i validator temporali calcolano il primo istante delle partite condivise e l’ordine dei replay in UTC, prima degli split. Il validator degli outcome rifiuta un match eleggibile con date sorgente invalide; quello delle preferenze esclude soltanto le righe invalide, conservando le altre osservazioni valide dello stesso match. Entrambi aprono SQLite in sola lettura.

Il modello e il piano competitivo usano cache locali limitate a otto risultati ciascuna: richieste simultanee identiche condividono un solo calcolo, ogni chiamante riceve una copia indipendente e i fallimenti non vengono memorizzati. Dati, contesto e configurazione determinano le chiavi. Le correzioni di direzione del supporto storico e delle parità possono modificare classificazioni e allocazioni; il modello resta esplorativo.

Per misurare il backend con dati sintetici temporanei, oppure con una copia coerente del database operativo aperto in sola lettura:

```powershell
python .\benchmark_backend.py --output .\outputs\backend-benchmark.json
python .\benchmark_backend.py --db .\champion_fit.db --output .\outputs\backend-benchmark-local.json
```

Il benchmark applica lo schema soltanto alla copia temporanea e riporta tempi a cache fredda/calda, percentili e contatori, senza identificativi degli account. Il confronto numerico dell'allocatore usa due candidati sintetici e un riferimento Beta-Binomiale esatto per budget piccoli:

```powershell
python .\validate_competitive_training_plan.py --output .\outputs\allocator-validation.json
```

Questo confronto misura stabilità fra seed e numeri di scenari; non convalida il modello sullo storico reale e non modifica i parametri delle simulazioni. I report del validator gerarchico includono anche convergenza, iterazioni e gradiente finale.

La suite browser crea una SQLite temporanea sintetica, serve la build tramite Python sulla porta `18787` e non apre né modifica `champion_fit.db`:

```powershell
python -m pytest -q
npm --prefix frontend run lint
npm --prefix frontend run typecheck
Push-Location frontend
npx tsc --noEmit --project tsconfig.e2e.json
Pop-Location
npm --prefix frontend run test:unit
npm --prefix frontend run build
npm --prefix frontend run test:e2e
docker build -t champion-fit:local .
```

## Pubblicazione open source

Il repository include il codice, lo schema e i test, ma esclude database SQLite, snapshot personali, output generati e configurazione locale tramite `.gitignore` e `.dockerignore`.

La licenza prevista è MIT. Prima della pubblicazione sostituisci il titolare indicato come `[YOUR NAME OR ORGANIZATION]` nel file `LICENSE`.
