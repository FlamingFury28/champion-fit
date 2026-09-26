# Runbook: sincronizzare i dati Riot

Procedura per le IA che aggiornano lo storico locale di Champion Fit. Vale per gli script e lo schema presenti nel repository: prima di cambiare frequenza, endpoint o limiter, verificare le quote correnti nel [Riot Developer Portal](https://developer.riotgames.com/docs/portal).

`METODOLOGIA_STATISTICA.md` descrive i modelli e la valutazione delle analisi; non definisce la procedura d'importazione Riot. Questo runbook riguarda soltanto acquisizione, identità, persistenza e verifica delle partite.

## Scegliere il flusso

| Situazione | Procedura | Effetto |
| --- | --- | --- |
| Aggiornamento ordinario di account già presenti nel database giusto | `check_new_matches.py` | Scorre gli ID Match-V5 più recenti fino a trovare un ID salvato, riusa i dettagli raw validi e materializza quelli nuovi o rimasti incompleti. |
| Prima importazione completa di uno storico/account | `riot_sync.py` | Importa la cronologia disponibile per gli account indicati; richiede una chiave Riot. |
| Ricalcolo da payload Riot già salvati localmente | `riot_sync.py --reprocess-raw` | Rielabora i dati locali senza chiamate Riot. `--dry-run` esegue soltanto l'audit in sola lettura. |

Non usare la prima importazione completa come aggiornamento periodico: per gli account già importati partire da `check_new_matches.py`.

## Verificare account e database prima di partire

### Account

Il Riot ID deve essere quello corrente nel formato `Nome#TAG`; gli script risolvono l'identità con Riot Account-V1. Non indovinare proprietari a partire da nomi simili.

Per `check_new_matches.py`, l'ambito è scelto in quest'ordine: `--account` ripetuto, `RIOT_ACCOUNTS`, quindi account già registrati nel database. Se l'ambito non è esplicito, verificare che la variabile d'ambiente o l'elenco ricavato dal database contengano solo gli account desiderati. `riot_sync.py` usa `--account` ripetuto oppure `RIOT_ACCOUNTS`; non deduce gli account dal database.

Gli account possono essere separati con virgole o punto e virgola in `RIOT_ACCOUNTS`. Non copiare Riot ID reali o PUUID nel runbook, in file versionati, issue o log persistenti. I riepiloghi CLI identificano gli account: leggerli nel terminale locale e redigere gli identificativi prima di salvarli o condividerli.

### Database

Entrambi gli script usano SQLite. Senza `--db`, il percorso predefinito è `champion_fit.db` accanto ad `app.py`. Passare `--db` con il percorso del file SQLite effettivamente usato dall'app, non con una cartella o con il file `schema.sql`.

Prima di un aggiornamento incrementale controllare che il file esista e contenga già l'account e la cronologia attesi. `check_new_matches.py` può inizializzare un database vuoto se riceve un account esplicito: un percorso errato può quindi creare un nuovo file senza storico, invece di aggiornare quello mostrato dall'app.

Il backend usa SQLite per impostazione predefinita. Se `CHAMPION_FIT_DATABASE_URL` configura PostgreSQL, i due script Riot non scrivono direttamente in PostgreSQL: il loro `--db` resta un file SQLite di staging. Dopo la verifica dell'import, trasferire soltanto l'ambito Riot con `migrate_postgres.py --scope riot`; il merge aggiorna le righe corrispondenti e conserva i dati presenti soltanto nel target. Non usare la migrazione completa per gli aggiornamenti ordinari, perché impostazioni, feedback, annotazioni e gruppi appartengono ormai all'app PostgreSQL.

Flusso operativo quando l'app serve PostgreSQL:

```powershell
python .\check_new_matches.py --db .\champion_fit.db
python .\migrate_postgres.py --scope riot --sqlite .\champion_fit.db $env:CHAMPION_FIT_DATABASE_URL
```

La migrazione legge una snapshot SQLite coerente e conferma il merge PostgreSQL in una sola transazione. Se il comando fallisce, l'app continua a mostrare lo stato PostgreSQL precedente. Completato il merge, ricaricare completamente il browser prima della verifica. `--replace-target` non fa parte del flusso Riot: ricostruisce tutte le tabelle e richiede un backup verificato secondo il README. Anche il servizio Compose `migrate`, confinato al profilo `bootstrap`, è riservato alla prima migrazione completa e non va attivato per una sincronizzazione incrementale.

### Chiavi

La chiave non va passata in argomenti CLI, inserita nel codice, nel Markdown o in un file committato. Renderla disponibile allo script soltanto tramite variabili d'ambiente nel contesto locale:

- `check_new_matches.py`: legge `RIOT_API_KEYS`.
- `riot_sync.py`: legge `RIOT_API_KEY` oppure `RIOT_API_KEYS`.

Il formato `.env.example` è solo un modello e gli script non caricano automaticamente i valori di un file `.env`. Evitare transcript del terminale e redirect non protetti: gli output possono contenere Riot ID, PUUID o ID partita. Non conservare chiavi o identificativi reali in log permanenti.

## Aggiornamento incrementale ordinario

Usare una shell locale in cui `RIOT_API_KEYS` e, se serve, `RIOT_ACCOUNTS` siano già configurate. Esempio senza inserire account nel comando:

```powershell
python .\check_new_matches.py --db .\champion_fit.db
```

Per limitare esplicitamente l'ambito, aggiungere `--account` una volta per ogni Riot ID autorizzato, senza lasciare che un account di configurazione diverso allarghi l'elenco:

```powershell
python .\check_new_matches.py --db .\champion_fit.db --account "<Riot ID configurato localmente>"
```

Lo script interroga gli ID più recenti a pagine da 100 e si ferma alla prima pagina che contiene un ID presente nella cronologia salvata per il PUUID o il suo gruppo d'identità già stabilito. Per ogni ID, riusa il payload `riot_match_raw` valido già nel database; richiede il dettaglio Riot solo quando manca o non è valido. Ritenta inoltre la materializzazione dei raw già presenti che non avevano prodotto una riga analitica.

Non avviare due sincronizzazioni concorrenti sullo stesso database. Lo script applica un intervallo per chiave e il client Riot gestisce i retry; richieste manuali sovrapposte aggiungono carico e rendono più difficile capire l'esito.

## Prima importazione e rielaborazione locale

La prima importazione completa è l'unico caso ordinario per `riot_sync.py`:

```powershell
python .\riot_sync.py --db .\champion_fit.db --account "<Riot ID configurato localmente>"
```

Ripetere `--account` per più account. In alternativa configurare `RIOT_ACCOUNTS` e omettere l'opzione. La procedura richiede `RIOT_API_KEY` o `RIOT_API_KEYS` nell'ambiente locale.

Per rielaborare solo dati locali non serve una chiave e non vengono eseguite chiamate API:

```powershell
python .\riot_sync.py --db .\champion_fit.db --reprocess-raw --dry-run
python .\riot_sync.py --db .\champion_fit.db --reprocess-raw
```

`--dry-run` è valido soltanto insieme a `--reprocess-raw`. Il dry-run non scrive; la rielaborazione effettiva aggiorna le proiezioni derivate e conserva le annotazioni secondo il codice corrente. `--account` non limita il reprocess dei raw.

## Casi da fermare e risolvere

### Account non risolto

Un `404` di Account-V1 viene riportato nell'elenco `unresolved`. `check_new_matches.py` prova una risoluzione per PUUID solo quando il database contiene esattamente un PUUID salvato per quel Riot ID; uno zero, più PUUID o un altro `404` non costituiscono una conferma d'identità. Verificare privatamente Riot ID, TAG, ambito e database, poi riprovare solo dopo aver corretto la configurazione. Non assegnare un PUUID a mano per far sparire l'errore.

### Conflitto d'identità

Un conflitto compare in `identity_conflicts` con una motivazione. Fermare le ulteriori importazioni per quell'identità. Non cancellare righe, spostare partite, unire o separare PUUID per somiglianza del nome. Conservare lo storico e chiedere una verifica basata su evidenza Account-V1/proprietà esplicita prima di qualsiasi correzione; gli strumenti di gestione identità non sostituiscono tale evidenza.

### Nessuna cronologia sovrapposta

La ricerca incrementale è efficiente quando l'account ha già ID salvati nel database selezionato e Riot restituisce una pagina che li raggiunge. Se manca lo storico locale, non usare il percorso incrementale: correggere `--db` oppure effettuare la prima importazione completa con `riot_sync.py`.

Se lo storico esiste ma non si raggiunge alcun ID salvato, Match-V5 può far scorrere tutte le pagine disponibili; ciò può costare molte richieste di elenco e il passaggio successivo può richiedere dettagli per molti match non presenti nei raw. L'output attuale non dichiara un campo `overlap_found` né elenca gli ID singolarmente. Un numero di `new_ids` inatteso, soprattutto vicino a `recent_ids`, è quindi un segnale per fermarsi e controllare database, Riot ID e PUUID prima di un'altra esecuzione. Non ripetere il comando per “vedere se si sistema” e non associare identità ambigue. Una seconda esecuzione va fatta solo dopo aver ripristinato la destinazione corretta o verificato la cronologia.

### Risposta `429`

Lasciare che il client rispetti `Retry-After`. Il codice attuale serializza le richieste di `check_new_matches.py` per chiave con un intervallo di 1,22 secondi e il client comune attende almeno il valore `Retry-After` (minimo 30 secondi) prima dei retry, fino al limite implementato. Questi valori descrivono il limiter del repository e non sostituiscono le quote Riot: i limiti possono dipendere dalla chiave, dalla regione e dal metodo/servizio. Riot richiede di fermare le chiamate per la durata indicata da `Retry-After`; prima di cambiare ritmo o retry consultare la sezione Rate Limiting del [Developer Portal](https://developer.riotgames.com/docs/portal).

Non rilanciare ripetutamente il comando mentre attende, non aumentare la concorrenza e non cambiare chiave per aggirare un limite. Se il client esaurisce i retry e riporta ancora `429`, interrompere la sincronizzazione, controllare il messaggio senza conservare identificativi reali nei log e rivedere la procedura soltanto dopo aver verificato la documentazione Riot aggiornata.

## Verificare che l'app mostri dati aggiornati

Leggere il JSON di `check_new_matches.py` per account. I conteggi rilevanti includono `recent_ids`, `new_ids`, `retried_raw`, `inserted`, `removed_stale` e gli elenchi `unresolved`/`identity_conflicts`; il riepilogo aggregato mostra anche quanti account sono stati controllati. `new_ids` è un conteggio, non l'elenco degli ID. Non trattare `fetched_at` come data dell'ultima partita: indica quando è stato acquisito il dato.

La data effettivamente importata è `MAX(match_quality.date)` per l'account e il perimetro selezionato. Per controllarla senza stampare il Riot ID, valorizzare `CF_SYNC_ACCOUNT` soltanto nella shell locale e usare lo stesso file passato a `--db`:

```powershell
$env:CF_SYNC_DB = (Resolve-Path .\champion_fit.db).Path
# CF_SYNC_ACCOUNT: valorizzare localmente, senza inserirlo in uno script versionato.
python -c "import os,sqlite3,pathlib; uri=pathlib.Path(os.environ['CF_SYNC_DB']).resolve().as_uri()+'?mode=ro'; c=sqlite3.connect(uri,uri=True); rows=c.execute('SELECT match_id,date FROM match_quality WHERE account=? ORDER BY date DESC,match_id DESC LIMIT 5',(os.environ['CF_SYNC_ACCOUNT'],)).fetchall(); print({'last_imported_date': rows[0][1] if rows else None, 'latest_imported_matches': rows})"
```

Confrontare gli ID recenti e il numero `new_ids` del riepilogo con le righe più recenti restituite dalla query. Un ID non ancora presente in `match_quality` non prova da solo un errore: la partita può essere fuori dalle code supportate, avere un payload invalido o restare in uno stato d'identità irrisolto. In tali casi esaminare gli stati di materializzazione nel database senza forzare l'identità.

Per un confronto puntuale degli ID, impostare localmente `CF_RECENT_IDS` al valore `recent_ids` del risultato per l'account e usare il Riot ID già configurato in `CF_SYNC_ACCOUNT`. La query legge la lista raw più recente e mostra quali di quei match ID hanno una riga `match_quality`; l'output va trattato come dato personale locale e non salvato nei log:

```powershell
# CF_RECENT_IDS: valorizzare localmente con il conteggio recent_ids del risultato.
python -c "import os,sqlite3,pathlib,json; uri=pathlib.Path(os.environ['CF_SYNC_DB']).resolve().as_uri()+'?mode=ro'; c=sqlite3.connect(uri,uri=True); account=os.environ['CF_SYNC_ACCOUNT']; row=c.execute('SELECT match_ids_json FROM riot_match_list_raw WHERE account=? ORDER BY fetched_at DESC LIMIT 1',(account,)).fetchone(); ids=(json.loads(row[0]) if row else [])[:int(os.environ['CF_RECENT_IDS'])]; materialized={r[0] for r in c.execute('SELECT match_id FROM match_quality WHERE account=?',(account,))}; print({'recent_ids':ids,'materialized_ids':sorted(set(ids)&materialized),'missing_ids':sorted(set(ids)-materialized)})"
```

Nell'app selezionare gli stessi account e filtri in **Dati usati** e controllare **Le mie partite**. La data visibile deve coincidere con il massimo della data importata nel medesimo perimetro; account non selezionati o filtri di periodo/coda possono mostrare una data precedente. Ricaricare completamente l'app dopo la sincronizzazione per svuotare eventuali risultati mantenuti nel browser. Se SQL e interfaccia non coincidono, verificare prima che entrambi puntino allo stesso database e usino lo stesso perimetro.

Una seconda sincronizzazione senza nuove partite dovrebbe riportare `new_ids: 0` e non duplicare righe. Se compaiono di nuovo molti ID, conflitti o account irrisolti, fermarsi e diagnosticare prima di altre chiamate.
