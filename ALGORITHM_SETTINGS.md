# Configurazione degli algoritmi

Champion Fit usa un solo documento di configurazione versionato per tutte le analisi correnti. Il preset raccomandato è `competitive_v1`. Il nome descrive il contratto documentato; l’identità eseguibile dello snapshot è la coppia `revision` più fingerprint SHA-256 restituita dall’API.

## Ciclo di vita dello snapshot

`algorithm_settings.py` valida sempre un documento completo. Non accetta chiavi ignote, numeri non finiti, array di lunghezza errata o relazioni incoerenti. Alla prima inizializzazione crea due revisioni immutabili:

- revisione 1: fotografia legacy, conservata per audit;
- revisione 2: `competitive_v1`, attiva e raccomandata.

Ogni salvataggio aggiunge una revisione e richiede `expected_revision`. Una revisione obsoleta restituisce conflitto invece di sovrascrivere una modifica concorrente. `get_settings_snapshot` restituisce:

- `revision` e `fingerprint` attivi;
- `settings`, il documento attivo;
- `defaults`, una copia del preset raccomandato;
- `schema`, metadati e limiti dell’editor;
- `history`, revisioni archiviate in ordine decrescente.

Il contesto di esecuzione è request-local e immutabile. Ogni risposta analitica riporta `algorithm_revision`, `algorithm_fingerprint` e il contesto normalizzato. Se il client invia una revisione non più attiva, la richiesta fallisce con conflitto e deve essere ricalcolata.

## Default `competitive_v1`

```json
{
  "evidence": {
    "prior_mean": 0.5,
    "prior_strength": 8,
    "credible_mass": 0.9,
    "meaningful_delta": 0.03,
    "family_alpha": 0.05,
    "min_games": 20,
    "display_min_games": 3,
    "indicative_games": 8,
    "recommendation_limit": 3
  },
  "context": {"queue": "420", "days": 180},
  "attribution": {
    "duration_bounds": [10, 15, 20, 23, 27],
    "loss_weights": [1, 1, 1, 1, 1, 1],
    "win_short_minutes": 20,
    "win_short_weight": 1,
    "win_long_weight": 1,
    "explicit_afk_weight": 0,
    "quasi_afk_multiplier": 1,
    "early_surrender_multiplier": 1,
    "team_collapse_multiplier": 1,
    "surrender_multiplier": 1,
    "kill_deficit_multiplier": 1,
    "contaminated_threshold": 0.45,
    "negative_veto": false
  },
  "matchup": {"recent_days": 90, "recent_weight": 0, "limit": 12},
  "friends": {"min_shared_games": 5},
  "playstyle": {
    "percentile_min_games": 10,
    "duration_bounds": [20, 30, 40],
    "suggestion_limit": 10
  },
  "training": {"budget": 20, "max_candidates": 3},
  "recommendations": {
    "limit": 6,
    "trial_budget": 3,
    "period": {"value": 0, "unit": "days"},
    "queue": "all",
    "confidence": 0.9
  }
}
```

La sezione `evidence` governa i modelli di outcome che conservano posteriori e soglie operative; non ordina più le raccomandazioni personali. Il prior Beta ha forme `alpha=4`, `beta=4`; delta di 3 punti, rischio familiare del 5% e minimo di 20 game sono decisioni normative e non sono stati ottimizzati sullo storico.

`display_min_games=3` permette di mostrare un risultato esplicitamente esplorativo. `indicative_games=8` governa il testo di affidabilità. Nessuno dei due riduce `min_games=20` per una decisione operativa.

## Preferenze osservate

La sezione `recommendations` governa il motore prior-free descritto in [RECOMMENDATIONS.md](RECOMMENDATIONS.md). `limit` limita separatamente scelte familiari e scoperte; `trial_budget` limita le prove proposte. `period.value=0` usa tutto lo storico; un valore positivo limita il contesto agli ultimi giorni o alle ultime partite per account, secondo `period.unit`. `queue="all"` aggrega tutte le code e `queue="auto"` sceglie la coppia coda×ruolo più osservata nel perimetro corrente. Una coda o un periodo espliciti non vengono sostituiti quando mancano dati.

`confidence` riguarda soltanto gli intervalli esatti della performance mostrata accanto a una scelta osservata. Non cambia l’ordine di `known` o `discover`. Il ranking usa frequenze osservate, feedback esplicito e similarità tassonomica; vittorie, sconfitte, posteriori Beta e pesi di attribuzione restano esclusi.

Playstyle v3 usa anch’esso esiti grezzi e intervalli binomiali esatti senza prior. `evidence.meaningful_delta` e `evidence.family_alpha` regolano il solo supporto simultaneo sull’intera famiglia; `credible_mass` controlla la confidenza descrittiva e non sostituisce `family_alpha`. `evidence.min_games=20` non filtra né ordina la graduatoria playstyle. Una baseline non osservata rimane `null`.

## Esiti e attribuzione

Il posterior, gli intervalli e i confronti usano soltanto vittorie e sconfitte grezze. I campi in `attribution` costruiscono una vista interpretativa per audit e spiegazioni; non diventano successi frazionari e non restringono gli intervalli di outcome.

Il preset corrente usa pesi unitari e `negative_veto=false`. Le annotazioni manuali, in particolare AFK esplicito, griefer e invincibile, conservano precedenza nel calcolo e nella spiegazione dell’attribuzione effettiva. L’esito binario archiviato non viene riscritto. I pesi importati storici restano nel database per provenienza e riproducibilità.

La revisione legacy conserva le vecchie fasce e moltiplicatori, il veto negativo, il correttivo recente dei matchup, il contesto multi-coda/lifetime e il budget 400. È una fotografia indivisibile: non va usata come flag parziale dentro una richiesta corrente.

## Confini delle API

- `GET /api/algorithm-settings` legge snapshot, default, schema e cronologia.
- `POST /api/algorithm-settings/preview` valida un documento senza salvarlo e confronta lo stesso perimetro prima/dopo. La sensibilità dell’attribuzione tiene fissi outcome e altri parametri.
- `PUT /api/algorithm-settings` salva una nuova revisione completa con controllo ottimistico.
- Gli endpoint analitici possono ricevere `algorithm_revision`; una revisione stantia produce conflitto.
- `/api/recommendations` restituisce `known`, `discover`, `profile`, `trial_plan` e la performance osservata separata, insieme al contesto effettivo e alla revisione del feedback.
- `GET /api/recommendation-feedback` espone il catalogo completo e il registro per account e ruolo, anche con zero partite. `POST /api/recommendation-feedback` registra `like`, `dislike` o `neutral` con controllo ottimistico della revisione, senza modificare match o outcome.
- `/api/champions` e `/api/training-plan` condividono il contesto di account, ruolo, modalità e periodo. La matrice distingue i risultati storicamente supportati dai segnali aggiustati positivi che restano incerti; entrambi includono intervalli e copertura.
- `/api/training-plan` usa per default 400 partite (intervallo 20–2.000) e simula la ripartizione che riduce il rimpianto atteso nella scelta finale. Include i segnali positivi ancora incerti e il miglior confronto storicamente supportato, quando disponibile. L’allocazione è intera e totalizza il budget quando ci sono candidati. Il piano breve di `/api/recommendations` ha uno scopo distinto.
- Il piano competitivo non è il vecchio piano statico di `/api/plan`. La routine `training_plan` rimane disponibile per il riepilogo legacy orientato alla riduzione della varianza.
- Il modello `hierarchical_logit_laplace_v1` stima gli outcome binari grezzi con pooling parziale per account, campione×ruolo, ruolo, coda, patch e lobby. Esclude pesi di attribuzione e statistiche successive all’esito; gli effetti di lobby modellano la dipendenza fra osservazioni condivise e sono integrati fuori nelle previsioni. La stima aggiustata è standardizzata sulla miscela di contesti osservati per il ruolo e sugli account selezionati. Il supporto storico usa inoltre la verifica simultanea e le soglie operative configurate.
- La validazione temporale richiesta non ha promosso questo modello sullo storico locale. Perciò le due viste sono marcate **esplorative**, anche quando un segnale supera il criterio storico: non mostrano una previsione di vittoria convalidata né attribuiscono un effetto causale alla scelta del campione.
- `/api/exploration` restituisce ipotesi tassonomiche compatibili col ruolo e mai provate nello storico completo. Non è una classifica di probabilità personali.

Le analisi live di outcome mantengono una sola coda, tranne `/api/matchups` e `/api/friends`: Avversari e ban parte da tutte le modalità, tutto lo storico e tutti i ruoli e consente di restringere il contesto dai filtri della pagina; Compagni usa tutte le modalità, tutto lo storico e tutti i ruoli perché non espone filtri di coda o periodo. Questa regola non riguarda `/api/recommendations`, che aggrega per default le preferenze di tutte le code e mantiene varianti distinte per tutti i ruoli senza filtro. Un aggregato multi-coda può confondere effetti della modalità e del ruolo nelle analisi degli outcome; la UI espone il contesto e le decisioni relative restano bloccate quando il ruolo è misto. La finestra è calcolata rispetto a un `as_of` fissato dalla richiesta; un replay offline deve fornirlo esplicitamente.

## Evidenza storica per il prior dei modelli outcome

`validate_algorithm_settings.py` confronta forze 8, 12 e 20 mantenendo fissi coda 420, 180 giorni, media 0,5 e outcome grezzi. I fold di selezione sono marzo–agosto 2026; settembre è il fold finale. Tutte le osservazioni dello stesso `match_id` usano il timestamp globale minimo, rimangono nello stesso lato dello split e sono separate dal train con embargo di 24 ore.

Forza 20 migliora proper score match-level rispetto a forza 8, ma il vantaggio equal-account non è conclusivo e il modello champion-specific non supera stabilmente il benchmark costante 0,5. Il replay non convalida forza 8 né una previsione di gradimento: documenta soltanto l’assenza di evidenza sufficiente per promuovere il prior nei modelli outcome che ancora lo usano. Forza 20 è il limite superiore della griglia esaminata, non un optimum globale. Non sono state aperte nuove prove a 40/80 dopo il test finale.

La promozione di un prior richiede simultaneamente:

1. CI bootstrap appaiato sotto zero contro forza 8 per log-loss match-level;
2. conferma sull’estimand equal-account;
3. vantaggio contro `p=0,5` nei fold di selezione;
4. vantaggio contro `p=0,5` nel fold finale congelato.

Il validator usa seed `20260924`, 1.000 repliche per default e cluster `match_id`. Riporta osservazioni account-partita, match unici, account e celle separatamente. Non legge le tabelle JSON raw e apre SQLite con `mode=ro` più `query_only=ON`.

## Validazione della matrice competitiva

`validate_hierarchical_champion_model.py` usa split temporali mensili con partite condivise mantenute nello stesso split e embargo di 24 ore. Nel perimetro locale verificato (coda Ranked Solo/Duo, lookback di 180 giorni, fold di selezione marzo–agosto 2026 e fold finale settembre), confronta log-loss, Brier e calibrazione del modello gerarchico con il modello champion-specific Beta, il tasso per account e il riferimento 50%. La promozione richiede risultati migliori in ogni fold sia a peso uguale per match sia a peso uguale per account.

La verifica disponibile **non supera** questa regola contro tutti i riferimenti: stato `exploratory`, 7 fold, con gate di promozione falliti. Nel fold finale il campione contiene 343 osservazioni, 308 match unici e 23 account. I numeri dei “migliori pick” sono condizionati alle partite in cui il giocatore li ha effettivamente selezionati e non sono un confronto controfattuale; non autorizzano quindi una previsione di vittoria o una promessa di vantaggio competitivo.

Comando riproducibile (input SQLite aperto in sola lettura):

```powershell
python validate_hierarchical_champion_model.py --db champion_fit.db
```

Per scrivere il report JSON, aggiungere `--output <percorso.json>`. Ripetere la validazione dopo modifiche al modello o quando lo storico locale cambia in modo rilevante; fino al superamento dei gate, mantenere `MODEL_VALIDATED=False`.

Esecuzione senza artefatto:

```powershell
python validate_algorithm_settings.py --db champion_fit.db
```

Esecuzione che salva il report concordato:

```powershell
python validate_algorithm_settings.py --db snapshot.db --output outputs/algorithm_settings_validation.json
```

Le date possono essere rese esplicite con `--selection-start`, `--selection-end`, `--final-start` e `--final-end`. Il numero di bootstrap è limitato fra 1 e 10.000.

La nuova architettura delle preferenze ha un validator distinto, che non usa questo prior né ottimizza pesi dal replay:

```powershell
python validate_preferences.py --db champion_fit.db --output outputs/preference-rebuild/validation.json
```

Il validator congela prefissi di 3, 5, 10 e 20 partite per ogni account×ruolo×coda, disabilita la performance durante il pure-call e confronta il riutilizzo successivo con frequenza grezza e ultimo champion. Questo proxy non certifica soddisfazione, ranking controfattuale o beneficio causale.

## Interpretazione e limiti

Il modello descrive associazioni storiche nei campioni osservati. Sessioni, patch, MMR, compagni, avversari, abilità e scelta del champion creano dipendenze e confondimento. Il clustering per partita evita di contare una lobby condivisa come più partite indipendenti, ma non elimina le altre dipendenze.

La validazione della stima di vittoria riguarda solo i champion effettivamente giocati nel holdout. Non valida il ranking top-N dei champion non scelti, non identifica un effetto del cambiare champion e non garantisce calibrazione futura. Alias verificati vengono ricondotti all’identità canonica; identità in eccezione sono escluse. Smurf distinti non vengono inferiti dal nome.
