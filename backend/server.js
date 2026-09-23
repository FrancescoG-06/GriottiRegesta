/**
 * server.js — API REST del progetto "Purchase Orders for Stock Replenishment".
 *
 * Espone gli endpoint consumati dal frontend React (cartella `frontend/`)
 * per: consultare catalogo articoli e fornitori, calcolare il preventivo
 * di acquisto più conveniente tra più fornitori (con sconti e tempi di
 * consegna), gestire il carrello/checkout con aggiornamento dello stock,
 * consultare lo storico ordini e, per finalità di test, inserire dati di
 * debug e resettare il database ai valori iniziali.
 *
 * Persistenza: il catalogo (articoli, fornitori, offerte, sconti) vive su
 * MySQL tramite il pool di connessioni definito in `./db.js`. Lo storico
 * ordini (`orderHistoryDB`, vedi sotto) è invece tenuto solo in memoria di
 * processo: è una scelta volutamente semplice per questo esercizio, ma
 * significa che si azzera a ogni riavvio del server (o con un reset del DB).
 */
const express = require('express');
const cors = require('cors');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

/**
 * @route GET /api/articles
 * @desc  Restituisce l'intero catalogo articoli (id, nome, immagine),
 *        usato per popolare la select prodotti e la pagina Catalog.
 */
app.get('/api/articles', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, image_url FROM articles');
    res.json(rows);
  } catch (error) {
    console.error('Errore recupero articoli:', error);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});

/**
 * @route GET /api/articles/:id/suppliers
 * @desc  Restituisce, per un singolo articolo, l'elenco dei fornitori che
 *        lo vendono (id e nome fornitore, stock, prezzo unitario, data di
 *        consegna), ordinati dal più economico al più caro. Usato dalla
 *        modale "Fornitori e Stock Disponibile" del Catalog, da cui è
 *        anche possibile acquistare direttamente cliccando su un'offerta
 *        (per questo serve anche supplier_id, non solo il nome).
 */
app.get('/api/articles/:id/suppliers', async (req, res) => {
  const { id } = req.params;
  try {
    const query = `
      SELECT s.id AS supplier_id, s.name AS supplier_name, sa.stock_quantity, sa.unit_price, sa.delivery_date
      FROM supplier_articles sa
      JOIN suppliers s ON sa.supplier_id = s.id
      WHERE sa.article_id = ?
      ORDER BY sa.unit_price ASC
    `;
    const [rows] = await pool.query(query, [id]);
    res.json(rows);
  } catch (error) {
    console.error('Errore recupero fornitori articolo:', error);
    res.status(500).json({ error: 'Errore interno' });
  }
});

/**
 * @route POST /api/orders/calculate
 * @desc  Calcola il preventivo di acquisto di un articolo confrontando
 *        tutti i fornitori che lo vendono: per ciascuno determina se ha
 *        stock sufficiente, se la consegna arriva entro la deadline
 *        richiesta, il prezzo totale (con gli eventuali sconti applicati)
 *        e i giorni di spedizione stimati. Tra i fornitori idonei
 *        individua il più economico, il più veloce e — tramite un
 *        punteggio pesato configurabile dal client (`slider_position`) —
 *        il miglior compromesso prezzo/tempo ("Best Value").
 *
 *        Sconti: i tre tipi dell'ENUM discounts.discount_type vengono
 *        valutati indipendentemente e, se applicabili, SOMMATI tra loro
 *        (come nell'esempio della consegna originale: "5% discount for
 *        orders over 1000€" + "additional discount of 2% for orders
 *        placed in september" = 7% totale a settembre). All'interno dello
 *        stesso tipo (es. più soglie di quantità) si prende solo la
 *        percentuale migliore tra quelle raggiunte, non la somma.
 *          - QUANTITY:     soglia raggiunta se quantity >= threshold_value
 *          - TOTAL_AMOUNT: soglia raggiunta se (quantity × prezzo unitario,
 *                           NON scontato) >= threshold_value
 *          - MONTH:        soglia raggiunta se il mese di order_date
 *                           coincide con threshold_value (1 = gennaio,
 *                           12 = dicembre)
 * @body  {number} article_id       id dell'articolo richiesto
 * @body  {number} quantity         quantità da ordinare
 * @body  {string} order_date       data dell'ordine (YYYY-MM-DD), usata per calcolare i giorni di spedizione e lo sconto stagionale
 * @body  {string} target_date      deadline entro cui l'ordine deve arrivare (YYYY-MM-DD)
 * @body  {number} [slider_position=3] 1..5: bilanciamento tra risparmio (1) e velocità (5) nel punteggio "Best Value"
 * @returns {{ results: object[] }} un elemento per ogni fornitore, con i flag hasEnoughStock/arrivesInTime/isCheapest/isFastest/isBestValue
 */
app.post('/api/orders/calculate', async (req, res) => {
  const { article_id, quantity, order_date, target_date, slider_position = 3 } = req.body;

  try {
    // Pesi costo/tempo per ciascuna posizione dello slider "Preferenze":
    // 1 = quasi tutto il punteggio sul prezzo, 5 = quasi tutto sulla velocità di consegna.
    const pesi = {
      1: { costo: 0.8, tempo: 0.2 },
      2: { costo: 0.65, tempo: 0.35 },
      3: { costo: 0.5, tempo: 0.5 },
      4: { costo: 0.35, tempo: 0.65 },
      5: { costo: 0.2, tempo: 0.8 }
    };

    const pesoCosto = pesi[slider_position]?.costo ?? 0.5;
    const pesoTempo = pesi[slider_position]?.tempo ?? 0.5;
    const targetDateObj = new Date(target_date);
    // Mese dell'ordine (1-12), in UTC per coerenza con le date "YYYY-MM-DD"
    // restituite dal DB (vedi dateStrings:true in db.js) ed evitare derive di fuso orario.
    const orderMonth = new Date(order_date).getUTCMonth() + 1;

    // Recupera ogni offerta fornitore per l'articolo richiesto, insieme
    // alle percentuali di sconto applicabili per ciascuno dei tre tipi
    // (una subquery per tipo, ognuna prende la percentuale migliore tra
    // le soglie raggiunte). La subquery TOTAL_AMOUNT confronta la soglia
    // con quantity * sa.unit_price (il prezzo pieno, non ancora scontato).
    const queryStr = `
      SELECT
        s.id AS supplier_id,
        s.name AS supplier_name,
        sa.id AS supplier_article_id,
        sa.stock_quantity,
        sa.unit_price,
        sa.delivery_date,
        (SELECT MAX(percentage)
         FROM discounts d
         WHERE d.supplier_article_id = sa.id
           AND d.discount_type = 'QUANTITY'
           AND d.threshold_value <= ?) AS quantity_discount_percentage,
        (SELECT MAX(percentage)
         FROM discounts d
         WHERE d.supplier_article_id = sa.id
           AND d.discount_type = 'TOTAL_AMOUNT'
           AND d.threshold_value <= sa.unit_price * ?) AS total_amount_discount_percentage,
        (SELECT MAX(percentage)
         FROM discounts d
         WHERE d.supplier_article_id = sa.id
           AND d.discount_type = 'MONTH'
           AND d.threshold_value = ?) AS month_discount_percentage
      FROM supplier_articles sa
      JOIN suppliers s ON sa.supplier_id = s.id
      WHERE sa.article_id = ?
    `;

    const [fornitori] = await pool.query(queryStr, [quantity, quantity, orderMonth, article_id]);

    // Per ogni fornitore calcola idoneità (stock + tempistica) e prezzo finale scontato.
    const listaCompleta = fornitori.map((f) => {
      const hasEnoughStock = f.stock_quantity >= quantity;

      const deliveryDateObj = new Date(f.delivery_date);
      const arrivesInTime = deliveryDateObj <= targetDateObj;
      const formattedDeliveryDate = deliveryDateObj.toISOString().split('T')[0];

      const diffTime = Math.abs(deliveryDateObj - new Date(order_date));
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // --- CALCOLO SCONTI ---
      // I tre tipi di sconto si sommano tra loro (vedi JSDoc dell'endpoint).
      const quantityDiscountPct = Number(f.quantity_discount_percentage) || 0;
      const totalAmountDiscountPct = Number(f.total_amount_discount_percentage) || 0;
      const monthDiscountPct = Number(f.month_discount_percentage) || 0;
      const discountPct = quantityDiscountPct + totalAmountDiscountPct + monthDiscountPct;

      const discountTypesApplied = [
        quantityDiscountPct > 0 && 'QUANTITY',
        totalAmountDiscountPct > 0 && 'TOTAL_AMOUNT',
        monthDiscountPct > 0 && 'MONTH'
      ].filter(Boolean);

      const originalTotalPrice = quantity * f.unit_price;
      const unitPriceScontato = f.unit_price * (1 - discountPct / 100);
      const totalPrice = Math.round(quantity * unitPriceScontato * 100) / 100;

      return {
        supplier_id: f.supplier_id,
        supplier_name: f.supplier_name,
        stock_quantity: f.stock_quantity,
        unit_price: f.unit_price, // Prezzo originale
        discounted_unit_price: unitPriceScontato, // Prezzo scontato
        originalTotalPrice: Math.round(originalTotalPrice * 100) / 100,
        totalPrice,
        estimated_delivery_date: formattedDeliveryDate,
        min_shipping_days: diffDays,
        discount_types_applied: discountTypesApplied,
        hasEnoughStock,
        arrivesInTime,
        discount_percentage: discountPct
      };
    });

    // Solo i fornitori idonei (stock sufficiente e consegna entro la deadline)
    // partecipano al confronto "miglior fornitore"; gli altri vengono comunque
    // restituiti al client, ma segnalati come non idonei.
    const idonei = listaCompleta.filter(f => f.hasEnoughStock && f.arrivesInTime);

    if (idonei.length === 0) {
      return res.json({ results: listaCompleta });
    }

    const prezzi = idonei.map(f => f.totalPrice);
    const tempi = idonei.map(f => f.min_shipping_days);

    const prezzoMin = Math.min(...prezzi);
    const prezzoMax = Math.max(...prezzi);
    const tempoMin = Math.min(...tempi);
    const tempoMax = Math.max(...tempi);

    // Normalizza prezzo e tempo di ciascun fornitore idoneo su una scala
    // 0..1 (min-max scaling) e li combina nel punteggio pesato secondo lo
    // slider ricevuto dal client: punteggio più basso = combinazione
    // migliore di prezzo e velocità.
    const idoneiConPunteggio = idonei.map(f => {
      const prezzoNorm = prezzoMax === prezzoMin ? 0 : (f.totalPrice - prezzoMin) / (prezzoMax - prezzoMin);
      const tempoNorm = tempoMax === tempoMin ? 0 : (f.min_shipping_days - tempoMin) / (tempoMax - tempoMin);

      const punteggio = (pesoCosto * prezzoNorm) + (pesoTempo * tempoNorm);

      return {
        ...f,
        punteggio,
        isCheapest: f.totalPrice === prezzoMin,
        isFastest: f.min_shipping_days === tempoMin,
      };
    });

    const migliorPunteggio = Math.min(...idoneiConPunteggio.map(f => f.punteggio));

    // Ricompone la lista completa: i fornitori non idonei restano invariati,
    // quelli idonei vengono arricchiti con punteggio e flag isBestValue.
    const risultatiFinali = listaCompleta.map(f => {
      if (!f.hasEnoughStock || !f.arrivesInTime) return f;
      const trovato = idoneiConPunteggio.find(i => i.supplier_id === f.supplier_id);
      return {
        ...trovato,
        isBestValue: trovato.punteggio === migliorPunteggio
      };
    });

    res.json({ results: risultatiFinali });

  } catch (error) {
    console.error('Errore durante il calcolo:', error);
    res.status(500).json({ error: 'Errore nel calcolo del preventivo' });
  }
});

/**
 * @route POST /api/articles
 * @desc  Crea un nuovo articolo nel catalogo (solo nome e immagine, senza
 *        offerta fornitore). Non è più usato dall'interfaccia principale
 *        — l'inserimento prodotto avviene ora tramite il pannello di
 *        debug (vedi POST /api/debug/add-product-offer), che crea anche
 *        l'offerta fornitore obbligatoria — ma resta disponibile come
 *        endpoint indipendente.
 */
app.post('/api/articles', async (req, res) => {
  const { name, image_url } = req.body;
  try {
    const [result] = await pool.query('INSERT INTO articles (name, image_url) VALUES (?, ?)', [name, image_url]);
    res.json({ success: true, id: result.insertId, name, image_url });
  } catch (error) {
    console.error('Errore inserimento prodotto:', error);
    res.status(500).json({ error: 'Impossibile aggiungere il prodotto' });
  }
});

/**
 * @route GET /api/suppliers
 * @desc  Restituisce l'elenco di tutti i fornitori (id, nome). Usato dal
 *        Catalog (tab Fornitori) e dalla select "Fornitore" del pannello di debug.
 */
app.get('/api/suppliers', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name FROM suppliers');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Errore recupero fornitori' });
  }
});

/**
 * @route GET /api/suppliers/:id/products
 * @desc  Restituisce l'intero assortimento di un fornitore (prodotto,
 *        prezzo, stock, data di consegna). Alimenta la modale
 *        "mini-profilo fornitore" aperta cliccando su un fornitore.
 */
app.get('/api/suppliers/:id/products', async (req, res) => {
  const { id } = req.params;
  try {
    const query = `
      SELECT a.id, a.name, a.image_url, sa.unit_price, sa.stock_quantity, sa.delivery_date 
      FROM supplier_articles sa
      JOIN articles a ON sa.article_id = a.id
      WHERE sa.supplier_id = ?
    `;
    const [rows] = await pool.query(query, [id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Errore recupero prodotti fornitore' });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server attivo sulla porta ${PORT}`);
});

// --- STORICO ORDINI ---
// Tenuto in memoria di processo (non su una tabella del DB): si azzera ad
// ogni riavvio del server e viene svuotato esplicitamente da POST /api/db/reset.
let orderHistoryDB = [];

/**
 * @route GET /api/orders/history
 * @desc  Restituisce lo storico ordini (dal più recente al più vecchio),
 *        usato dalle sezioni History, Insights e Dashboard del frontend.
 */
app.get('/api/orders/history', (req, res) => {
  res.json(orderHistoryDB);
});

/**
 * @route POST /api/orders/checkout
 * @desc  Conferma un ordine: per ogni riga del carrello scala la quantità
 *        in stock del fornitore/articolo corrispondente (in una singola
 *        transazione, con rollback in caso di errore) e salva l'ordine
 *        nello storico in memoria. Il client invia ogni riga già
 *        "arricchita" (nome prodotto/fornitore, prezzo, totale) perché
 *        questo endpoint la registra così com'è, senza ricalcolarla o
 *        validarla lato server.
 * @body  {string} [order_date] data dell'ordine (YYYY-MM-DD); se assente si usa la data odierna
 * @body  {object[]} items      { supplier_id, article_id, article_name, supplier_name, quantity, unit_price, total_price, delivery_date }
 */
app.post('/api/orders/checkout', async (req, res) => {
  const { items, order_date } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Carrello vuoto' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    let totalAmount = 0;
    for (const item of items) {
      totalAmount += Number(item.total_price) || 0;
      // Scaliamo la quantità in giacenza per lo specifico fornitore/articolo
      await connection.query(
        `UPDATE supplier_articles
         SET stock_quantity = GREATEST(0, stock_quantity - ?)
         WHERE supplier_id = ? AND article_id = ?`,
        [item.quantity, item.supplier_id, item.article_id]
      );
    }

    await connection.commit();

    const newOrder = {
      id: 1000 + orderHistoryDB.length + 1,
      order_date: order_date || new Date().toISOString().split('T')[0],
      total_amount: Math.round(totalAmount * 100) / 100,
      items
    };
    orderHistoryDB.unshift(newOrder);

    res.json({ success: true, message: 'Ordine inviato con successo! Stock aggiornato.' });
  } catch (error) {
    await connection.rollback();
    console.error('Errore checkout:', error);
    res.status(500).json({ error: 'Errore durante l\'elaborazione dell\'ordine.' });
  } finally {
    connection.release();
  }
});

/**
 * @route POST /api/debug/add-product-offer
 * @desc  Endpoint di supporto al testing (pannello "Account & Debug
 *        Tools" del frontend): crea in un'unica transazione un nuovo
 *        articolo, la sua prima offerta presso un fornitore e,
 *        opzionalmente, lo sconto associato. La data di consegna
 *        dell'offerta è impostata forfettariamente a 5 giorni da oggi.
 * @body  {string}  name                nome del nuovo articolo
 * @body  {string}  image_url           URL dell'immagine del prodotto
 * @body  {number}  supplier_id         fornitore che offre il prodotto
 * @body  {number}  unit_price          prezzo unitario dell'offerta
 * @body  {number}  stock_quantity      quantità disponibile
 * @body  {boolean} has_discount        se true, crea anche una riga in `discounts`
 * @body  {string}  [discount_type]     'QUANTITY' | 'TOTAL_AMOUNT' | 'MONTH' (valori dell'ENUM discounts.discount_type; solo 'QUANTITY' è al momento considerato dal calcolo preventivo)
 * @body  {number}  [discount_threshold] soglia oltre la quale lo sconto si applica
 * @body  {number}  [discount_percentage] percentuale di sconto
 */
app.post('/api/debug/add-product-offer', async (req, res) => {
  const {
    name, image_url, supplier_id, unit_price, stock_quantity,
    has_discount, discount_type, discount_threshold, discount_percentage
  } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Inserisci Articolo
    const [artRes] = await connection.query(
      'INSERT INTO articles (name, image_url) VALUES (?, ?)',
      [name, image_url]
    );
    const articleId = artRes.insertId;

    // 2. Inserisci Offerta Fornitore (Data consegna standard +5gg)
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    const deliveryDate = futureDate.toISOString().split('T')[0];

    const [saRes] = await connection.query(
      `INSERT INTO supplier_articles (supplier_id, article_id, stock_quantity, unit_price, delivery_date)
       VALUES (?, ?, ?, ?, ?)`,
      [supplier_id, articleId, stock_quantity, unit_price, deliveryDate]
    );
    const supplierArticleId = saRes.insertId;

    // 3. Inserisci Sconto se abilitato
    if (has_discount) {
      await connection.query(
        `INSERT INTO discounts (supplier_article_id, discount_type, threshold_value, percentage)
         VALUES (?, ?, ?, ?)`,
        [supplierArticleId, discount_type, discount_threshold, discount_percentage]
      );
    }

    await connection.commit();
    res.json({ success: true, message: 'Prodotto e offerta salvati correttamente!' });
  } catch (error) {
    await connection.rollback();
    console.error('Errore debug add product:', error);
    res.status(500).json({ error: 'Errore inserimento debug' });
  } finally {
    connection.release();
  }
});

/**
 * @route POST /api/db/reset
 * @desc  Strumento di test (sezione Settings del frontend): svuota le
 *        tabelle del catalogo (discounts, supplier_articles, suppliers,
 *        articles), riporta gli AUTO_INCREMENT a 1 e le ripopola con i
 *        dati di esempio iniziali. Azzera anche lo storico ordini in
 *        memoria (`orderHistoryDB`), che altrimenti farebbe riferimento a
 *        stock/prezzi non più coerenti con i dati appena ripristinati.
 *        Operazione distruttiva e irreversibile: il client richiede
 *        conferma esplicita all'utente prima di chiamarla.
 */
app.post('/api/db/reset', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.query('DELETE FROM discounts');
    await connection.query('DELETE FROM supplier_articles');
    await connection.query('DELETE FROM suppliers');
    await connection.query('DELETE FROM articles');

    await connection.query('ALTER TABLE discounts AUTO_INCREMENT = 1');
    await connection.query('ALTER TABLE supplier_articles AUTO_INCREMENT = 1');
    await connection.query('ALTER TABLE suppliers AUTO_INCREMENT = 1');
    await connection.query('ALTER TABLE articles AUTO_INCREMENT = 1');

    // Ri-popolamento articoli
    await connection.query(`
      INSERT INTO articles (id, name, image_url) VALUES 
      (1, 'Carta A4 Multiuso 80g (Box 5 Risme)', 'https://images.unsplash.com/photo-1586075010923-2dd4570fb338?q=80&w=400&auto=format&fit=crop'),
      (2, 'Penne a Sfera Nere (Box 50 pz)', 'https://images.unsplash.com/photo-1585336261022-680e295ce3fe?q=80&w=400&auto=format&fit=crop'),
      (3, 'Cartucce Toner Stampante (Nero)', 'https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?q=80&w=400&auto=format&fit=crop'),
      (4, 'Nastro Adesivo Imballaggio (Pack 6)', 'https://images.unsplash.com/photo-1606041011872-59659ceb7563?q=80&w=400&auto=format&fit=crop'),
      (5, 'Scatole di Cartone 50x50x50 (50 pz)', 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?q=80&w=400&auto=format&fit=crop'),
      (6, 'Caffè in Grani Espresso (1kg)', 'https://images.unsplash.com/photo-1559525839-b184a4d698c7?q=80&w=400&auto=format&fit=crop'),
      (7, 'Bicchieri di Carta Biodegradabili (1000 pz)', 'https://images.unsplash.com/photo-1611091599351-460d3d2543e3?q=80&w=400&auto=format&fit=crop'),
      (8, 'Detergente Pavimenti Industriale (5 Litri)', 'https://images.unsplash.com/photo-1584820927508-0136fbbf5c7a?q=80&w=400&auto=format&fit=crop'),
      (9, 'Carta Igienica 3 Veli (Pack 48 Rotoli)', 'https://images.unsplash.com/photo-1584556812952-905ffd0c611a?q=80&w=400&auto=format&fit=crop'),
      (10, 'Sedia da Ufficio Ergonomica', 'https://images.unsplash.com/photo-1505843490538-5133c6c7d0e1?q=80&w=400&auto=format&fit=crop'),
      (11, 'Monitor 27 Pollici 4K', 'https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?q=80&w=400&auto=format&fit=crop')
    `);

    // Ri-popolamento sconti di default. Le ultime due righe (supplier_article_id 5,
    // FlashShip 24h su "Carta A4") ricreano l'esempio della consegna originale:
    // 5% per ordini oltre 1000€ + 2% aggiuntivo per ordini a settembre, sconti
    // che si sommano tra loro (vedi POST /api/orders/calculate).
    await connection.query(`
      INSERT INTO discounts (supplier_article_id, discount_type, threshold_value, percentage) VALUES
      (1, 'QUANTITY', 50, 5.00),
      (1, 'QUANTITY', 100, 10.00),
      (2, 'QUANTITY', 150, 15.00),
      (3, 'QUANTITY', 50, 8.00),
      (4, 'QUANTITY', 200, 20.00),
      (5, 'TOTAL_AMOUNT', 1000, 5.00),
      (5, 'MONTH', 9, 2.00)
    `);
    // Ri-popolamento fornitori
    await connection.query(`
      INSERT INTO suppliers (id, name) VALUES 
      (1, 'EcoSaver Supply'), (2, 'SmartBudget Trade'), (3, 'Balanced Logistics'), (4, 'Express Delivery Co.'), (5, 'FlashShip 24h')
    `);

    // Ri-popolamento offerte
    await connection.query(`
      INSERT INTO supplier_articles (supplier_id, article_id, stock_quantity, unit_price, delivery_date) VALUES 
      (1, 1, 500, 11.50, '2025-09-25'), (2, 1, 350, 14.80, '2025-09-18'), (3, 1, 400, 18.50, '2025-09-10'), (4, 1, 200, 25.00, '2025-09-07'), (5, 1, 150, 33.00, '2025-09-06'),
      (1, 2, 500, 3.00, '2025-09-25'), (2, 2, 350, 4.00, '2025-09-18'), (3, 2, 400, 5.00, '2025-09-10'), (4, 2, 200, 6.75, '2025-09-07'), (5, 2, 150, 9.00, '2025-09-06'),
      (1, 3, 500, 27.00, '2025-09-25'), (2, 3, 350, 36.00, '2025-09-18'), (3, 3, 400, 45.00, '2025-09-10'), (4, 3, 200, 60.00, '2025-09-07'), (5, 3, 150, 81.00, '2025-09-06'),
      (1, 4, 500, 7.20, '2025-09-25'), (2, 4, 350, 9.60, '2025-09-18'), (3, 4, 400, 12.00, '2025-09-10'), (4, 4, 200, 16.20, '2025-09-07'), (5, 4, 150, 21.60, '2025-09-06'),
      (1, 5, 500, 18.00, '2025-09-25'), (2, 5, 350, 24.00, '2025-09-18'), (3, 5, 400, 30.00, '2025-09-10'), (4, 5, 200, 40.50, '2025-09-07'), (5, 5, 150, 54.00, '2025-09-06'),
      (1, 6, 500, 9.00, '2025-09-25'), (2, 6, 350, 12.00, '2025-09-18'), (3, 6, 400, 15.00, '2025-09-10'), (4, 6, 200, 20.25, '2025-09-07'), (5, 6, 150, 27.00, '2025-09-06'),
      (1, 7, 500, 15.00, '2025-09-25'), (2, 7, 350, 20.00, '2025-09-18'), (3, 7, 400, 25.00, '2025-09-10'), (4, 7, 200, 33.75, '2025-09-07'), (5, 7, 150, 45.00, '2025-09-06'),
      (1, 8, 500, 4.80, '2025-09-25'), (2, 8, 350, 6.40, '2025-09-18'), (3, 8, 400, 8.00, '2025-09-10'), (4, 8, 200, 10.80, '2025-09-07'), (5, 8, 150, 14.40, '2025-09-06'),
      (1, 9, 500, 10.80, '2025-09-25'), (2, 9, 350, 14.40, '2025-09-18'), (3, 9, 400, 18.00, '2025-09-10'), (4, 9, 200, 24.30, '2025-09-07'), (5, 9, 150, 32.40, '2025-09-06'),
      (1, 10, 50, 72.00, '2025-09-25'), (2, 10, 40, 96.00, '2025-09-18'), (3, 10, 30, 120.00, '2025-09-10'), (4, 10, 15, 162.00, '2025-09-07'), (5, 10, 2, 216.00, '2025-09-06'),
      (1, 11, 20, 120.00, '2025-09-25'), (2, 11, 15, 160.00, '2025-09-18'), (3, 11, 25, 200.00, '2025-09-10'), (4, 11, 10, 270.00, '2025-09-07'), (5, 11, 5, 360.00, '2025-09-06')
    `);

    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    orderHistoryDB = [];
    res.json({ success: true, message: 'Database resettato e ripristinato con successo!' });
  } catch (error) {
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    console.error('Errore reset DB:', error);
    res.status(500).json({ error: 'Impossibile resettare il database.' });
  } finally {
    connection.release();
  }
});