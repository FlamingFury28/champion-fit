# Revisione degli archetipi 1.2.0

Data della revisione: 2 ottobre 2026. Catalogo di partenza: 1.1.0.

Sono stati esaminati tutti i 173 campioni per ciascuno dei sette stili sotto. Le classi Riot, i ruoli e le 30 assegnazioni a Protezione degli alleati conservano il perimetro precedente; anche queste ultime hanno ora una motivazione leggibile.

La fonte è lo snapshot ufficiale [Data Dragon 16.13.1](https://ddragon.leagueoflegends.com/cdn/16.13.1/data/en_US/championFull.json), comprese le descrizioni e i tooltip. Gli stili sono decisioni del progetto, basate sul funzionamento del kit. I tag possono sovrapporsi e non dipendono da partite personali, risultati, frequenze del meta o build rare.

SHA-256 di championFull.json: `d8e7670f9c390c379241406602f58448fd5fb2398665de3f563663bd54278911`.

| Stile | Prima | Dopo | Aggiunte | Rimozioni |
| --- | ---: | ---: | ---: | ---: |
| Inizio dello scontro | 65 | 68 | 5 | 2 |
| Pressione a distanza | 30 | 64 | 34 | 0 |
| Danno esplosivo | 64 | 88 | 24 | 0 |
| Danno prolungato | 76 | 109 | 33 | 0 |
| Controllo dell’area | 37 | 58 | 23 | 2 |
| Duello | 58 | 77 | 21 | 2 |
| Pressione laterale | 36 | 72 | 36 | 0 |

## Inizio dello scontro

Il kit offre un'apertura significativa: accesso associato a immobilizzazione, provocazione, spostamento o isolamento del bersaglio, oppure una suprema che cattura a distanza o controlla più avversari all'arrivo. Un semplice scatto, rallentamento o controllo che richiede uno scontro già avviato non basta.

Aggiunti: Ahri, Fizz, Shen, Twisted Fate, Yone.

Rimossi:

- **Aatrox**: E è breve e il controllo di Darkin Blade/W è locale o condizionale: aiuta a proseguire lo scontro, non costituisce un'apertura affidabile.
- **Taric**: E è un raggio telegrafato utile soprattutto come seguito tramite W; Taric non dispone di accesso o di una suprema offensiva che imponga l'apertura.

Casi condizionali o al confine:

- **Braum**, incluso: Il resto del kit è protettivo, ma R resta una vera apertura a distanza e multi-bersaglio.
- **Kalista**, incluso: R dipende dall'alleato vincolato, ma è una funzione esplicita e strutturale del kit, non una build rara.
- **Nilah**, incluso: L'accesso è mediato da un bersaglio, ma R offre un trascinamento di massa sufficiente a iniziare.
- **Tahm Kench**, incluso: W è molto telegrafato, ma conserva accesso geografico e controllo duro ad area.
- **Ekko**, escluso: W prepara una zona forte ma molto ritardata; il suo dash non garantisce che l'apertura venga imposta.
- **Lux**, escluso: Q è un buon controllo da cattura, ma da solo rimane un normale skillshot senza accesso, spostamento o suprema di apertura.
- **Malzahar**, escluso: R blocca con certezza a corta distanza, ma non fornisce un percorso di accesso e normalmente capitalizza una cattura già disponibile.
- **Morgana**, escluso: Q da sola è un normale skillshot di cattura; R richiede nemici già entro 625 e che il tether lento si completi, mentre il kit non offre accesso per imporlo.
- **Rengar**, escluso: La suprema dà accesso da assassino; il controllo duro richiede una specifica abilità potenziata e non è parte garantita dell'ingresso.
- **Xin Zhao**, incluso: Il tooltip chiarisce che W marca da 1000 per aumentare la gittata di E; R offre spostamento immediato e Q può essere preparata, quindi non è un mero dash seguito da controllo generico.
- **Yasuo**, escluso: R richiede un lancio in aria già prodotto e Q richiede cariche: il kit segue meglio l'apertura di altri.
- **Zaahen**, incluso: Il tooltip assegna 850 di gittata a W: il pull è già un'apertura da distanza, completata da dash e knock-up preparabile.
- **Zoe**, escluso: E è una cattura a lunga portata, ma resta un singolo skillshot senza accesso né controllo di massa dedicato.

## Pressione a distanza

Il kit offre pressione offensiva significativa e ripetibile a distanza prima di uno scontro prolungato, tramite abilità, evocazioni o colpi seguiti da un rientro sicuro. Non bastano normali attacchi a distanza, un proiettile usato soprattutto per catturare o la sola suprema. Forme, armi ed evoluzioni necessarie sono dichiarate.

Aggiunti: Akshan, Aphelios, Azir, Brand, Cassiopeia, Dr. Mundo, Galio, Kai'Sa, Kennen, Kha'Zix, Lillia, Lulu, Maokai, Morgana, Naafiri, Nami, Neeko, Orianna, Rumble, Shyvana, Sivir, Sona, Soraka, Syndra, Tahm Kench, Twisted Fate, Veigar, Vex, Yorick, Yunara, Yuumi, Zed, Zeri, Zilean.

Casi condizionali o al confine:

- **Jhin**, incluso: Q rimbalzata/amplificata attraverso ondata giustifica il tag; W/R da sole non bastano. Poke condizionale di corsia.
- **LeBlanc**, incluso: Q/R e ritorno W permettono pressione senza all-in. Ingresso breve ammesso se accompagnato da rientro nativo; non artiglieria estrema.
- **Kai'Sa**, incluso: Solo W evoluta supera recupero lungo della base; richiede AP. Variante nativa, senza affermare frequenza nel meta o poke per tutte le build.
- **Kha'Zix**, incluso: W base a 1000 e 9 secondi offre già pressione. W evoluta rafforza il tiro senza richiedere una build rara.
- **Shyvana**, incluso: E-drago del kit rinnovato 16.13.1 ha danno percentuale e scia; non si assume la vecchia E né una build AP.
- **Sona**, incluso: Q a 825 e Accelerando sostengono pressione; la passiva integra, ma non sono i soli attacchi a conferire poke.
- **Soraka**, incluso: Q a 810 e recupero 8–4 secondi integra pressione e recupero salute nel ciclo nativo.
- **Yorick**, incluso: E indirizza il branco, ma richiede Mist Walker; E isolata non basta.
- **Azir**, incluso: Soldati proiettati/riposizionabili consentono pressione senza accesso personale; posizione dei soldati ne limita sicurezza.
- **Teemo**, incluso: Tooltip 16.13.1: Q infligge danno e blind (680, 7 secondi); E aggiunge danno all'impatto e nel tempo, W facilita uscita. Pressione nativa da brevi scambi senza permanenza, distinta dagli AA ranged generici e dai funghi di zona.
- **Lulu**, incluso: Q perfora e rallenta a distanza; Pix offre una seconda origine, riposizionabile con E per ripetere la pressione senza una build offensiva. La funzione protettiva del kit coesiste con questo tag.
- **Nami**, incluso: W colpisce a distanza e rimbalza fra nemici e alleati, combinando danno e cure per ripetere scambi e rientrare al sicuro. La funzione protettiva del kit coesiste con questo tag.
- **Janna**, escluso: W è harass breve e Q serve soprattutto controllo/disimpegno; pressione offensiva proiettata non significativa.
- **Malphite**, escluso: Q a 625 consente scambi di corsia, ma pressione complementare al kit d'ingresso.
- **Pantheon**, escluso: Q lanciata offre harass, ma recupero/riduzione attraverso unità ed efficacia ravvicinata la rendono complementare.
- **Nasus**, escluso: E è soprattutto zona di ondata/riduzione armatura; poke significativo richiederebbe privilegiare la specializzazione E.
- **Rek'Sai**, escluso: Q sotterranea rivela e danneggia, ma impatto complementare all'accesso in mischia.
- **Zeri**, incluso: Terreno necessario per laser W esteso; Q da sola non conferisce poke.
- **Yunara**, incluso: W base a 1150 consente pressione; R rafforza il tiro senza essere necessaria.

## Danno esplosivo

Il kit concentra una parte significativa del danno in una finestra breve tramite detonazioni, colpi potenziati, raffiche o un'esecuzione centrale. Preparazione e brevi ritardi sono ammessi. Una generica somma di abilità, un'esecuzione accessoria dopo uno scambio lungo o un picco che richiede una build rara non basta.

Aggiunti: Anivia, Aphelios, Caitlyn, Camille, Graves, Heimerdinger, Jarvan IV, Kled, Lee Sin, Lillia, Nilah, Nunu & Willump, Ornn, Poppy, Sett, Shyvana, Taliyah, Udyr, Varus, Viktor, Xayah, Ziggs, Zilean, Zyra.

Casi condizionali o al confine:

- **Fiddlesticks**, incluso: W concentra drenaggio e colpo finale percentuale in 2 secondi; Q ha un colpo specifico sui già impauriti. Questa finestra preparata coesiste con R persistente; la sola durata R non impone lo stile principale.
- **Anivia**, incluso: Raddoppio E è amplificatore nativo, non somma generica di abilità; coesiste con R sustained.
- **Aphelios**, incluso: R combina impatto/attacchi dell'arma; picco dipende da coppia e munizioni, soprattutto Infernum.
- **Camille**, incluso: Secondo colpo Q ritardato ma fortemente potenziato e convertito in vero: finestra breve preparata.
- **Lillia**, incluso: R amplifica risveglio e centro W infligge danno elevato; distinto dal ciclo Q/passiva.
- **Nunu & Willump**, incluso: Canalizzazione è preparazione, R infligge singola forte esplosione. Interruzione e tempo di carica limitano affidabilità.
- **Ornn**, incluso: Brittle lega W/doppia R a consumazioni percentuali amplificate, native senza build offensiva.
- **Poppy**, incluso: Parete E prepara due colpi percentuali Q; dipende da terreno/seconda connessione.
- **Twitch**, incluso: R/cadenza Q accumulano rapidamente veleno per E; il solo DoT non basta e non si presume AP.
- **Udyr**, incluso: Picco dei due colpi Q risvegliata; non stesso burst delle scelte difensive/tempesta.
- **Varus**, incluso: Blight detonata/Q potenziata sono amplificatori nativi, non deduzione dalla build AP.
- **Xayah**, incluso: Piume preparate richiamate simultaneamente concentrano danno in rilascio specifico.
- **Darius**, escluso: R cresce dopo accumulo prolungato di sanguinamento; sola esecuzione finale non basta.
- **Draven**, escluso: Asce aumentano attacchi ripetuti; colpi forti/R non definiscono scarica centrale distinta dal ciclo.
- **Hecarim**, escluso: E/R possono dare picco, ma danno strutturale si alimenta con Q successive; combo generica d'ingresso non basta.
- **Volibear**, escluso: Q/E/R possono coincidere, ma passiva/W ripetuta sostengono il danno; non si assume AP per burst centrale.
- **Ryze**, escluso: Reset Q producono flusso continuo; eseguire rapidamente un ciclo non basta a duplicarlo in burst.
- **Aatrox**, escluso: Tre Q hanno picchi ma sono normale ciclo ripetuto, senza specifica detonazione/raffica breve centrale.
- **Garen**, incluso: Breve E offensiva conclusa dalla R esecutrice; più tick non conferiscono da soli sustained.
- **Miss Fortune**, incluso: R concentra grande produzione in breve canalizzazione, accanto al ciclo di attacchi W.
- **Zilean**, incluso: Doppia detonazione Q-W-Q preparata, con prima immediata e seconda ritardata.
- **Nocturne**, escluso: L'apertura R/Q/passiva somma i colpi dell'ingresso; non aggiunge una detonazione o raffica caratterizzante distinta dal ciclo di attacchi sostenuto da Q/W/passiva.

## Danno prolungato

Il kit mantiene un motore significativo di danno durante gli scambi lunghi: attacchi potenziati o effetti ricorrenti, abilità frequenti, danno persistente o evocazioni attaccanti. Non bastano normali attacchi, un danno nel tempo marginale o un ripristino disponibile solo dopo un'uccisione. Forme e condizioni necessarie sono dichiarate.

Aggiunti: Akali, Amumu, Annie, Camille, Elise, Fiddlesticks, Gnar, Ivern, Kassadin, Kha'Zix, Kled, K'Sante, Lee Sin, Miss Fortune, Morgana, Naafiri, Quinn, Rammus, Renekton, Rengar, Riven, Sett, Shaco, Shen, Skarner, Sylas, Tahm Kench, Taliyah, Taric, Teemo, Twisted Fate, Zac, Zyra.

Casi condizionali o al confine:

- **Taric**, incluso: La passiva dà due colpi rapidi con bonus/riduzione recuperi; ricaricano Q che riavvia la passiva. Ciclo esplicito, non normali attacchi di un support.
- **Annie**, incluso: Tibbers ha attacchi, aura e finestre di velocità; evocazione persistente distinta dal burst iniziale.
- **Ivern**, incluso: Daisy comandabile attacca e ripete shockwave al terzo; W integra. Non dedotto dagli attacchi ranged ordinari.
- **Fiddlesticks**, incluso: Entrambe W/R producono danno durante durata; finale W aggiunge esecuzione.
- **Gnar**, incluso: Hyper e velocità E sono motore Mini; non descrive Mega allo stesso modo.
- **Kassadin**, incluso: R arriva a 2 secondi ed E recupera con abilità vicine; rango e mana limitano continuità.
- **Kayn**, incluso: Soprattutto Rhaast che cura dal danno; Assassino resta finestra iniziale.
- **Kha'Zix**, incluso: Q su isolati, specie evoluta, sostiene ciclo frequente nello stesso duello senza build rara.
- **Rammus**, incluso: Riflessione W è sorgente strutturale condizionata ad attacchi nemici; bonus dalle difese integra.
- **Shaco**, incluso: Clone/scatole attaccano nel kit base; build e posizione cambiano peso del motore.
- **Twisted Fate**, incluso: E dà velocità e proc ogni quattro colpi. Componente nativa senza dichiarare unico stile o richiedere AD.
- **Zac**, incluso: W 5 secondi meno 1 per globulo è circuito nativo significativo oltre l'ingresso.
- **Mel**, escluso: Overwhelm prepara esecuzione/R, ma Q/E non formano ciclo particolarmente frequente/persistente; accumulo solo non equivale a sustained.
- **Nautilus**, escluso: DoT W dura mentre tiene scudo; accessorio al controllo senza catena offensiva autoalimentata comparabile a Taric.
- **Blitzcrank**, escluso: Velocità W e R passiva restano complementari alla cattura: non basta bonus agli attacchi.
- **Braum**, escluso: Bonus dopo proc è accessorio a controllo/protezione; attacchi necessari ad accumulare non bastano.
- **Malphite**, escluso: Aftershock W per una finestra non formano ciclo persistente abbastanza centrale rispetto all'ingresso.
- **Jarvan IV**, escluso: Velocità E da sola non definisce motore personale prolungato; passiva/combo sono picchi iniziali.
- **Sion**, escluso: Velocità elevata appartiene alla breve rianimazione; kit vivo non ha motore ricorrente continuo.
- **Fizz**, escluso: Sanguinamento e bonus W successivi sono complementari alla combo breve, senza pari significatività prolungata.
- **Talon**, escluso: Sanguinamento chiude combo a tre ferite; non ogni DoT di chiusura conferisce sustained.
- **Orianna**, escluso: Q breve e attacchi crescenti non hanno reset/persistenza centrale comparabile ai motori ammessi.
- **Kennen**, escluso: R e velocità E durano finestra; proc ogni cinque attacchi resta complementare al controllo/scarica R.

## Controllo dell’area

Il kit controlla lo spazio con terreno, trappole, evocazioni o aree che mantengono una minaccia significativa e costringono a cambiare percorso o a uscire. Valgono anche zone mobili o canalizzate. Un colpo ad area istantaneo o un rallentamento applicato solo all'impatto non basta.

Aggiunti: Braum, Fiddlesticks, Gragas, Graves, Irelia, Jinx, Kennen, Kindred, Kog'Maw, Lux, Mel, Miss Fortune, Nasus, Nidalee, Nunu & Willump, Ornn, Poppy, Shyvana, Soraka, Thresh, Trundle, Udyr, Varus.

Rimossi:

- **Cho'Gath**: Q è un AoE ritardato che si risolve all'impatto; il resto del kit non lascia terreno, trappole o minacce persistenti.
- **Sion**: Q segnala un'area durante la carica ma scompare al colpo; nessuna abilità lascia una minaccia persistente o ripetibile nello spazio.

Casi condizionali o al confine:

- **Aphelios**, incluso: La sentinella dipende dalla rotazione delle cinque armi, ma ricorre per regola del kit e non per una build rara.
- **Ekko**, incluso: W è ritardata, ma l'anomalia persiste e la minaccia di stordimento modifica chiaramente il passaggio.
- **Ivern**, incluso: I cespugli non danneggiano da soli, ma sono terreno creato di lunga durata che cambia visione e sicurezza dell'area per tutta la squadra.
- **Lissandra**, incluso: Il campo dipende dalla suprema, ma il ghiaccio oscuro persiste e impone un rallentamento ampio oltre l'impatto iniziale.
- **Malzahar**, incluso: Il tooltip separa la soppressione dal pool: il dato ufficiale indica un pool di 5 secondi contro 2,5 di controllo, oltre ai Voidling evocati e persistenti.
- **Miss Fortune**, incluso: E applica per tutta la propria area onde, rallentamento e danno al secondo; R aggiunge una seconda geometria sostenuta.
- **Nunu & Willump**, incluso: La tormenta applica continuamente un rallentamento crescente e conserva la minaccia di detonazione; il fatto che sia canalizzata non la rende un AoE istantaneo.
- **Orianna**, incluso: La sfera non danneggia senza comando, ma è un'origine persistente e ripetibile per quasi tutto il controllo ad area del kit.
- **Shyvana**, incluso: La funzione è condizionata alla forma drago, ma R è una trasformazione prevista dal ciclo normale e il sentiero di E resta sul terreno.
- **Xayah**, incluso: Le piume sono inerti prima del richiamo, ma accumularle e tracciare linee di E è una funzione centrale e ripetibile.
- **Zilean**, incluso: La singola bomba dura poco, ma resta sul terreno e W rende strutturale la sovrapposizione ripetuta con minaccia di stordimento.
- **Akali**, escluso: W protegge e nasconde Akali, ma non applica direttamente una minaccia persistente agli avversari nell'area.
- **Corki**, escluso: Il breve sentiero di W è soprattutto una conseguenza del movimento e non una funzione spaziale abbastanza significativa nel kit.
- **Vex**, escluso: E è chiamata zona nella descrizione breve, ma il tooltip mostra un impatto con rallentamento applicato, senza campo che resti sul terreno.
- **Viego**, escluso: E mantiene nebbia sul terreno, ma potenzia e nasconde Viego senza imporre direttamente effetti a chi entra.
- **Zed**, escluso: W è un'origine breve per una combo e un punto di scambio, non una proiezione ripetuta o durevole di controllo dell'area.

## Duello

Il kit sostiene scambi ripetuti o prolungati sullo stesso avversario con un ciclo offensivo ripetibile e strumenti per inseguire, mantenere la distanza, difendersi o recuperare salute. Una sola finestra di danno esplosivo o un ripristino che richiede un'uccisione non basta.

Aggiunti: Diana, Dr. Mundo, Ekko, Elise, Hecarim, Jayce, Kayle, Kayn, Lillia, Lucian, Nidalee, Poppy, Rek'Sai, Rumble, Skarner, Swain, Tristana, Vi, Vladimir, Xayah, Zeri.

Rimossi:

- **Fizz**: La difesa di E e gli attacchi di W supportano soprattutto una rotazione esplosiva, senza ciclo durevole sufficiente.
- **Zed**: Ombre ed energia costruiscono la finestra di Marchio della Morte, ma non un ciclo prolungato o ripetuto sul bersaglio.

Casi condizionali o al confine:

- **Aphelios**, escluso: Alcune armi offrono cura, movimento o controllo, ma non sono affidabilmente disponibili; il ciclo base resta quello di un tiratore.
- **Fizz**, escluso: E offre grande difesa, ma il kit converge su una singola finestra di burst.
- **Kennen**, escluso: I tre marchi e la velocità sostengono scambi, ma difesa e recupero personale non mantengono un duello prolungato.
- **Naafiri**, incluso: Nello snapshot 16.13.1 W rende intargettabile e potenzia il branco con ricarica 26-18 s; due Q, branco ed E curativa sostengono il ciclo anche prima di un takedown. Solo il secondo R con scudo resta condizionato al takedown.
- **Orianna**, escluso: Passiva sullo stesso bersaglio e scudo sono elementi reali ma secondari rispetto al controllo di zona.
- **Rammus**, escluso: Può vincere confronti specifici riflettendo attacchi, ma il ciclo offensivo dipende troppo dal tipo di avversario.
- **Samira**, escluso: Combo e W danno strumenti personali, ma i reset richiedono eliminazioni e la R è orientata a più bersagli.
- **Shaco**, escluso: Clone e scatole possono prolungare il confronto, ma il risultato dipende fortemente da preparazione e varianti di build.
- **Taric**, escluso: La passiva crea un buon ciclo di ricariche e difese, ma danno e controllo sono progettati soprattutto per il combattimento con un alleato.
- **Yunara**, escluso: Velocità d'attacco e movimento non aggiungono una difesa, recupero o ciclo sul singolo bersaglio abbastanza distinto.
- **Zed**, escluso: Gli scambi con ombre esistono, ma Marchio della Morte concentra il kit su burst e uscita.

## Pressione laterale

Il kit combina gestione dell'ondata con pressione sulle strutture o evocazioni, un duello o recupero di salute sostanziale, oppure ricongiungimento a lunga distanza dopo la spinta. La mobilità contribuisce quando sostiene scambi ripetuti o permette una fuga estesa attraverso il terreno. Giocare in corsia superiore o possedere un solo scatto non basta.

Aggiunti: Aatrox, Azir, Cassiopeia, Diana, Gnar, Graves, Hecarim, Heimerdinger, Jayce, Kayn, K'Sante, Lillia, Locke, Lucian, Malzahar, Master Yi, Wukong, Nocturne, Olaf, Pantheon, Poppy, Rek'Sai, Renekton, Rumble, Sett, Shaco, Shyvana, Skarner, Taliyah, Udyr, Urgot, Viego, Vladimir, Volibear, Zeri, Ziggs.

Casi condizionali o al confine:

- **Ahri**, escluso: Q pulisce e R è mobile, ma la pressione su strutture e il duello autonomo restano deboli.
- **Akali**, escluso: Ha duello e uscite locali, ma la gestione dell'ondata e la pressione sulle strutture non sono abbastanza affidabili.
- **Aurelion Sol**, escluso: Pulizia e volo sono reali, ma il volo è fragile sotto pressione e il kit non difende bene una laterale profonda.
- **Kai'Sa**, escluso: Q pulisce e il duello è valido, ma R va verso un nemico e non costituisce un'uscita affidabile.
- **Kennen**, escluso: W/E aiutano l'ondata e E è una sola uscita locale: manca pressione specializzata, autosostentamento o duello abbastanza sostanziale.
- **Kindred**, escluso: Q e R danno sicurezza, ma ondata e strutture non ricevono pressione abbastanza distinta dal kit.
- **LeBlanc**, escluso: W pulisce e ritorna, ma il kit produce poca pressione persistente su ondata e strutture.
- **Lucian**, incluso: Non è un caso di singolo dash: i doppi attacchi generati da ogni abilità riducono continuamente E, sostenendo un ciclo di duello e riposizionamento mentre Q gestisce l'ondata.
- **Nilah**, escluso: Può pulire e duellare, ma gli scatti richiedono unità bersaglio e parte dell'autonomia dipende da un alleato.
- **Swain**, escluso: Pulisce e regge il combattimento, ma non ha uscita/ricongiungimento né pressione esplicita sulle strutture.
- **Sylas**, escluso: Duella e si muove localmente, ma pulizia e pressione sulle strutture non sono abbastanza affidabili.
- **Vayne**, escluso: Duello e attacchi alle strutture sono forti, ma il kit non gestisce l'ondata in modo affidabile.
- **Xayah**, escluso: Piume e R difendono bene il duello, ma manca un'uscita o una pressione strutturale distinta.

## Tracciabilità e limiti

Il campo `tag_reasons` contiene una motivazione per ogni tag di ogni campione. L'API la associa alla categoria pertinente e il dettaglio “Perché…” la mostra accanto alle partite osservate. Una motivazione descrive il kit, non il comportamento effettivo del giocatore in quella partita.

Forme, armi ed evoluzioni possono rendere un tag condizionale. Le descrizioni sintetiche non misurano affidabilità esecutiva, numeri di bilanciamento o forza nel meta. Cambiamenti successivi allo snapshot richiedono un nuovo audit.

L'integrazione controlla identità dei 173 campioni, unicità dei membri, coerenza dei delta, presenza delle motivazioni e conservazione di classi, ruoli e Protezione degli alleati.

## Verifica della consegna

Catalogo verificato: 1.2.0, SHA-256 `e89ee3faaca461d5c3d5ea4065ec75969a90c85a03d9d1aa1647789a64a1a11b`.

- Test Python di tassonomia, analisi e API: 32 passati, con 17 sottocasi. Dopo gli ultimi tre delta del catalogo, ripetuti tassonomia e API: 12 passati, con gli stessi 17 sottocasi; i 20 test dell'analisi conservano l'esito precedente.
- Test frontend della pagina e dell'API: 12 passati. Build di produzione completata.
- Server operativo riavviato per eliminare il catalogo 1.1.0 conservato in memoria.
- Browser su dati locali, con refresh completo: versione 1.2.0, motivazioni presenti per tutte le 566 righe di composizione degli stili nel contesto aggregato, Lux assente da Protezione degli alleati.
- Controllo visivo a 1440×900 e 390×844: motivazioni leggibili, nessun overflow orizzontale o errore JavaScript.

La review indipendente ha chiuso i tre rilievi su Lulu/Nami nella pressione a distanza e sull'esclusione di Nocturne dalle nuove assegnazioni di danno esplosivo. Il giudizio resta legato ai kit dello snapshot, senza verifica di frequenze delle build o del meta.
