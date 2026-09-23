# Purchase Orders for Stock Replenishment

Applicazione web per la gestione degli **ordini di riapprovvigionamento**: dato
un articolo e una quantità, il sistema confronta tutti i fornitori che lo
vendono e suggerisce il più conveniente, tenendo conto di disponibilità a
magazzino, sconti e tempi di consegna.

Realizzata come soluzione al test tecnico *"Purchase orders for stock
replenishment"* di Regesta.

## Indice

1. [Panoramica](#panoramica)
2. [Architettura](#architettura)
3. [Stack tecnologico e scelte tecniche](#stack-tecnologico-e-scelte-tecniche)
4. [Modello dati](#modello-dati)
5. [Avvio del progetto](#avvio-del-progetto)
6. [Riferimento API](#riferimento-api)
7. [Guida all'uso, con casi di esempio](#guida-alluso-con-casi-di-esempio)
8. [Analisi funzionalità (formato BDD)](#analisi-funzionalità-formato-bdd)
9. [Limiti noti e possibili estensioni](#limiti-noti-e-possibili-estensioni)
10. [Strumenti AI utilizzati](#strumenti-ai-utilizzati)
11. [Struttura del repository](#struttura-del-repository)

---

## Panoramica

Il problema (vedi consegna originale): un negozio vende articoli che può
acquistare da più fornitori diversi. Ogni fornitore ha un proprio prezzo
d'acquisto, una propria disponibilità a magazzino, un proprio tempo minimo di
spedizione e, eventualmente, offre uno sconto (legato alla quantità
ordinata, al valore totale dell'ordine o a un periodo dell'anno). Scelto un
articolo e una quantità, il sistema deve individuare quali fornitori possono
evadere l'ordine, calcolare il totale applicando eventuali sconti e
suggerire il fornitore migliore — evidenziando sia il più economico sia,
tramite un cursore di preferenza, il miglior compromesso tra prezzo e
velocità di consegna.

Oltre al flusso principale (sezione **Orders**), l'applicazione include:

- **Catalog** — catalogo prodotti e fornitori, con il dettaglio delle
  offerte disponibili per ciascun articolo.
- **History** — storico di tutti gli ordini confermati.
- **Insights** — prodotti più acquistati in passato, con riordino rapido.
- **Settings** — dark mode e reset del database ai dati di partenza.
- **Account / Debug Tools** — pannello per inserire manualmente un nuovo
  articolo con la sua offerta fornitore (ed eventuale sconto), utile per
  costruire scenari di test aggiuntivi senza toccare il database a mano.

## Architettura

Applicazione a tre livelli, classica per una SPA con backend REST:

```
┌────────────────────────┐        HTTP / JSON           ┌────────────────────────┐        SQL           ┌──────────────────────┐
│   Frontend (React)     │  ────────────────────────▶  │   Backend (Express)     │ ──────────────────▶ │   MySQL / MariaDB    │
│   Vite dev server      │ ◀────────────────────────   │   REST API              │ ◀────────────────── │   (dati relazionali) │
│   http://localhost:5173│                              │   http://localhost:5000│                      │                      │
└────────────────────────┘                              └────────────────────────┘                      └──────────────────────┘
```

- Il **frontend** è una Single Page Application: un unico componente
  (`App.jsx`) gestisce la navigazione tra sezioni tramite stato locale
  (nessun router), effettua tutte le chiamate al backend con `fetch` e
  ricostruisce la UI in modo dichiarativo a partire dalla risposta.
- Il **backend** espone endpoint REST stateless (tranne lo storico ordini,
  vedi sotto) che incapsulano tutta la logica di business: interrogazione
  del catalogo, calcolo del preventivo con sconti e punteggio
  prezzo/tempo, aggiornamento dello stock in transazione al checkout.
- Il **database** (MySQL o MariaDB, indifferentemente — l'ambiente di
  sviluppo originale usa MariaDB 10.4 via XAMPP/phpMyAdmin, il driver
  `mysql2` è compatibile con entrambi) è puramente relazionale: 4 tabelle
  (`articles`, `suppliers`, `supplier_articles`, `discounts`), vedi
  [Modello dati](#modello-dati).
- Lo **storico ordini** è tenuto in memoria di processo sul backend
  (array JS), non su una tabella: è una scelta di semplicità per
  l'esercizio (vedi [Limiti noti](#limiti-noti-e-possibili-estensioni)).

Non è stato introdotto alcun ORM: le query sono scritte direttamente in SQL
tramite il driver `mysql2/promise`, con placeholder parametrizzati (`?`) per
prevenire SQL injection. Per un progetto di queste dimensioni, con un numero
di query limitato e query molto mirate (in particolare quella di calcolo
preventivo, che aggrega più tabelle e una subquery per gli sconti), un ORM
avrebbe aggiunto un livello di indirezione senza benefici concreti.

## Stack tecnologico e scelte tecniche

| Livello    | Scelta                               | Perché |
|------------|--------------------------------------|--------|
| Frontend   | **React 19 + Vite**                  | Vite offre un dev server istantaneo (HMR) e build ottimizzate senza configurazione; React perché il problema è naturalmente un albero di stato/UI (form → risultati → carrello) ben coperto da componenti e hook, senza bisogno di un framework full-stack. |
| Stato UI   | `useState` / `useMemo` locali        | L'app ha un solo componente "pagina" con più sezioni: uno state manager esterno (Redux, Zustand…) sarebbe sovradimensionato. `useMemo` è usato per l'unico calcolo derivato costoso (aggregazione dello storico in Insights), per evitare di ricalcolarlo a ogni render. |
| Backend    | **Node.js + Express**                | API REST minimali, senza necessità di un framework "opinionato": Express resta la scelta più diretta per esporre pochi endpoint JSON con middleware di base (`cors`, `express.json`). |
| Database   | **MySQL/MariaDB** (`mysql2/promise`) | I dati sono intrinsecamente relazionali (articolo ↔ fornitore ↔ offerta ↔ sconto, con vincoli di integrità referenziale) — un buon fit per un RDBMS. `mysql2/promise` supporta query parametrizzate, transazioni e `async/await` nativamente, ed è compatibile sia con MySQL sia con MariaDB. |
| Stile      | CSS puro (nessun framework UI)       | Un solo file `App.css` organizzato per sezione, con variabili di colore coerenti e supporto a dark mode e layout responsive (mobile-first breakpoints) tramite media query, senza la superficie aggiuntiva di una libreria di componenti. |

Altre decisioni rilevanti:

- **Calcolo lato server, non lato client**: il confronto tra fornitori
  (idoneità, sconti, punteggio) avviene interamente nel backend
  (`POST /api/orders/calculate`); il frontend si limita a visualizzare il
  risultato. Questo evita di duplicare la logica di business in due posti e
  garantisce che il calcolo sia coerente indipendentemente dal client.
- **Punteggio "Best Value" configurabile**: oltre a evidenziare il
  fornitore più economico, l'app calcola un punteggio pesato
  prezzo/tempo di consegna (normalizzati con min-max scaling) e lo fa
  scorrere con uno slider a 5 posizioni (100% risparmio → 100% velocità),
  così l'utente può scegliere consapevolmente un fornitore più veloce anche
  se leggermente più caro — è esattamente il caso descritto nella consegna
  originale ("a faster supplier is still better than a cheaper one").
- **Transazioni per le operazioni multi-tabella**: sia il checkout
  (decremento stock su più righe) sia l'inserimento di debug
  (articolo + offerta + sconto) usano `beginTransaction`/`commit`/
  `rollback`, per non lasciare il database in uno stato incoerente in caso
  di errore a metà operazione.
- **Nessun ORM, nessun framework di validazione**: scelta di
  minimalismo per un progetto di queste dimensioni; vedi
  [Limiti noti](#limiti-noti-e-possibili-estensioni) per cosa manca ancora
  (validazione input, autenticazione, test automatici).

## Modello dati

```
suppliers                articles
┌────────────┐          ┌────────────────────┐
│ id (PK)    │          │ id (PK)             │
│ name       │          │ name                │
└─────┬──────┘          │ image_url           │
      │                 └──────────┬──────────┘
      │                            │
      │        supplier_articles   │
      │        ┌──────────────────┴────┐
      └───────▶│ id (PK)              │
               │ supplier_id (FK)      │
               │ article_id (FK)       │
               │ stock_quantity        │
               │ unit_price  DECIMAL(10,2) │
               │ delivery_date         │
               └──────────┬────────────┘
                          │
                 discounts│
               ┌──────────┴──────────────────┐
               │ id (PK)                      │
               │ supplier_article_id (FK)     │
               │ discount_type  ENUM(         │  'QUANTITY' | 'TOTAL_AMOUNT' | 'MONTH'
               │   'QUANTITY','TOTAL_AMOUNT', │
               │   'MONTH')                   │
               │ threshold_value               │
               │ percentage                   │
               └───────────────────────────────┘
```

`supplier_articles` è la tabella ponte che modella "l'offerta" di un
fornitore per un articolo (prezzo, stock e consegna sono attributi
dell'offerta, non dell'articolo in sé — lo stesso articolo può avere prezzi
e tempi diversi da fornitore a fornitore). `discounts` è collegata
all'offerta specifica, non all'articolo, perché lo stesso fornitore può
avere condizioni di sconto diverse su prodotti diversi. `discount_type` è
un vero ENUM SQL (non una stringa libera): i tre valori ammessi
corrispondono esattamente alle tre modalità di sconto descritte nella
consegna originale (quantità ordinata, valore totale dell'ordine,
periodo/stagione).

Lo script di creazione completo (con vincoli di chiave esterna e indici) è
in [`backend/schema.sql`](backend/schema.sql), ricostruito da un dump reale
del database (`phpMyAdmin`/MariaDB) per garantire che i tipi di colonna
corrispondano esattamente a quelli effettivamente in uso. I dati di esempio
precaricati dal reset del database (articoli, 5 fornitori, offerte e
sconti) sono definiti direttamente in `backend/server.js`, nell'endpoint
`POST /api/db/reset`.

## Avvio del progetto

Prerequisiti: **Node.js 18+**, **npm** e un server **MySQL/MariaDB** locale
(sviluppato e testato su MariaDB 10.4 via XAMPP, ma compatibile con MySQL 8).

### 1. Database

```bash
mysql -u root -p < backend/schema.sql
```

Crea il database `stock_replenishment` e le 4 tabelle vuote. I dati di
esempio non sono in `schema.sql`: si popolano al primo avvio dell'app
chiamando l'endpoint di reset (vedi punto 4).

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env      # poi modifica .env con le tue credenziali MySQL
npm run dev                # avvia con nodemon su http://localhost:5000
# oppure: npm start        # avvio "semplice" senza auto-reload
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                 # avvia Vite su http://localhost:5173
```

### 4. Popolare i dati di esempio

Apri l'app (`http://localhost:5173`), vai in **Settings** e premi
**"Reset Database Iniziale"**: popola le tabelle con 11 articoli, 5
fornitori, le relative offerte e alcuni sconti quantità di esempio. Da qui
in poi l'app è pienamente utilizzabile — vedi la guida sotto per due casi
d'uso completi con questi stessi dati.

## Riferimento API

Base URL: `http://localhost:5000`

| Metodo | Endpoint                             | Descrizione |
|--------|---------------------------------------|-------------|
| GET    | `/api/articles`                       | Elenco articoli del catalogo |
| POST   | `/api/articles`                       | Crea un nuovo articolo (solo nome + immagine) |
| GET    | `/api/articles/:id/suppliers`         | Fornitori che vendono un articolo, con prezzo/stock/consegna |
| GET    | `/api/suppliers`                      | Elenco fornitori |
| GET    | `/api/suppliers/:id/products`         | Assortimento prodotti di un fornitore |
| POST   | `/api/orders/calculate`               | **Endpoint principale**: calcola il preventivo per un articolo/quantità confrontando tutti i fornitori |
| GET    | `/api/orders/history`                 | Storico ordini confermati |
| POST   | `/api/orders/checkout`                | Conferma un ordine: scala lo stock e salva nello storico |
| POST   | `/api/debug/add-product-offer`        | Crea articolo + offerta fornitore + sconto opzionale (pannello Account/Debug) |
| POST   | `/api/db/reset`                       | Svuota e ripopola il database con i dati di esempio |

Dettagli di richiesta/risposta di ogni endpoint sono documentati come
commenti JSDoc direttamente sopra ciascuna route in
[`backend/server.js`](backend/server.js).

## Guida all'uso, con casi di esempio

### Flusso principale (sezione Orders)

1. Nel form **"Nuova Selezione Prodotto"** cerca/seleziona un articolo,
   imposta la **quantità**, la **data ordine** e la **deadline** entro cui
   deve arrivare.
2. (Opzionale) apri **"Preferenze"** e sposta lo slider tra 💰 *Risparmio*
   e 🚀 *Velocità*: cambia il peso di prezzo e tempo di consegna nel
   punteggio "Best Value".
3. Premi **"Calcola Preventivi"**: compare una card per ogni fornitore che
   vende l'articolo. Ogni card mostra prezzo (scontato se applicabile),
   stock disponibile, data di consegna stimata e un'etichetta di stato:
   - 🏷️ **Miglior Prezzo** — il fornitore più economico tra gli idonei;
   - ⚡ **Più Veloce** — quello con i giorni di spedizione minori;
   - ⭐ **Best Value** — il miglior compromesso secondo lo slider;
   - ⚠️ **Non Idoneo** — stock insufficiente e/o consegna fuori deadline
     (mostrato ma escluso dal confronto, come richiesto dalla consegna
     "Supplier 1 is not prompted...").
4. Da una card idonea premi **"Aggiungi al Carrello"**, poi apri il
   carrello (in alto, resta visibile anche scorrendo la pagina) e
   **"Conferma ed Invia Ordine"**: lo stock del fornitore scelto viene
   scalato nel database e l'ordine compare subito in **History**.

### Caso d'esempio 1 — un fornitore escluso per ritardo, tre "vincitori" diversi

Usando i dati precaricati dal reset (nessuna configurazione aggiuntiva
necessaria):

**Input**
- Articolo: *Carta A4 Multiuso 80g (Box 5 Risme)*
- Quantità: **60**
- Data ordine: **2025-09-01** — Deadline: **2025-09-12**
- Preferenze: **Bilanciato** (posizione centrale dello slider)

**Offerte disponibili per l'articolo:**

| Fornitore | Stock | Prezzo unit. | Consegna | Sconto per 60pz |
|-----------|------:|-------------:|----------|-----------------|
| EcoSaver Supply | 500 | 11,50 € | 2025-09-25 | 5% (soglia 50 pz) |
| SmartBudget Trade | 350 | 14,80 € | 2025-09-18 | — (soglia 150 pz non raggiunta) |
| Balanced Logistics | 400 | 18,50 € | 2025-09-10 | 8% (soglia 50 pz) |
| Express Delivery Co. | 200 | 25,00 € | 2025-09-07 | — (soglia 200 pz non raggiunta) |
| FlashShip 24h | 150 | 33,00 € | 2025-09-06 | — |

**Output atteso**

- **EcoSaver Supply** e **SmartBudget Trade** non vengono proposti tra gli
  idonei: hanno stock sufficiente, ma la consegna (25/09 e 18/09) arriva
  dopo la deadline del 12/09.
- **Balanced Logistics** può evadere l'ordine per **1.021,20 €**
  (18,50 € × 0,92 di sconto × 60 pz) — è il più economico, evidenziato
  🏷️ **Miglior Prezzo**.
- **FlashShip 24h** consegna in soli **5 giorni** (il minimo) — evidenziato
  ⚡ **Più Veloce**, pur costando 1.980,00 €.
- **Express Delivery Co.** (1.500,00 €, 6 giorni) non è né il più
  economico né il più veloce, ma con le preferenze bilanciate ottiene il
  punteggio combinato migliore ed è quindi evidenziato come ⭐
  **Best Value**: dimostra esattamente il caso descritto nella consegna
  originale, "a faster supplier is still better than a cheaper one".

### Caso d'esempio 2 — esclusione per stock insufficiente

**Input**
- Articolo: *Sedia da Ufficio Ergonomica*
- Quantità: **20**
- Data ordine: **2025-09-01** — Deadline: **2025-09-20**

**Offerte disponibili:**

| Fornitore | Stock | Prezzo unit. | Consegna |
|-----------|------:|-------------:|----------|
| EcoSaver Supply | 50 | 72,00 € | 2025-09-25 |
| SmartBudget Trade | 40 | 96,00 € | 2025-09-18 |
| Balanced Logistics | 30 | 120,00 € | 2025-09-10 |
| Express Delivery Co. | **15** | 162,00 € | 2025-09-07 |
| FlashShip 24h | **2** | 216,00 € | 2025-09-06 |

**Output atteso**

- **Express Delivery Co.** e **FlashShip 24h** non vengono proposti: pur
  consegnando in tempo, hanno rispettivamente solo 15 e 2 pezzi in stock,
  insufficienti per un ordine di 20 — analogo al "Supplier 1 is not
  prompted because it does not have enough stock quantity available" della
  consegna originale.
- **EcoSaver Supply** viene escluso a sua volta, ma per ritardo (consegna
  25/09, oltre la deadline del 20/09).
- Restano idonei **SmartBudget Trade** (1.920,00 €, 17 giorni — 🏷️
  Miglior Prezzo) e **Balanced Logistics** (2.400,00 €, 9 giorni — ⚡ Più
  Veloce): con le preferenze bilanciate i due fornitori ottengono lo
  stesso punteggio "Best Value" (un caso limite in cui prezzo e velocità
  si compensano esattamente) e vengono quindi evidenziati entrambi.

### Altre sezioni

- **Catalog**: tab *Prodotti* per sfogliare il catalogo e aprire il
  dettaglio fornitori/stock di un articolo; tab *Fornitori* per vedere
  l'intero assortimento di un singolo fornitore.
- **History**: elenco cronologico di tutti gli ordini confermati, con il
  dettaglio delle righe (prodotto, fornitore, quantità, prezzo).
- **Insights**: prodotti più acquistati in assoluto (con barra
  proporzionale alla quantità totale), ognuno riordinabile in un click
  impostando la quantità desiderata (default 1) — riutilizza fornitore e
  prezzo dell'ultimo acquisto registrato per quel prodotto.
- **Account & Debug Tools** (clic sull'utente in basso a sinistra): form
  per creare rapidamente un nuovo articolo con la sua prima offerta
  fornitore, utile per costruire nuovi scenari di test. Fornitore, prezzo
  e stock sono obbligatori; se si abilita "Applica uno sconto" diventano
  obbligatori anche tipo, soglia e percentuale dello sconto.

## Analisi funzionalità (formato BDD)

### Feature: Calcolo del miglior fornitore per un ordine di riapprovvigionamento

**Narrative**

- **As a**: responsabile acquisti del negozio
- **I want**: poter confrontare, per un articolo e una quantità scelti,
  tutti i fornitori disponibili in base a prezzo (sconti inclusi), stock e
  tempi di consegna
- **So that**: posso scegliere consapevolmente il fornitore più
  conveniente, oppure — se necessario — uno più veloce anche a un prezzo
  leggermente superiore, senza dover confrontare i listini a mano

**Acceptance criteria**

```
Scenario: Un fornitore con stock insufficiente viene escluso dal confronto
  Given un articolo venduto da più fornitori
    And un fornitore ha meno pezzi in stock della quantità richiesta
  When calcolo il preventivo per quella quantità
  Then quel fornitore compare nei risultati come "Non Idoneo"
    And non partecipa al calcolo del fornitore più economico/veloce

Scenario: Un fornitore con consegna oltre la deadline viene escluso dal confronto
  Given un articolo venduto da più fornitori
    And un fornitore consegnerebbe dopo la data di deadline richiesta
  When calcolo il preventivo per quella quantità e quella deadline
  Then quel fornitore compare nei risultati come "Non Idoneo"
    And non partecipa al calcolo del fornitore più economico/veloce

Scenario: Lo sconto per quantità viene applicato quando la soglia è raggiunta
  Given un fornitore offre uno sconto del 5% per ordini di almeno 50 pezzi
  When ordino 60 pezzi da quel fornitore
  Then il prezzo totale riflette lo sconto del 5%
    And viene mostrato sia il prezzo originale sia quello scontato

Scenario: Viene evidenziato il fornitore più economico
  Given più fornitori idonei per lo stesso ordine
  When confronto i risultati
  Then il fornitore con il totale più basso è etichettato "Miglior Prezzo"

Scenario: Un fornitore più veloce viene preferito a uno più economico
  Given due fornitori idonei, uno più economico e uno più veloce
    And le preferenze dell'utente sono spostate verso la velocità
  When confronto i risultati
  Then il fornitore più veloce può risultare "Best Value" anche se non è il più economico
```

## Limiti noti e possibili estensioni

Documentati qui in modo esplicito, come parte delle scelte tecniche
consapevoli fatte per stare nei tempi dell'esercizio:

- **Sconti per valore ordine e stagionali non ancora applicati al
  calcolo**: il modello dati e il pannello di debug supportano già i
  valori ENUM `'TOTAL_AMOUNT'` (valore ordine) e `'MONTH'` (stagionale) di
  `discounts.discount_type`, ma `POST /api/orders/calculate` oggi
  considera solo `'QUANTITY'`. Estensione naturale: aggiungere le due
  condizioni nella query/nel calcolo del prezzo scontato.
- **Storico ordini in memoria**: `orderHistoryDB` in `server.js` è un
  array JS, non una tabella — si azzera a ogni riavvio del backend (e
  viene svuotato esplicitamente da un reset del database). Per un uso in
  produzione andrebbe spostato su una tabella `orders`/`order_items`.
- **Nessuna autenticazione**: l'app è pensata per un singolo
  utente/postazione, come da ambito dell'esercizio; l'"Account" in sidebar
  è in realtà un pannello di debug, non un vero login.
- **Validazione input minimale**: gli endpoint si affidano perlopiù ai
  vincoli del database (chiavi esterne, `NOT NULL`) e alla validazione
  HTML5 lato client (`required`, `min`); non c'è una libreria di
  validazione lato server (es. `zod`/`joi`) sui body delle richieste.
- **Nessun test automatico incluso**: la sezione facoltativa TDD/BDD della
  consegna è stata coperta solo a livello di analisi ([sopra](#analisi-funzionalità-formato-bdd));
  la traduzione in una suite eseguibile (es. Jest per la logica di calcolo
  in `server.js`, isolando la funzione di scoring dalle query MySQL) è un
  passo naturale successivo.

## Strumenti AI utilizzati

Come richiesto dalle linee guida del test, dichiaro quali strumenti di AI ho
usato nello sviluppo e in che fase:

- **Google Gemini** — usato nella fase iniziale per l'organizzazione del
  progetto e per i primi prototipi (struttura generale di frontend e
  backend, prima bozza delle pagine e degli endpoint).
- **Claude (Anthropic)** — usato nella fase successiva per revisionare e
  rifinire quanto prodotto: correzione di bug (es. calcolo del preventivo,
  formattazione delle date, allineamento del pannello di debug all'ENUM
  reale del database), aggiunta di funzionalità (History, Insights,
  layout responsive, acquisto rapido dal Catalog), commenti al codice e
  stesura di questo README.

## Struttura del repository

```
GriottiRegesta/
├── README.md                  # questo file
├── backend/
│   ├── server.js               # API Express: tutti gli endpoint REST
│   ├── db.js                   # pool di connessioni MySQL
│   ├── schema.sql              # script di creazione delle tabelle
│   ├── .env.example             # variabili d'ambiente di esempio
│   └── package.json
└── frontend/
    ├── src/
    │   ├── App.jsx              # componente radice: tutta la UI e la logica client
    │   ├── App.css              # stili (sezioni, dark mode, layout responsive)
    │   └── main.jsx             # entry point React
    └── package.json
```
