# Quale stile funziona per questi account?

Pagina `/app/playstyles`, endpoint `GET /api/playstyles` e `GET /api/playstyle-evidence`.
L'analisi usa lo storico locale e non acquisisce timeline. I risultati sono associazioni
descrittive, non previsioni validate o effetti causali.

## Perimetro e classificazione

Gli endpoint accettano gli stessi `account`, `companion_account` e `companion_mode`
delle pagine esistenti. Aggiungono `role`, `queue`, `days` (`90`, `180`, `365`, `all`),
`category`. Un ruolo omesso o vuoto aggrega tutti i ruoli. Una scelta esplicita senza
partite mantiene un perimetro vuoto. Le code numeriche e i vecchi nomi sono
canonicalizzati.
Le partite di supporto accettano inoltre `page` e `page_size` (massimo 100).

`champion_archetypes.json` è un catalogo versionato: classi Data Dragon 16.13.1 e
otto etichette curate a partire dai kit. Ogni criterio e riferimento è consultabile
nella pagina. Ruoli compatibili e tag sono descrizioni curate, non una stima del meta.
Gli stili sono non esclusivi. Per «Protezione degli alleati» serve uno strumento
rilevante e ricorrente di mitigazione, salvataggio, anti-ingaggio o disimpegno:
uno scudo accessorio isolato o il solo controllo generico da ingaggio/pick non basta.
La revisione 1.2.0 applica una soglia di significatività anche agli altri sette stili:
apertura con accesso e controllo, pressione prima dello scontro, danno esplosivo o
ripetuto strutturale, minaccia persistente sullo spazio, duello ripetibile e pressione
laterale autosufficiente. Ogni tag ha una motivazione nel campo `tag_reasons`;
forme ed evoluzioni necessarie sono esplicite. Il dettaglio «Perché…» mostra la
motivazione pertinente per ciascun campione osservato. Il registro delle decisioni,
dei delta e dei casi al confine è in `ARCHETYPE_AUDIT.md`.
`champion_taxonomy.py` risolve ID e alias. Gli sconosciuti sono dichiarati non classificati
ed esclusi sia dai candidati sia dalle baseline: una classificazione assente non prova
che il campione sia privo di un'etichetta. Una partita condivisa è completamente
classificata quando tutti i campioni degli account selezionati sono classificati.

## Stime e suggerimenti

Ogni osservazione è deduplicata per account e partita e contribuisce interamente a ogni
etichetta pertinente. La baseline di un'etichetta esclude globalmente tutti i suoi ID
partita, anche negli altri account. Non si sommano i conteggi dei tag.
Playstyle v3 usa soltanto tassi grezzi e intervalli binomiali esatti di Clopper–Pearson:
non applica Beta(4,4), pseudopartite o un minimo di 20 partite alla graduatoria. Gli
account realmente esposti hanno peso uguale; un account o una baseline senza dati resta
`null`. La graduatoria considera supporto, lift osservato, numerosità e ID stabile.

Il badge di supporto è più severo della graduatoria: richiede copertura completa,
esposizione e baseline per ogni account necessario, almeno il delta configurato e
intervalli simultanei sull'intera famiglia di 14 categorie. Usa `family_alpha=0,05`
indipendentemente dalla confidenza descrittiva mostrata. Le partite entro un account
restano osservazioni dipendenti da patch, tempo e avversari; il controllo familiare non
elimina queste dipendenze.

Il controllo di sensibilità elimina globalmente le partite del campione più giocato
del candidato e mantiene popolazione e soglia. Una perdita di supporto indica dipendenza
dal campione dominante. È un controllo di robustezza, non un secondo segnale da promuovere.
Pesi di attribuzione delle sconfitte e annotazioni non cambiano le stime.

I campioni già giocati mostrano evidenze personali nel contesto. Quelli mai provati
sono verificati contro l'intero storico degli account selezionati, senza filtro periodo
o compagni. Richiedono ruolo compatibile e appartenenza all'archetipo; sono ordinati
per massima similarità Jaccard con i campioni osservati della categoria, poi nome e ID.
Se mancano campioni osservati si usano i riferimenti di catalogo come esplorazione.
Sono sempre ipotesi da provare e non ricevono una probabilità personale di vittoria.

## Comportamento osservato

Le metriche materializzate sono CS/min, vision score/min, (kill+assist)/kill squadra,
danni alle torri/min. Dati assenti o denominatori nulli restano mancanti. La partecipazione
è conservata come frazione e presentata in percentuale.
I percentili usano ranghi medi `(precedenti + uguali/2)/n` sui due esiti insieme in celle
account × campione × ruolo × coda × durata (`<20`, `20–30`, `30–40`, `≥40`), con almeno 10
valori validi per metrica. Le celle sparse mantengono solo le metriche grezze.
Mediana e IQR sono quantili della distribuzione empirica pesata: ogni account con entrambi
gli esiti ha lo stesso peso totale; le partite di quell'account/esito si dividono il peso.
Il set confrontabile è identico per vittorie e sconfitte; gli esclusi sono visibili.
Quando la massa cumulativa coincide con il quantile richiesto si fa la media dei
due valori consecutivi, come nella mediana ordinaria con numerosità pari.

## Backfill e manutenzione

Le tabelle `playstyle_metric_sources`, `playstyle_match_metrics` e
`playstyle_backfill_checkpoints` conservano versione dell'estrattore e SHA256 del payload.
Il resolver d'importazione prova la relazione account/partecipante; il caricamento delle
metriche ricontrolla le identità sospese. Le GET non leggono i JSON raw.
Import e ricalcolo aggiornano le metriche nella medesima transazione.

Prima prova su una copia nuova:

```powershell
python backfill_playstyle_metrics.py --db .backups/playstyles-copy.db --copy-from champion_fit.db --verify-preserved --report outputs/playstyles-copy.json
```

Poi attiva sul database operativo conservando il backup:

```powershell
python backfill_playstyle_metrics.py --db champion_fit.db --verify-preserved --report outputs/playstyles-live.json
```

Il comando riprende dal checkpoint. `--max-batches 1` permette una pausa controllata;
`--restart` ripassa tutto lo storico e rileva payload/versioni cambiati senza duplicare.
Con PostgreSQL usare `--database-url` al posto di `--db`. Le nuove tabelle sono incluse
nel percorso di migrazione, ma la verifica operativa di questa versione è su SQLite.
Dopo una build coordinata del frontend, riavviare il server ed eseguire un refresh completo.

Verifiche dedicate:

```powershell
python -m pytest test_champion_taxonomy.py test_playstyle_metrics.py test_playstyle_analysis.py test_playstyle_api.py
```

La validazione predittiva temporale resta un'estensione successiva.
