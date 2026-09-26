# Raccomandazioni basate sulle preferenze osservate

Le raccomandazioni personali di Champion Fit descrivono cosa il giocatore ha scelto e ripetuto nel contesto attivo. Il ranking non usa un prior Beta, non trasforma vittorie o sconfitte in preferenze e non assegna a un champion mai giocato una probabilità personale inventata.

## Contratto del motore

`preference_recommendations.build_recommendations` riceve:

- `rows`: partite nel periodo, ruolo e code correnti;
- `lifetime_rows`: storico disponibile fino all’istante della richiesta, usato solo per stabilire se un champion è già stato provato;
- `accounts` e `role`: perimetro esplicito;
- `feedback`: preferenze `like`, `dislike` o `neutral` registrate dall’utente;
- `limit` e `trial_budget`: limiti di presentazione e prova;
- il catalogo versionato dei champion;
- `include_performance`: separa il ranking di preferenza dal riepilogo degli esiti.

La risposta contiene cinque componenti concettualmente diverse:

- `known`: champion già osservati, ordinati dalla quota di utilizzo recente con uguale peso per account attivo; un `like` esplicito può ancorare un champion senza partite, dichiarandone la fonte;
- `discover`: champion mai giocati nello storico disponibile, compatibili col ruolo e ordinati per similarità Jaccard fra classi e stili del catalogo;
- `profile`: composizione descrittiva di classi e stili nelle scelte recenti;
- `trial_plan`: fino al budget configurato (tre prove da una partita ciascuna per default), prima per confermare una scelta familiare e poi per esplorare proposte nuove;
- `performance`: riepilogo separato degli esiti grezzi per i champion osservati. Non contribuisce all’ordine di `known` o `discover`.

Quando il ruolo è omesso o vale `ALL`, `known` e `discover` contengono voci distinte per coppia champion×ruolo; le statistiche e il feedback restano specifici per ruolo e il limite configurato continua ad applicarsi all’intera lista. Le richieste di dettaglio senza ruolo espongono le varianti disponibili in `candidates`; il campo singolo `candidate` resta associato alle richieste con ruolo concreto.

`known` e `discover` sono disgiunti. Un `dislike` esclude il champion dalle proposte, mentre `neutral` rimuove l’override. Il feedback è conservato separatamente dai match e usa una revisione ottimistica per evitare sovrascritture concorrenti. Un’identità sospesa dalla policy non riceve né modifica feedback.

Per ciascun account, le scelte esplicitamente sgradite escono anche dalle sorgenti e dai denominatori del profilo; rimangono nello storico e nei risultati. Quando sono presenti like classificabili, questi guidano l’affinità di quell’account al posto delle frequenze implicite, senza essere trasformati in partite. Nel gruppo un dislike esclude il candidato dalle proposte comuni. Un like su un champion osservato ma non classificato può promuoverlo fra le scelte familiari, senza generare etichette o somiglianze inventate. L’interfaccia permette di assegnare il giudizio a uno o più account espliciti.

La copertura distingue partite uniche (`games`), osservazioni account-partita complete (`observations`) e osservazioni della finestra delle preferenze (`preference_observations`). Sommare vittorie fra account che hanno partecipato alla stessa partita non aumenta il numero di partite uniche.

## Contesto e pochi dati

I default sono tutto lo storico (`period.value=0`), il contesto di code previsto dalle impostazioni, tutti i ruoli senza filtro, sei elementi complessivi per sezione e budget di prova tre. Un periodo positivo seleziona gli ultimi N giorni oppure le ultime N partite per account (`period.unit`). La coda automatica continua a usare la coppia coda×ruolo più osservata nel perimetro corrente; quando il ruolo è `ALL`, vengono considerate tutte le partite della coda scelta. `role=AUTO` conserva la selezione storica del ruolo più osservato per compatibilità. Una coda o un ruolo concreto espliciti restano invariati anche senza dati.

Con un solo account e tre partite il motore può già mostrare una lista familiare e una prova prudente. Questo è utile per orientarsi, ma non certifica stabilità, gradimento o vantaggio competitivo. Un account senza partite nel contesto rimane indicato come mancante e non riceve una quota neutrale fittizia. Champion sconosciuti al catalogo ma presenti nello storico restano scelte familiari; non ottengono tag inventati e non generano compatibilità di scoperta.

La similarità di `discover` è una relazione tassonomica, non una probabilità di gradimento. Un champion non proposto può semplicemente non avere tag condivisi sufficienti. Ownership, ban, autofill, patch, compagni e avversari non sono modellati come preferenze.

## Performance osservata, separata

`observed_performance.py` riporta win rate grezzo, baseline complementare disgiunta e intervalli binomiali esatti di Clopper–Pearson. Non usa prior né pseudopartite. Nel caso multi-account media soltanto gli account realmente esposti; un account senza partite del champion resta mancante. Il confronto esclude globalmente dal complemento tutti gli ID partita del candidato.

Il campo `supported` richiede intervalli simultanei separati di almeno il delta configurato nell’intera famiglia. Quando il ruolo è `ALL`, la famiglia comprende tutte le coppie champion×ruolo valutate prima del limite di visualizzazione, senza riavviare il budget di rischio per ogni ruolo. Serve a descrivere la forza dell’associazione storica fra scelta ed esito; non decide l’ordine delle preferenze e non dimostra che scegliere quel champion causi vittorie.

## Feedback

Il feedback esplicito è contestuale per account, champion e ruolo. `like` e `dislike` esprimono una preferenza dell’utente, non correggono il risultato di una partita. La lettura e la scrittura usano identità canoniche e preservano la cronologia tramite revisione. Il backend rifiuta una scrittura basata su una revisione obsoleta.

Un replay storico non applica il feedback attuale ai prefissi passati: farlo introdurrebbe informazione futura. Finché non esiste feedback datato disponibile a ogni istante, la validazione temporale usa `feedback=None`.

## Validazione temporale

`validate_preferences.py` apre SQLite in sola lettura e non legge i payload Riot raw. Raggruppa ogni account canonico separatamente per ruolo e coda concreta, deduplica account+match e usa il timestamp globale minimo del match. Non applica un limite arbitrario al numero di account o strati.

Per ogni strato valuta i prefissi iniziali di 3, 5, 10 e 20 partite e usa come target solo il match immediatamente successivo con timestamp strettamente posteriore. `rows` e `lifetime_rows` terminano entrambe al prefisso; la modalità pure-call disabilita `performance`. Il replay misura:

- hit@1 e hit@3 di `known` quando il champion successivo era già familiare;
- coverage@3 di `discover` quando il champion successivo non era mai stato visto;
- copertura e mancanza nell’output completo;
- stabilità Jaccard delle top 3 fra prefissi;
- baseline della frequenza grezza top 3 e dell’ultimo champion, calcolate soltanto sul train.

La scelta successiva è un proxy di riutilizzo, non un voto di soddisfazione. Il report non ottimizza pesi o soglie e non certifica qualità predittiva, gradimento, ranking controfattuale o beneficio causale.

```powershell
python validate_preferences.py --db .\champion_fit.db `
  --output .\outputs\preference-rebuild\validation.json
```

## Limiti

Le scelte osservate dipendono da disponibilità del champion, ban, ruolo assegnato, patch, sessione e obiettivi del giocatore. Le partite dello stesso account non sono indipendenti. La coverage di scoperta osserva solo champion che il giocatore ha poi scelto e non dice cosa sarebbe successo con le alternative ignorate. Gli intervalli sugli esiti descrivono il campione storico; non trasformano la raccomandazione in una previsione o in un effetto causale.
