# Metodologia statistica di Champion Fit

Questo documento è il riferimento per le IA che analizzano o modificano i modelli matematici e statistici dell’app. Descrive le convenzioni attuali e il metodo da seguire quando si propone una modifica. Le formule attuali sono una baseline da comprendere e verificare, non un vincolo a conservarle se un’analisi motivata dimostra che un’alternativa è migliore.

## Mappa dei modelli attuali

| Area | Quantità stimata e riferimento | Interpretazione e cautele |
| --- | --- | --- |
| Raccomandazioni champion | Preferenze osservate per account × ruolo; per default aggregano tutte le code e usano tutto lo storico. Nessun prior e nessun esito entra nel ranking. | La scelta ripetuta è un segnale comportamentale, non una misura di soddisfazione. Una posizione alta non è una previsione né un effetto causale. |
| Performance dei champion consigliati | Win rate grezzo e baseline complementare disgiunta, con intervalli binomiali esatti e uguale peso agli account realmente esposti. | È un pannello separato dal ranking. Non riempie account mancanti, non usa pseudopartite e non dimostra che il champion causi l’esito. |
| Matchup | Esiti contro ciascun avversario rispetto alle altre partite comparabili, escludendo dal riferimento tutte le partite del matchup. | Il punteggio di ban considera probabilità e grandezza dello svantaggio, frequenza d’incontro e un correttivo recente; non è una probabilità di vittoria. |
| Sinergie | Esiti con ciascun alleato rispetto alle altre partite del perimetro, senza riutilizzare nel riferimento le partite che contengono quell’alleato. | Le soglie si applicano all’intera famiglia di alleati prima dei filtri di visualizzazione. Un’associazione non dimostra che l’alleato causi il risultato. |
| Blacklist | Segnale negativo sugli esiti grezzi con controllo della famiglia. Nel preset corrente il veto basato sull’attribuzione è disattivato. | I pesi di attribuzione restano audit separato e non cambiano la probabilità dell’esito. Il veto storico resta consultabile nella revisione legacy. |
| Compagni | Risultati del compagno deduplicati per partita, confrontati con le altre partite del contesto scelto; la decisione considera entrambe le direzioni. | Il win rate mostrato è descrittivo; un vantaggio o svantaggio supportato richiede almeno 20 partite e il controllo della famiglia. Con tutti i ruoli i risultati restano descrittivi; la pagina permette di restringere ruolo e modalità. L’associazione non prova un effetto causale. |
| Esplorazione | Similarità Jaccard delle etichette, compatibilità di ruolo e assenza di partite nello storico completo di tutti gli account selezionati. | Ordina ipotesi da provare senza assegnare probabilità personali di vittoria. Il precedente scout 70% teorico/30% ruolo resta soltanto negli snapshot legacy. |
| Playstyle | Esiti grezzi per 14 categorie curate, confrontati con il complemento disgiunto; tassi e intervalli esatti di Clopper–Pearson, senza prior, con peso uguale agli account osservati. | La graduatoria non richiede 20 partite. Il supporto usa delta e `family_alpha=0,05` sull’intera famiglia con copertura completa; una baseline mancante resta `null`. Sono associazioni descrittive. |
| Comportamenti in partita | Mediane e intervalli interquartili di metriche grezze e percentili contestuali, con peso totale uguale per account e risultato. | I percentili si calcolano entro account × champion × ruolo × coda × fascia di durata, solo con almeno 10 valori per metrica. Il confronto è descrittivo e non corregge da solo selezione, dipendenze o confondimento. |

Le analisi personali usano il perimetro attivo di account e compagni. Avversari e ban aggrega per default tutte le code, tutto lo storico e tutti i ruoli; i filtri della pagina possono restringere quel perimetro. Compagni usa anch’esso tutte le code e tutto lo storico, aggregando tutti i ruoli; i selettori di ruolo e modalità restringono il confronto, mentre data e soglia visibile filtrano la classifica. I dati aggregati fra modalità o ruoli restano descrittivi; un contesto a ruolo e modalità singoli permette un confronto omogeneo. I fit globali importati e le ipotesi teoriche restano fonti distinte dai risultati personali ricalcolati. Le raccomandazioni usano per default tutte le code e tutto lo storico, scegliendo il ruolo più osservato; il periodo può limitare gli ultimi N giorni o le ultime N partite per account, con `0` come storico completo. Una richiesta esplicita mantiene invece il contesto richiesto anche quando è vuoto. Le altre analisi conservano i propri default, fra cui coda `420` e 180 giorni per i modelli di outcome.

Per le playstyle la finestra predefinita è 180 giorni. Una scelta esplicita non va sostituita silenziosamente con il default. Le metriche comportamentali correnti sono farm/minuto, visione/minuto, partecipazione alle eliminazioni e danni alle torri/minuto.

## Configurazione globale e forma corrente

`algorithm_settings.py` è il contratto unico dei parametri. Il preset raccomandato è denominato `competitive_v1`: la revisione 1 archivia la forma legacy e la revisione 2 iniziale attiva i default raccomandati. Ogni snapshot restituisce `revision`, fingerprint SHA-256, documento attivo, default, schema editor e cronologia. Il fingerprint identifica il contenuto; il numero di revisione ordina le modifiche. Una richiesta analitica conserva la stessa revisione e lo stesso fingerprint dall’inizio alla fine.

La forma corrente è identificata dalla revisione/fingerprint attivi e non va ricostruita da singoli valori. La revisione legacy è un artefatto separato di compatibilità: non è un flag da combinare parzialmente col preset corrente. I vecchi pesi restano archiviati insieme ai fatti importati per audit e riproducibilità; la proiezione analitica corrente calcola i pesi effettivi senza riscrivere lo storico.

Il preset corrente mantiene:

- raccomandazioni di preferenza senza prior, con sei elementi per sezione, tutto lo storico su tutte le code e budget di prova tre;
- per le analisi di outcome che ancora usano posteriori: prior `Beta(4,4)`, massa credibile 90%, delta pratico 3 punti, rischio familiare 5% e minimo operativo 20 game;
- coda `420` e finestra 180 giorni;
- pesi simmetrici unitari per gli esiti e `attribution.negative_veto=false`;
- nessun correttivo recente nel matchup (`recent_weight=0`);
- budget allenamento 20 e massimo tre candidati.

Le annotazioni manuali esplicite conservano precedenza nella classificazione e nell’audit della partita. Non possono però modificare retroattivamente l’esito binario usato dal posterior. I pesi di attribuzione descrivono contaminazione o responsabilità stimata; il modello di outcome continua a usare una vittoria o una sconfitta grezza.

`/api/recommendations` restituisce insieme profilo, scelte familiari, scoperte e un piano breve di prova; gli esiti osservati restano nel campo `performance` separato. Gli endpoint `/api/training-plan` e `/api/exploration` rimangono contratti distinti di compatibilità per le analisi precedenti.

## Contratti statistici condivisi

### Esiti, pesi e unità di analisi

- Vittorie e sconfitte grezze alimentano le stime di probabilità degli esiti. Pesi di attribuzione, annotazioni e flag di qualità descrivono quanto una partita contribuisce all’interpretazione dell’impatto; non sono conteggi di vittorie e non devono restringere artificialmente gli intervalli sugli esiti.
- Il motore delle preferenze non usa vittorie, sconfitte, probabilità posteriori o pesi di attribuzione per ordinare `known` e `discover`. La performance osservata viene calcolata e mostrata separatamente.
- Quando una decisione usa anche l’attribuzione, mantenerla come requisito separato e dichiararlo. Per esempio, un segnale negativo può richiedere sconfitte con evidenza negativa attribuita positiva.
- L’osservazione analitica può essere account-partita. Una partita condivisa tra account non diventa una nuova partita unica; conserva l’esito osservato per ciascun account e può avere esiti opposti dal loro punto di vista. Tenere distinti osservazioni account-partita e partite uniche usate per requisiti di numerosità.
- Deduplicare le osservazioni ripetute e rifiutare o risolvere esplicitamente i duplicati con esiti o attributi incompatibili. Non moltiplicare i tag o i membri della stessa partita per gonfiare il supporto.

### Stime, confronto e incertezza

- Nei modelli di outcome posteriori, con `w` vittorie e `l` sconfitte grezze, il modello usa `p | dati ~ Beta(4+w, 4+l)`, media `(4+w)/(8+w+l)` e quantili 5%/95% come intervallo credibile centrale al 90%. Il prior Beta(4,4) ha media 50% e forza 8 osservazioni equivalenti. Non appartiene al ranking delle preferenze.
- La performance allegata alle raccomandazioni è invece prior-free: tasso osservato, intervallo esatto di Clopper–Pearson e complemento globalmente disgiunto. Un account senza esposizione resta mancante; non riceve una stima neutrale.
- Ogni confronto usa campioni disgiunti. Tutti gli ID partita del candidato vanno esclusi dalla baseline, anche se la partita compare attraverso un altro account. Nei modelli prior-free una baseline empirica assente resta `null`; nei soli modelli posteriori legacy che dichiarano un riferimento neutrale, il 50% resta un riferimento esplicito e non un’osservazione.
- Nei modelli posteriori con baseline empirica `q`, il confronto a lift minimo `δ` valuta `P(p - q > δ)` e `P(q - p > δ)`. Il valore `δ=0,03` appartiene alle decisioni outcome configurate e non al ranking delle preferenze.
- Un campione o una cella account-candidato assente conserva lo stato di mancanza. Non eliminarlo in silenzio, colmarlo con il risultato di un altro account o cambiare l’insieme degli account fra candidati.
- Nei modelli posteriori multi-account la media è `K⁻¹ Σᵢ pᵢ` e i limiti usano quantili marginali e union bound. Nelle analisi prior-free entrano invece soltanto gli account realmente esposti, con tassi grezzi e intervalli binomiali simultanei dichiarati.
- Le probabilità multi-account così ottenute sono limiti inferiori, non stime puntuali complementari: non sostituire la probabilità nella direzione opposta con `1 - probabilità`. Un limite pari a zero significa che i dati non certificano una soglia, non che l’evento abbia probabilità zero.
- L’intervallo credibile al 90% è descrittivo; non sostituisce la soglia più severa usata per una decisione. Il controllo della famiglia è un limite sul rischio posteriore complessivo, non una garanzia frequentista FWER/FDR.

### Soglie e selezione dei candidati

- Le raccomandazioni di preferenza possono essere utili con pochi match perché descrivono le scelte osservate; non trasformano però 3, 5, 10 o 20 partite in una certificazione. Il budget di prova limita l’azione proposta, non è una soglia inferenziale. L’eventuale badge di performance usa il confronto binomiale esatto dell’intera famiglia ed è separato dall’ordine delle preferenze.
- Nelle playstyle v3 la graduatoria usa lift grezzo, supporto e numerosità senza prior e senza minimo 20. `supported` richiede esposizione, baseline e copertura completa della famiglia; usa `family_alpha=0,05` separatamente dalla confidenza descrittiva e il delta configurato. Una baseline assente resta `null`. La sensibilità senza il champion dominante conserva popolazione e regola di supporto.
- Il punteggio di matchup è una priorità d’uso: `|lift posteriore| × probabilità di svantaggio/vantaggio significativo × frequenza d’incontro × (1 - r + r × quota recente)`, con `r = matchup.recent_weight` (default 0). Non è una probabilità calibrata di vittoria. La quota recente usa conteggi grezzi nella finestra configurata (default 90 giorni), indipendenti dai pesi di attribuzione; l’inferenza dell’esito resta basata sui risultati grezzi.
- In Compagni la decisione è bidirezionale: il controllo usa la maggiore tra probabilità di vantaggio e di svantaggio oltre il delta pratico. Un contesto con più ruoli o una baseline mancante resta descrittivo. La famiglia include tutti i compagni osservati nel contesto prima dei filtri di ricerca e visualizzazione; il minimo decisionale di 20 partite resta un gate aggiuntivo, non restringe la famiglia.
- Applicare le correzioni alla famiglia completa. Filtri di ricerca, numero minimo visibile, ordinamento, paginazione e top-N cambiano la presentazione, non la famiglia inferenziale né le probabilità.
- Le soglie specifiche di un modello possono essere diverse; documentarne motivazione, unità, famiglia, effetto minimo e regola di numerosità accanto al modello. Per le playstyle attuali la famiglia è di 14 categorie e il controllo di sensibilità rimuove il champion più giocato mantenendo popolazione e soglia.
- Separare significatività/compatibilità posteriore, dimensione dell’effetto e utilità pratica. Non definire “affidabile” o “migliore” in base al solo rango, a una stima puntuale o a poche partite.

## Come proporre una modifica statistica

Prima di cambiare formule o soglie, scrivere nel lavoro una breve scheda con questi elementi:

1. **Decisione ed estimando:** quale scelta dell’utente deve migliorare, quale popolazione e periodo descrive il modello e quale quantità si vuole stimare.
2. **Campione:** esito, unità di analisi, criteri di inclusione, filtri, duplicati, missingness e possibili dipendenze. Dichiarare quali dati sono osservazioni e quali sono soltanto contesto.
3. **Confronto e modello:** baseline non sovrapposta, likelihood, prior, pesi, stima dell’effetto, incertezza, soglia pratica e correzione per confronti multipli. Spiegare cosa cambia rispetto al modello attuale.
4. **Assunzioni e limiti:** controllare indipendenza/cluster, stabilità nel tempo e differenze di account, patch, ruolo, coda, avversari e composizione. Se una dipendenza non è modellata, non presentare la soglia come se lo fosse.
5. **Piano di validazione:** includere casi simulati noti, dati piccoli e sbilanciati, celle mancanti, match condivisi, candidati sovrapposti e famiglia filtrata/ordinata. Verificare le probabilità con riferimenti numerici indipendenti o enumerazione quando possibile; usare simulazioni per controllare calibrazione e copertura, specificando che non provano causalità.
6. **Sensibilità e decisione:** confrontare vecchio e nuovo metodo sullo stesso campione; verificare l’effetto di finestre temporali, account dominante, patch e soglie ragionevoli. Riportare variazioni di stima, incertezza, decisioni e copertura, non solo il nuovo ranking.

Una modifica è pronta quando il suo obiettivo e le sue assunzioni sono comprensibili, i casi limite sono verificati, il comportamento con dati insufficienti è conservativo e le affermazioni dell’interfaccia corrispondono a ciò che il calcolo stima davvero. Un’associazione osservazionale va descritta come tale: per sostenere causalità serve un disegno identificativo adeguato, non solo più partite o una probabilità posteriore alta.

## Evidenza storica del modello outcome precedente

Il confronto temporale locale che accompagna `competitive_v1` fissa prima il contesto Ranked Solo/180 giorni e confronta forze del prior 8, 12 e 20. La selezione usa i mesi marzo–agosto 2026; settembre è un test finale successivo. Ogni `match_id` globale appartiene a un solo lato dello split, con embargo di 24 ore. Le loss sono calcolate sia mediando prima per partita sia dando uguale peso a ogni account; osservazioni account-partita e partite uniche restano conteggi distinti. Il bootstrap appaiato ricampiona cluster partita con seed `20260924`.

La forza 20 riduce log-loss e Brier rispetto a 8 quando si pesa ogni partita globale una volta, ma il vantaggio non è conclusivo sull’estimand equal-account e il posterior champion-specific non supera stabilmente il benchmark costante 0,5. Anche il test finale resta peggiore del nullo come stima puntuale. Questo risultato non convalida Beta(4,4) e non misura preferenza o gradimento; documenta soltanto perché la piccola griglia non ha giustificato una promozione del prior nei modelli outcome che lo conservano. La forza 20 era il limite superiore esaminato, non un optimum globale.

Un’eventuale modifica del prior nei soli modelli outcome richiede congiuntamente, sul protocollo congelato:

1. miglioramento appaiato della log-loss rispetto al default sia per partita globale sia equal-account;
2. miglioramento rispetto a `p=0,5` nella selezione temporale;
3. conferma rispetto a `p=0,5` nel fold finale non usato per scegliere;
4. nessuna reinterpretazione del ranking come effetto causale o risultato controfattuale.

`validate_algorithm_settings.py` rende questi controlli riproducibili senza avviare l’applicazione, migrare lo schema o leggere i JSON raw. Il report distingue esplicitamente stima di vittoria, ranking relativo e limiti osservazionali. I proper score riguardano solo i campioni effettivamente giocati: non validano il top-N di campioni non scelti.

`validate_preferences.py` valuta invece la nuova architettura senza usare outcome o feedback futuro nel ranking. Per ogni account e strato ruolo×coda congela prefissi di 3, 5, 10 e 20 partite e osserva il champion del match immediatamente successivo. Riporta hit@3 familiare, coverage di scoperta, missingness, stabilità e le baseline frequenza grezza/ultimo champion. Il riutilizzo successivo è solo un proxy comportamentale: il report non certifica previsione, soddisfazione o beneficio causale e non sceglie pesi dal test.

## Dati e chiamate API strettamente necessari

- Partire dai dati locali già acquisiti e verificare che contengano l’esito e le variabili necessari all’estimando. Un ricalcolo su dati raw già presenti non richiede una nuova chiamata Riot.
- Prima di chiedere nuove variabili, dimostrare perché servono alla domanda statistica. Acquisire soltanto le partite e i campi mancanti per il perimetro definito; non scaricare timeline o cronologie intere per aumentare genericamente il campione.
- Se la metrica non è disponibile localmente, distinguere esplicitamente una nuova raccolta dati da un cambiamento del modello. Non mescolare periodi, code o definizioni diverse senza dichiararlo e senza rifare il confronto in modo coerente.
- Le chiavi API restano segreti locali e non entrano in documenti, log o report. Prima di cambiare volume o frequenza, verificare il limite applicabile e rispettare il limiter corrente.

## Limiti da riportare

Le partite sono osservazionali e possono dipendere fra loro per sessione, patch, MMR, abilità, ruolo, squadra e selezione del champion. Il prior neutrale del 50% è un riferimento, non una legge sui risultati. Un intervallo stretto condizionato a una baseline stimata può non includere l’incertezza della baseline. La validazione storica non garantisce prestazioni future e una maggiore numerosità non elimina bias di selezione o confondimento.

Nei report usare sempre: popolazione/filtro, periodo e numerosità (sia osservazioni sia partite uniche quando differiscono), stima dell’effetto, intervallo, baseline, soglia, metodo di correzione, celle mancanti e limiti principali. Distinguere risultato descrittivo, ipotesi esplorativa e decisione operativa.

## Riferimenti nel progetto

- `README.md` e `RECOMMENDATIONS.md`: contratto sintetico e completo delle preferenze osservate, del feedback e della performance separata.
- `ALGORITHM_SETTINGS.md` e `algorithm_settings.py`: preset, revisioni, fingerprint, schema e confini degli endpoint configurabili.
- `preference_recommendations.py`, `recommendation_runtime.py` e `observed_performance.py`: ranking prior-free, contesto e performance binomiale separata.
- `statistical_evidence.py`, `stratified_evidence.py`, `decision_models.py`: posteriori Beta e confronti ancora usati dalle analisi outcome separate.
- `app.py`: perimetri statistici di raccomandazioni, matchup, sinergie, compagni e Scout.
- `playstyle_analysis.py` e `PLAYSTYLES.md`: modello e criteri dell’analisi playstyle.
- Test numerici e decisionali: `test_preference_recommendations.py`, `test_observed_performance.py`, `test_validate_preferences.py`, `test_statistical_evidence.py`, `test_statistical_decisions.py` e `test_playstyle_analysis.py`.

Se una modifica cambia uno di questi contratti, aggiornare insieme la guida, la documentazione visibile all’utente e le verifiche statistiche pertinenti.
