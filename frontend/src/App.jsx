import { useState, useEffect, useMemo } from 'react';
import './App.css';

/**
 * App — componente radice dell'applicazione "Purchase Orders for Stock Replenishment".
 *
 * Gestisce, in un unico componente, tutte le sezioni della SPA (Single Page
 * Application) raggiungibili dalla sidebar:
 *  - Orders:     ricerca di un articolo, calcolo del preventivo di acquisto
 *                confrontando più fornitori (prezzo, sconti, tempi di
 *                consegna) e gestione del carrello/checkout.
 *  - Catalog:    catalogo prodotti e fornitori.
 *  - History:    storico degli ordini già confermati.
 *  - Insights:   analisi dei prodotti più acquistati, con riordino rapido.
 *  - Settings:   preferenze (dark mode) e strumenti di reset del database.
 *  - Account:    pannello di debug per inserire manualmente un prodotto,
 *                un'offerta fornitore e uno sconto (utile per i test).
 *
 * Non essendo un progetto con più route, non viene usato un router: la
 * navigazione tra sezioni è gestita interamente con lo stato locale
 * `activeNav`. Tutte le chiamate API sono dirette al backend Express in
 * ascolto su `http://localhost:5000` (vedi `backend/server.js`).
 */
export default function App() {
  // ---------------------------------------------------------------------
  // STATO: form di calcolo preventivo (sezione "Orders")
  // ---------------------------------------------------------------------
  const [articles, setArticles] = useState([]); // catalogo completo degli articoli disponibili
  const [searchTerm, setSearchTerm] = useState(''); // filtro testuale sulla select "Seleziona Prodotto"
  const [selectedArticle, setSelectedArticle] = useState(''); // id dell'articolo attualmente selezionato
  const [quantity, setQuantity] = useState(12); // quantità richiesta dall'utente
  const [orderDate, setOrderDate] = useState('2025-09-05'); // data in cui si effettua l'ordine (usata anche per gli sconti stagionali e per i giorni di spedizione)
  const [targetDate, setTargetDate] = useState('2025-09-10'); // data entro cui l'ordine deve arrivare (deadline)
  const [sliderPosition, setSliderPosition] = useState(3); // 1..5, bilanciamento tra "risparmio" e "velocità" nel punteggio dei fornitori
  const [results, setResults] = useState(null); // risultato dell'ultima chiamata a /api/orders/calculate
  const [loading, setLoading] = useState(false); // true mentre è in corso il calcolo del preventivo
  const [showAdvanced, setShowAdvanced] = useState(false); // mostra/nasconde lo slider delle preferenze avanzate

  // ---------------------------------------------------------------------
  // STATO: navigazione, tema e carrello
  // ---------------------------------------------------------------------
  const [activeNav, setActiveNav] = useState('Orders'); // sezione attualmente visibile nella sidebar
  const [isDarkMode, setIsDarkMode] = useState(false); // toggle dark mode (Settings)
  const [cart, setCart] = useState([]); // articoli aggiunti al carrello, pronti per il checkout
  const [showCartModal, setShowCartModal] = useState(false); // visibilità della modale "Il Tuo Carrello"
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false); // true durante la chiamata di checkout

  // ---------------------------------------------------------------------
  // STATO: modale "dettaglio fornitori" aperta da un articolo del Catalog
  // ---------------------------------------------------------------------
  const [selectedCatalogItem, setSelectedCatalogItem] = useState(null); // articolo del catalogo selezionato
  const [catalogSuppliers, setCatalogSuppliers] = useState([]); // fornitori disponibili per quell'articolo
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);

  // Popup di acquisto rapido: aperto cliccando su un'offerta fornitore
  // dentro la modale "Fornitori e Stock Disponibile" del Catalog.
  const [quickBuyOffer, setQuickBuyOffer] = useState(null); // offerta fornitore selezionata (o null se il popup è chiuso)
  const [quickBuyQuantity, setQuickBuyQuantity] = useState(1);

  const [toast, setToast] = useState(null); // messaggio della notifica toast in basso a destra (null = nascosta)

  // ---------------------------------------------------------------------
  // STATO: Catalog (tab Prodotti/Fornitori) e mini-profilo fornitore
  // ---------------------------------------------------------------------
  const [catalogView, setCatalogView] = useState('products'); // 'products' | 'suppliers'
  const [suppliersList, setSuppliersList] = useState([]); // elenco di tutti i fornitori
  const [selectedSupplierProfile, setSelectedSupplierProfile] = useState(null); // fornitore selezionato + suo assortimento prodotti
  const [supplierProductsLoading, setSupplierProductsLoading] = useState(false);

  // ---------------------------------------------------------------------
  // STATO: History — storico degli ordini confermati
  // ---------------------------------------------------------------------
  const [orderHistory, setOrderHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ---------------------------------------------------------------------
  // STATO: Insights — quantità modificabile per ogni prodotto suggerito
  // (mappa articleId -> valore digitato nell'input, default 1)
  // ---------------------------------------------------------------------
  const [insightQuantities, setInsightQuantities] = useState({});

  // ---------------------------------------------------------------------
  // STATO: Account / pannello di debugging (aperto cliccando sull'utente
  // in basso a sinistra nella sidebar). Permette di inserire manualmente
  // un nuovo prodotto insieme alla sua prima offerta fornitore e,
  // opzionalmente, a uno sconto associato.
  // ---------------------------------------------------------------------
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [debugName, setDebugName] = useState('');
  const [debugImageUrl, setDebugImageUrl] = useState('');
  const [debugSupplierId, setDebugSupplierId] = useState('');
  const [debugUnitPrice, setDebugUnitPrice] = useState('');
  const [debugStock, setDebugStock] = useState('');
  const [debugHasDiscount, setDebugHasDiscount] = useState(false);
  const [debugDiscountType, setDebugDiscountType] = useState('QUANTITY'); // valori ammessi dall'ENUM discounts.discount_type: 'QUANTITY' | 'TOTAL_AMOUNT' | 'MONTH'
  const [debugThreshold, setDebugThreshold] = useState('');
  const [debugPercentage, setDebugPercentage] = useState('');
  const [isSavingDebug, setIsSavingDebug] = useState(false);

  /** Recupera l'elenco completo dei fornitori (usato dal Catalog e dal form di debug). */
  const loadSuppliersList = async () => {
    try {
      const res = await fetch('http://localhost:5000/api/suppliers');
      const data = await res.json();
      setSuppliersList(data);
    } catch (err) { console.error(err); }
  };

  /**
   * Apre la modale "mini-profilo fornitore" mostrando tutti i prodotti
   * venduti da quel fornitore. Chiamata sia dal Catalog (tab Fornitori)
   * sia cliccando sul nome del fornitore in una vendor-card degli Orders.
   */
  const openSupplierProfile = async (supplierId, supplierName) => {
    setSelectedSupplierProfile({ id: supplierId, name: supplierName, products: [] });
    setSupplierProductsLoading(true);
    try {
      const res = await fetch(`http://localhost:5000/api/suppliers/${supplierId}/products`);
      const data = await res.json();
      setSelectedSupplierProfile({ id: supplierId, name: supplierName, products: data });
    } catch (err) { console.error(err); } 
    finally { setSupplierProductsLoading(false); }
  };

  /**
   * Recupera lo storico ordini dal backend (GET /api/orders/history).
   * Alimenta sia la sezione History sia i calcoli di Insights/Dashboard
   * (tramite la memo `productInsights`). Da richiamare ogni volta che lo
   * storico può essere cambiato: al mount, dopo un checkout e dopo un
   * reset del database.
   */
  const loadOrderHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('http://localhost:5000/api/orders/history');
      const data = await res.json();
      setOrderHistory(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Errore caricamento storico ordini:', err);
    } finally {
      setHistoryLoading(false);
    }
  };

  /** Riporta il form del pannello di debug (Account) ai valori iniziali. */
  const resetDebugForm = () => {
    setDebugName('');
    setDebugImageUrl('');
    setDebugSupplierId('');
    setDebugUnitPrice('');
    setDebugStock('');
    setDebugHasDiscount(false);
    setDebugDiscountType('QUANTITY');
    setDebugThreshold('');
    setDebugPercentage('');
  };

  /**
   * Invia il form del pannello di debug (Account) a
   * POST /api/debug/add-product-offer: crea in un'unica transazione un
   * nuovo articolo, la relativa offerta del fornitore selezionato e,
   * se richiesto, lo sconto associato. Fornitore, prezzo e stock sono
   * sempre obbligatori; se il checkbox "sconto" è attivo diventano
   * obbligatori anche tipo, soglia e percentuale dello sconto.
   */
  const handleDebugSubmit = async (e) => {
    e.preventDefault();
    if (debugHasDiscount && (!debugDiscountType || debugThreshold === '' || debugPercentage === '')) {
      alert('Completa tipo, soglia e percentuale dello sconto, oppure disattiva il check.');
      return;
    }
    setIsSavingDebug(true);
    try {
      const res = await fetch('http://localhost:5000/api/debug/add-product-offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: debugName,
          image_url: debugImageUrl,
          supplier_id: Number(debugSupplierId),
          unit_price: Number(debugUnitPrice),
          stock_quantity: Number(debugStock),
          has_discount: debugHasDiscount,
          discount_type: debugHasDiscount ? debugDiscountType : null,
          discount_threshold: debugHasDiscount ? Number(debugThreshold) : null,
          discount_percentage: debugHasDiscount ? Number(debugPercentage) : null
        })
      });
      const data = await res.json();
      if (res.ok) {
        setToast(`✅ "${debugName}" aggiunto con l'offerta del fornitore!`);
        setTimeout(() => setToast(null), 3000);
        resetDebugForm();
        loadArticles();
      } else {
        alert(`Errore: ${data.error}`);
      }
    } catch (err) {
      console.error('Errore debug add product:', err);
      alert("Errore durante l'inserimento di debug.");
    } finally {
      setIsSavingDebug(false);
    }
  };

  /**
   * Recupera il catalogo articoli (GET /api/articles) e, se non è ancora
   * stato selezionato nulla, preseleziona il primo articolo della lista
   * così che il form "Nuova Selezione Prodotto" sia subito utilizzabile.
   */
  const loadArticles = () => {
    fetch('http://localhost:5000/api/articles')
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setArticles(data);
          if (data.length > 0 && !selectedArticle) setSelectedArticle(data[0].id);
        }
      })
      .catch((err) => console.error('Errore caricamento articoli:', err));
  };

  // Caricamento iniziale dei dati necessari a tutte le sezioni dell'app.
  useEffect(() => {
    loadArticles();
    loadSuppliersList();
    loadOrderHistory();
  }, []);

  /**
   * Chiama POST /api/orders/calculate per ottenere, per l'articolo e la
   * quantità selezionati, l'elenco dei fornitori con relativo prezzo
   * (scontato se applicabile), disponibilità di stock e data di consegna
   * stimata. `positionToUse` è la posizione dello slider "Preferenze"
   * (1 = tutto sul risparmio, 5 = tutto sulla velocità di consegna) e
   * viene passata esplicitamente perché lo slider può richiamare questa
   * funzione prima che lo stato React si sia aggiornato.
   */
  const fetchResults = async (positionToUse = sliderPosition) => {
    setLoading(true);
    try {
      const response = await fetch('http://localhost:5000/api/orders/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_id: Number(selectedArticle),
          quantity: Number(quantity),
          order_date: orderDate,
          target_date: targetDate,
          slider_position: Number(positionToUse)
        })
      });
      const data = await response.json();
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch (error) {
      console.error('Errore calcolo preventivo:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  /** Submit del form "Nuova Selezione Prodotto": avvia il calcolo dei preventivi. */
  const handleCalculate = (e) => {
    e.preventDefault();
    fetchResults(sliderPosition);
  };

  /**
   * Aggiunge al carrello l'offerta di un fornitore scelta dall'utente tra
   * i risultati del preventivo. Applica il prezzo scontato quando
   * disponibile e genera un `cart_id` univoco lato client (non è l'id di
   * un record del backend, serve solo per identificare la riga nel
   * carrello e poterla rimuovere).
   */
  const addToCart = (vendorOffer) => {
    const article = articles.find((a) => a.id === Number(selectedArticle));
    const articleName = article ? article.name : 'Prodotto';
    
    const finalUnitPrice = vendorOffer.discount_percentage > 0 
      ? vendorOffer.discounted_unit_price 
      : vendorOffer.unit_price;

    const newItem = {
      cart_id: Date.now() + Math.random(),
      article_id: Number(selectedArticle),
      article_name: articleName,
      supplier_id: vendorOffer.supplier_id,
      supplier_name: vendorOffer.supplier_name,
      unit_price: finalUnitPrice, 
      quantity: Number(quantity),
      total_price: Number(vendorOffer.totalPrice), 
      delivery_date: vendorOffer.estimated_delivery_date
    };

    setToast(`🛒 ${articleName} aggiunto al carrello!`);
    setTimeout(() => setToast(null), 3000);
    setCart((prevCart) => [...prevCart, newItem]);
  };

  /** Rimuove una riga dal carrello dato il suo `cart_id` locale. */
  const removeFromCart = (cartId) => {
    setCart((prevCart) => prevCart.filter((item) => item.cart_id !== cartId));
  };

  /**
   * Conferma l'ordine: invia l'intero carrello a
   * POST /api/orders/checkout. Il backend scala lo stock di ogni
   * fornitore/articolo e salva l'ordine nello storico in memoria, perciò
   * ogni riga del carrello viene inviata già "arricchita" con nome
   * prodotto, nome fornitore, prezzo unitario e totale: altrimenti lo
   * storico (History/Insights) non avrebbe questi dati da mostrare.
   * Al successo svuota il carrello, chiude la modale e ricarica sia i
   * risultati del preventivo corrente (lo stock potrebbe essere cambiato)
   * sia lo storico ordini.
   */
  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setIsSubmittingOrder(true);
    try {
      const res = await fetch('http://localhost:5000/api/orders/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_date: orderDate,
          items: cart.map(i => ({
            supplier_id: i.supplier_id,
            article_id: i.article_id,
            article_name: i.article_name,
            supplier_name: i.supplier_name,
            quantity: i.quantity,
            unit_price: i.unit_price,
            total_price: i.total_price,
            delivery_date: i.delivery_date
          }))
        })
      });

      const data = await res.json();
      if (res.ok) {
        alert('🎉 Ordine inviato con successo! Lo stock a database è stato aggiornato.');
        setCart([]);
        setShowCartModal(false);
        if (results) fetchResults(sliderPosition);
        loadOrderHistory();
      } else {
        alert(`Errore: ${data.error}`);
      }
    } catch (err) {
      console.error('Errore invio ordine:', err);
      alert('Si è verificato un errore durante l\'invio dell\'ordine.');
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  /**
   * Strumento di test (sezione Settings): chiama POST /api/db/reset per
   * svuotare e ripopolare il database con i dati di partenza (articoli,
   * fornitori, offerte e sconti di esempio) e azzera anche lo storico
   * ordini lato backend. Richiede conferma esplicita perché è
   * un'operazione distruttiva e irreversibile.
   */
  const handleResetDatabase = async () => {
    if (!window.confirm('Sei sicuro di voler resettare il database alle condizioni iniziali?')) return;
    try {
      const res = await fetch('http://localhost:5000/api/db/reset', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        alert(data.message);
        setCart([]);
        setResults(null);
        loadArticles();
        loadSuppliersList();
        loadOrderHistory();
      } else {
        alert(`Errore: ${data.error}`);
      }
    } catch (err) {
      console.error('Errore reset DB:', err);
      alert('Impossibile resettare il database.');
    }
  };

  /**
   * Apre la modale "Fornitori e Stock Disponibile" per un articolo del
   * Catalog, recuperando via GET /api/articles/:id/suppliers l'elenco dei
   * fornitori che lo vendono (ordinato per prezzo crescente lato backend).
   */
  const openCatalogModal = async (article) => {
    setSelectedCatalogItem(article);
    setLoadingSuppliers(true);
    try {
      const res = await fetch(`http://localhost:5000/api/articles/${article.id}/suppliers`);
      const data = await res.json();
      setCatalogSuppliers(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Errore caricamento fornitori:', error);
      setCatalogSuppliers([]);
    } finally {
      setLoadingSuppliers(false);
    }
  };

  const closeCatalogModal = () => {
    setSelectedCatalogItem(null);
    setCatalogSuppliers([]);
    setQuickBuyOffer(null); // chiude anche l'eventuale popup di acquisto rapido ancora aperto
  };

  const closeSupplierProfile = () => {
    setSelectedSupplierProfile(null);
    setQuickBuyOffer(null); // chiude anche l'eventuale popup di acquisto rapido ancora aperto
  };

  /**
   * Apre il popup di acquisto rapido. `offer` è un oggetto autonomo con
   * sia i dati dell'articolo sia quelli dell'offerta fornitore
   * ({ article_id, article_name, article_image_url, supplier_id,
   * supplier_name, unit_price, stock_quantity, delivery_date }), così il
   * popup funziona identico sia partendo da un prodotto del Catalog
   * (dove si sceglie il fornitore) sia partendo dal profilo di un
   * fornitore (dove si sceglie il prodotto) — stessa funzionalità, punto
   * di ingresso opposto.
   */
  const openQuickBuy = (offer) => {
    setQuickBuyOffer(offer);
    setQuickBuyQuantity(1);
  };

  const closeQuickBuy = () => setQuickBuyOffer(null);

  /**
   * Conferma l'acquisto rapido: aggiunge al carrello l'offerta selezionata
   * per la quantità scelta, senza passare dal form di calcolo preventivo
   * degli Orders (quindi senza applicare eventuali sconti, come per il
   * riordino rapido di Insights). La quantità viene comunque limitata
   * allo stock disponibile per quell'offerta.
   */
  const confirmQuickBuy = () => {
    if (!quickBuyOffer) return;
    const maxQty = Number(quickBuyOffer.stock_quantity) || 1;
    const qty = Math.min(Math.max(1, Number(quickBuyQuantity) || 1), maxQty);
    const unitPrice = Number(quickBuyOffer.unit_price) || 0;

    const newItem = {
      cart_id: Date.now() + Math.random(),
      article_id: quickBuyOffer.article_id,
      article_name: quickBuyOffer.article_name,
      supplier_id: quickBuyOffer.supplier_id,
      supplier_name: quickBuyOffer.supplier_name,
      unit_price: unitPrice,
      quantity: qty,
      total_price: Math.round(unitPrice * qty * 100) / 100,
      delivery_date: quickBuyOffer.delivery_date
    };

    setCart((prev) => [...prev, newItem]);
    setToast(`🛒 ${quickBuyOffer.article_name} aggiunto al carrello!`);
    setTimeout(() => setToast(null), 3000);
    closeQuickBuy();
  };

  // ---------------------------------------------------------------------
  // VALORI DERIVATI (calcolati ad ogni render a partire dallo stato sopra)
  // ---------------------------------------------------------------------

  // Articoli filtrati in base al testo digitato nel campo "Cerca Prodotto".
  const filteredArticles = articles.filter((art) =>
    art.name.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const currentArticleObj = articles.find((a) => a.id === Number(selectedArticle));
  const cartTotal = cart.reduce((sum, item) => sum + item.total_price, 0);

  // Etichette leggibili per le 5 posizioni dello slider "Preferenze".
  const sliderLabels = { 1: '100% Economico', 2: 'Prevalenza Prezzo', 3: 'Bilanciato', 4: 'Prevalenza Velocità', 5: '100% Velocità' };

  /** Converte una data in formato ISO (YYYY-MM-DD) in formato italiano (DD/MM/YYYY). */
  const formatDate = (dateString) => {
    if (!dateString) return '';
    const parts = dateString.split('-');
    if (parts.length !== 3) return dateString;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  };

  /**
   * Aggrega lo storico ordini per articolo, calcolando per ciascun
   * prodotto la quantità totale acquistata, il numero di ordini in cui
   * compare e i dati dell'acquisto più recente (fornitore e prezzo
   * unitario), usati come default per un riordino rapido da Dashboard e
   * Insights. Il risultato è ordinato dal prodotto più acquistato al meno
   * acquistato. Viene ricalcolato solo quando `orderHistory` cambia.
   */
  const productInsights = useMemo(() => {
    const map = {};
    orderHistory.forEach((order) => {
      (order.items || []).forEach((item) => {
        const key = item.article_id;
        if (!map[key]) {
          map[key] = {
            article_id: item.article_id,
            article_name: item.article_name,
            totalQuantity: 0,
            timesOrdered: 0,
            lastSupplierId: item.supplier_id,
            lastSupplierName: item.supplier_name,
            lastUnitPrice: item.unit_price,
            lastOrderDate: order.order_date
          };
        }
        map[key].totalQuantity += Number(item.quantity) || 0;
        map[key].timesOrdered += 1;
        if (!map[key].lastOrderDate || order.order_date >= map[key].lastOrderDate) {
          map[key].lastOrderDate = order.order_date;
          map[key].lastSupplierId = item.supplier_id;
          map[key].lastSupplierName = item.supplier_name;
          map[key].lastUnitPrice = item.unit_price;
        }
      });
    });
    return Object.values(map).sort((a, b) => b.totalQuantity - a.totalQuantity);
  }, [orderHistory]);

  // Quantità del prodotto più acquistato: usata per normalizzare le barre
  // di ampiezza in Insights (percentuale rispetto al massimo).
  const maxInsightQuantity = productInsights.length > 0 ? productInsights[0].totalQuantity : 0;

  /** Aggiorna la quantità digitata per un singolo prodotto in Insights/Dashboard. */
  const setInsightQty = (articleId, value) => {
    setInsightQuantities((prev) => ({ ...prev, [articleId]: value }));
  };

  /**
   * Riordino rapido da Insights/Dashboard: aggiunge al carrello un
   * prodotto già acquistato in passato, riutilizzando fornitore e prezzo
   * unitario dell'ultimo ordine registrato per quell'articolo (nessuna
   * nuova chiamata a /api/orders/calculate: è un raccorciamento pensato
   * per il riacquisto veloce, non un preventivo aggiornato).
   */
  const addInsightToCart = (insight) => {
    const qty = Math.max(1, Number(insightQuantities[insight.article_id]) || 1);
    const unitPrice = Number(insight.lastUnitPrice) || 0;
    const newItem = {
      cart_id: Date.now() + Math.random(),
      article_id: insight.article_id,
      article_name: insight.article_name,
      supplier_id: insight.lastSupplierId,
      supplier_name: insight.lastSupplierName,
      unit_price: unitPrice,
      quantity: qty,
      total_price: Math.round(unitPrice * qty * 100) / 100,
      delivery_date: null
    };
    setCart((prev) => [...prev, newItem]);
    setToast(`🛒 ${insight.article_name} aggiunto al carrello!`);
    setTimeout(() => setToast(null), 3000);
  };

  /**
   * "Ripeti Ordine" da History: aggiunge al carrello tutte le righe di un
   * ordine passato, stessi articoli/fornitori/prezzi e stesse quantità,
   * senza ricalcolare nulla (come per il riordino rapido di Insights e
   * l'acquisto rapido dal Catalog).
   */
  const repeatOrder = (order) => {
    const repeatedItems = order.items.map((item) => ({
      ...item,
      cart_id: Date.now() + Math.random()
    }));
    setCart((prev) => [...prev, ...repeatedItems]);
    setToast(`🛒 Ordine #${order.id} aggiunto al carrello (${repeatedItems.length} articoli)!`);
    setTimeout(() => setToast(null), 3000);
  };

  // Ordina i risultati del preventivo: prima i fornitori idonei (stock
  // sufficiente e consegna entro la deadline), poi tra questi prima quello
  // "Best Value" calcolato dal backend, quindi il più economico e infine
  // il più veloce — a parità mantiene l'ordine restituito dall'API.
  const sortedResults = Array.isArray(results) ? [...results].sort((a, b) => {
    const aIdoneo = a.hasEnoughStock && a.arrivesInTime;
    const bIdoneo = b.hasEnoughStock && b.arrivesInTime;
    if (!aIdoneo && bIdoneo) return 1;
    if (aIdoneo && !bIdoneo) return -1;
    const scoreA = (a.isBestValue ? 3 : 0) + (a.isCheapest ? 2 : 0) + (a.isFastest ? 1 : 0);
    const scoreB = (b.isBestValue ? 3 : 0) + (b.isCheapest ? 2 : 0) + (b.isFastest ? 1 : 0);
    return scoreB - scoreA;
  }) : null;

  return (
    <div className={`orderco-layout ${isDarkMode ? 'dark-mode' : ''}`}>
      {/* ================= SIDEBAR: navigazione principale + accesso al pannello di debug ================= */}
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-logo">Ziorder</span></div>
        <nav className="sidebar-nav">
          <button className={`nav-item ${activeNav === 'Dashboard' ? 'active' : ''}`} onClick={() => setActiveNav('Dashboard')}><span className="nav-icon">🏠</span> Dashboard</button>
          <button className={`nav-item ${activeNav === 'Catalog' ? 'active' : ''}`} onClick={() => setActiveNav('Catalog')}><span className="nav-icon">📦</span> Catalog</button>
          <button className={`nav-item ${activeNav === 'Orders' ? 'active' : ''}`} onClick={() => setActiveNav('Orders')}><span className="nav-icon">🛍️</span> Orders</button>
          <button className={`nav-item ${activeNav === 'History' ? 'active' : ''}`} onClick={() => setActiveNav('History')}><span className="nav-icon">🕘</span> History</button>
          <button className={`nav-item ${activeNav === 'Insights' ? 'active' : ''}`} onClick={() => setActiveNav('Insights')}><span className="nav-icon">📈</span> Insights</button>
          <button className={`nav-item ${activeNav === 'Settings' ? 'active' : ''}`} onClick={() => setActiveNav('Settings')}><span className="nav-icon">⚙️</span> Settings</button>
        </nav>
        <div className="sidebar-user clickable-user" onClick={() => setShowAccountModal(true)} title="Apri pannello di debugging">
          <div className="user-avatar">👤</div>
          <div className="user-info-text">
            
            <span className="user-role">Debug & Admin</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        {/* ================= ORDERS: ricerca prodotto, calcolo preventivo e confronto fornitori ================= */}
        {activeNav === 'Orders' && (
          <>
            <header className="page-header">
              <div className="header-left">
                <h1>Order details</h1>
                <span className="order-badge">Order #446645</span>
              </div>
            </header>

            <div className="orders-sticky-bar">
              <div className="summary-card">
                <h3>Summary</h3>
                <div className="summary-grid">
                  <div className="summary-col"><span className="summary-label">ORDERED BY</span><span className="summary-value">Logistica Italia</span></div>
                  <div className="summary-col"><span className="summary-label">LOCATION</span><span className="summary-value">Magazzino Centrale</span></div>
                  <div className="summary-col">
                    <span className="summary-label">TOTAL CARRELLO</span>
                    <span className="summary-value highlight">${cartTotal.toFixed(2)}</span>
                  </div>
                  <div className="summary-col cart-action-col">
                    <button className="btn-open-cart" onClick={() => setShowCartModal(true)}>
                      🛒 Vedi Carrello ({cart.length})
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <section className="form-card-orderco">
              <div className="card-header-title"><h3>Nuova Selezione Prodotto</h3></div>
              <form onSubmit={handleCalculate}>
                <div className="form-top-row">
                  <div className="left-inputs">
                    <div className="input-group">
                      <label>Cerca Prodotto:</label>
                      <input 
                        type="text" 
                        placeholder="Scrivi per suggerire/filtrare il catalogo..." 
                        value={searchTerm} 
                        onChange={(e) => setSearchTerm(e.target.value)} 
                      />
                    </div>
                    <div className="input-group">
                      <label>Seleziona Prodotto:</label>
                      <select value={selectedArticle} onChange={(e) => setSelectedArticle(e.target.value)}>
                        {filteredArticles.map((art) => (
                          <option key={art.id} value={art.id}>{art.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {currentArticleObj?.image_url && (
                    <div className="right-preview">
                      <img src={currentArticleObj.image_url} alt={currentArticleObj.name} className="preview-img"/>
                    </div>
                  )}
                </div>    

                <div className="form-bottom-row">
                  <div className="input-group"><label>Quantità:</label><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required /></div>
                  <div className="input-group highlight-date"><label>Data Ordine:</label><input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} required /></div>
                  <div className="input-group highlight-date-target"><label>Deadline:</label><input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} required /></div>
                </div>

                <div className="form-buttons-row">
                  <button type="submit" disabled={loading} className="btn-calculate">{loading ? 'Calcolo...' : 'Calcola Preventivi'}</button>
                  <button type="button" className="btn-avanzate-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>{showAdvanced ? 'Nascondi' : 'Preferenze'}</button>
                </div>

                {showAdvanced && (
                  <div className="preferences-slider-container animated-expand">
                    <div className="slider-labels-top"><span>💰 Risparmio</span><span>🚀 Velocità</span></div>
                    <input type="range" min="1" max="5" step="1" value={sliderPosition} onChange={(e) => { setSliderPosition(Number(e.target.value)); fetchResults(Number(e.target.value)); }} className="modern-range"/>
                    <div className="slider-value-display">Ottimizzazione: <strong>{sliderLabels[sliderPosition]}</strong></div>
                  </div>
                )}
              </form>
            </section>

            {sortedResults && (
              <section className="results-container">
                <h2>Risultati Fornitori ({sortedResults.length})</h2>
                <div className="vendor-cards-list">
                  {sortedResults.map((f, idx) => {
                    // Determina badge/colore della card in base all'esito del fornitore:
                    // non idoneo (stock insufficiente o consegna fuori deadline) > best value > più economico > più veloce > standard.
                    let isIdoneo = f.hasEnoughStock && f.arrivesInTime;
                    let statusClass = 'status-gray';
                    let statusTitle = '🚚 Spedizione Standard';
                    let titleColorClass = 'text-gray';

                    const errorTags = [];
                    if (!f.hasEnoughStock) errorTags.push(`❌ Esaurito (${f.stock_quantity} pz disp.)`);
                    if (!f.arrivesInTime) errorTags.push(`❌ In Ritardo (${formatDate(f.estimated_delivery_date)})`);

                    if (!isIdoneo) {
                      statusClass = 'status-red';
                      statusTitle = '⚠️ Non Idoneo';
                      titleColorClass = 'text-red';
                    } else if (f.isBestValue) {
                      statusClass = 'status-blue';
                      statusTitle = '⭐ Best Value';
                      titleColorClass = 'text-blue';
                    } else if (f.isCheapest) {
                      statusClass = 'status-green';
                      statusTitle = '🏷️ Miglior Prezzo';
                      titleColorClass = 'text-green';
                    } else if (f.isFastest) {
                      statusClass = 'status-yellow';
                      statusTitle = '⚡ Più Veloce';
                      titleColorClass = 'text-yellow';
                    }

                    const supplierName = f.supplier_name || 'Fornitore';
                    const initials = supplierName.substring(0, 2).toUpperCase();

                    return (
                      <div key={f.supplier_id || idx} className={`vendor-card ${!isIdoneo ? 'card-disabled' : ''}`}>
                        <div className="vendor-card-left">
                          <div className="vendor-card-header">
                           <span className="fulfilled-by">
                             Fulfilled by <strong className="clickable-supplier" onClick={() => openSupplierProfile(f.supplier_id, supplierName)}>{supplierName}</strong>
                           </span>
                           <span className="vendor-order-id">Vendor order #{134680800 + idx}</span>
                          </div>

                          <div className="vendor-card-body">
                            <div className="supplier-logo-badge">{initials}</div>
                            <div className="product-info">
                              <h4 className="product-title">{currentArticleObj?.name || 'Prodotto'}</h4>
                              {errorTags.length > 0 ? (
                                <div className="error-tags-container">
                                  {errorTags.map((err, i) => (
                                    <p key={i} className="product-meta out-of-stock-text">{err}</p>
                                  ))}
                                </div>
                              ) : (
                                <>
                                  <p className="product-meta">
                                    Prezzo unitario: 
                                    {f.discount_percentage > 0 ? (
                                      <>
                                        <span style={{ textDecoration: 'line-through', color: '#98a2b3', marginLeft: '4px', marginRight: '6px' }}>
                                          ${Number(f.unit_price).toFixed(2)}
                                        </span>
                                        <strong style={{ color: '#027a48' }}>${Number(f.discounted_unit_price).toFixed(2)}</strong>
                                      </>
                                    ) : (
                                      <strong style={{ marginLeft: '4px' }}>${Number(f.unit_price).toFixed(2)}</strong>
                                    )} 
                                    <span style={{ marginLeft: '8px' }}>| Stock: <strong>{f.stock_quantity} pz</strong></span>
                                  </p>
                                  
                                  {f.discount_percentage > 0 && (
                                    <div className="discounts-pills">
                                      <span className="discount-pill" style={{ background: '#ecfdf3', color: '#027a48', border: '1px solid #abefc6' }}>
                                        🏷️ Sconto {f.discount_percentage}% per q.tà applicato
                                      </span>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </div>

                          <div className="vendor-card-footer">
                            <div className="total-amount">
                              <span>Totale per {quantity} pz</span>
                              {f.discount_percentage > 0 && isIdoneo && (
                                <span style={{ textDecoration: 'line-through', fontSize: '1rem', color: '#98a2b3', marginLeft: '12px' }}>
                                  ${f.originalTotalPrice.toFixed(2)}
                                </span>
                              )}
                              <strong>${isIdoneo && f.totalPrice ? Number(f.totalPrice).toFixed(2) : 'N/A'}</strong>
                            </div>

                            {isIdoneo && (
                              <button className="btn-add-cart" onClick={() => addToCart(f)}>
                                🛒 Aggiungi al Carrello
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="vendor-card-right">
                          <div className={`shipment-box ${statusClass}`}>
                            <div className="shipment-status-header">
                              <span className={`status-title ${titleColorClass}`}>{statusTitle}</span>
                              <span className="courier-logo">Express</span>
                            </div>
                            <div className="shipment-info">
                              <span className="info-label">DATA DI CONSEGNA</span>
                              <span className="info-value highlight-arrival">{formatDate(f.estimated_delivery_date)}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}

        {/* ================= CATALOG: elenco prodotti e fornitori, con dettaglio su click ================= */}
        {activeNav === 'Catalog' && (
          <div className="catalog-page">
            <header className="page-header">
              <h1>Catalog</h1>
              <div className="catalog-tabs">
                <button className={`catalog-tab-btn ${catalogView === 'products' ? 'active' : ''}`} onClick={() => setCatalogView('products')}>📦 Prodotti</button>
                <button className={`catalog-tab-btn ${catalogView === 'suppliers' ? 'active' : ''}`} onClick={() => { setCatalogView('suppliers'); loadSuppliersList(); }}>🏢 Fornitori</button>
              </div>
            </header>
            
            {catalogView === 'products' ? (
              <div className="catalog-grid">
                {articles.map((art) => (
                  <div key={art.id} className="catalog-card" onClick={() => openCatalogModal(art)}>
                    <img src={art.image_url} alt={art.name} />
                    <div className="catalog-card-info"><h4>{art.name}</h4></div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="catalog-grid">
                {suppliersList.map((sup) => (
                  <div key={sup.id} className="catalog-card supplier-card" onClick={() => openSupplierProfile(sup.id, sup.name)}>
                    <div className="supplier-logo-badge large-badge">{sup.name.substring(0,2).toUpperCase()}</div>
                    <div className="catalog-card-info"><h4>{sup.name}</h4><p className="product-meta">Clicca per vedere i prodotti</p></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ================= SETTINGS: preferenze utente e strumenti di test ================= */}
        {activeNav === 'Settings' && (
          <div className="settings-page">
            <header className="page-header">
              <h1>Settings</h1>
            </header>
            <div className="settings-card">
              <div className="setting-row">
                <div className="setting-info">
                  <h3>Modalità Scura</h3>
                  <p>Cambia l'aspetto dell'applicazione per ridurre l'affaticamento visivo.</p>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={isDarkMode} onChange={() => setIsDarkMode(!isDarkMode)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>

            <div className="settings-card danger-zone" style={{marginTop: '20px'}}>
              <h3>🛠️ Strumenti di Testing</h3>
              <p style={{marginBottom: '16px'}}>Ripristina il database ai valori iniziali (Fornitori, stock, articoli base).</p>
              <button className="btn-reset-db" onClick={handleResetDatabase}>
                🔄 Reset Database Iniziale
              </button>
            </div>
          </div>
        )}

        {/* ================= DASHBOARD: panoramica generale, condivide widget con History/Insights ================= */}
        {activeNav === 'Dashboard' && (
          <div className="dashboard-page">
            <header className="page-header">
              <h1>Dashboard</h1>
              <p>Panoramica generale: acquisti, trend e scorciatoie rapide.</p>
            </header>

            <div className="dashboard-grid">
              <div className="dash-card">
                <h3>Prodotti nel Catalogo</h3>
                <span className="dash-stat">{articles.length}</span>
              </div>
              <div className="dash-card">
                <h3>Articoli nel Carrello</h3>
                <span className="dash-stat">{cart.length}</span>
              </div>
              <div className="dash-card">
                <h3>Ordini Effettuati</h3>
                <span className="dash-stat">{orderHistory.length}</span>
              </div>
              <div className="dash-card">
                <h3>Totale Speso</h3>
                <span className="dash-stat">${orderHistory.reduce((s, o) => s + Number(o.total_amount || 0), 0).toFixed(2)}</span>
              </div>
            </div>

            <div className="dashboard-actions-row">
              <div className="settings-card flex-1">
                <div className="history-header">
                  <h3>📈 I tuoi prodotti più acquistati</h3>
                  <button type="button" className="summary-link" onClick={() => setActiveNav('Insights')}>Vedi tutti →</button>
                </div>
                {productInsights.length === 0 ? (
                  <p className="product-meta" style={{marginTop: '12px'}}>Nessun dato ancora disponibile: effettua un ordine per vedere i trend.</p>
                ) : (
                  productInsights.slice(0, 3).map((insight) => (
                    <div key={insight.article_id} className="insight-item-row">
                      <div className="cart-item-details" style={{flex: 1}}>
                        <strong>{insight.article_name}</strong>
                        <span className="cart-item-sub">{insight.totalQuantity} pz acquistati finora</span>
                      </div>
                      <div className="insight-item-actions">
                        <input
                          type="number"
                          min="1"
                          className="insight-qty-input"
                          value={insightQuantities[insight.article_id] ?? 1}
                          onChange={(e) => setInsightQty(insight.article_id, e.target.value)}
                        />
                        <button className="btn-add-cart" onClick={() => addInsightToCart(insight)}>🛒</button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="settings-card flex-1">
                <div className="history-header">
                  <h3>🕘 Ordini recenti</h3>
                  <button type="button" className="summary-link" onClick={() => setActiveNav('History')}>Vedi tutti →</button>
                </div>
                {orderHistory.length === 0 ? (
                  <p className="product-meta" style={{marginTop: '12px'}}>Nessun ordine effettuato finora.</p>
                ) : (
                  orderHistory.slice(0, 3).map((order) => (
                    <div key={order.id} className="cart-item-row" style={{marginTop: '12px'}}>
                      <div className="cart-item-details">
                        <strong>Ordine #{order.id}</strong>
                        <span className="cart-item-sub">{formatDate(order.order_date)} · {order.items.length} articoli</span>
                      </div>
                      <span className="cart-item-price">${Number(order.total_amount).toFixed(2)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="settings-card" style={{marginTop: '24px'}}>
              <h3>🚀 Scorciatoie</h3>
              <div style={{display: 'flex', gap: '12px', marginTop: '16px', flexWrap: 'wrap'}}>
                <button className="btn-primary-purple" onClick={() => setActiveNav('Orders')}>Crea un nuovo ordine</button>
                <button className="btn-secondary" onClick={() => setActiveNav('Catalog')}>Esplora il Catalogo</button>
              </div>
            </div>
          </div>
        )}

        {/* ================= HISTORY: elenco completo degli ordini confermati ================= */}
        {activeNav === 'History' && (
          <div className="history-page">
            <header className="page-header">
              <h1>History</h1>
              <p>Storico di tutti gli ordini effettuati.</p>
            </header>

            {historyLoading ? (
              <p>Caricamento storico...</p>
            ) : orderHistory.length === 0 ? (
              <p>Nessun ordine effettuato finora.</p>
            ) : (
              orderHistory.map((order) => (
                <div key={order.id} className="history-card">
                  <div className="history-header">
                    <div>
                      <div className="history-title-row">
                        <strong>Ordine #{order.id}</strong>
                        <button className="btn-repeat-order" onClick={() => repeatOrder(order)} title="Aggiungi di nuovo al carrello gli stessi articoli">Ripeti</button>
                      </div>
                      <p className="product-meta">{formatDate(order.order_date)} · {order.items.length} articoli</p>
                    </div>
                    <span className="history-total">${Number(order.total_amount).toFixed(2)}</span>
                  </div>
                  <div className="cart-items-list" style={{marginTop: '12px'}}>
                    {order.items.map((item, idx) => (
                      <div key={idx} className="cart-item-row">
                        <div className="cart-item-details">
                          <strong>{item.article_name}</strong>
                          <span className="cart-item-sub">Fornitore: {item.supplier_name} | {item.quantity} pz x ${Number(item.unit_price).toFixed(2)}</span>
                        </div>
                        <span className="cart-item-price">${Number(item.total_price).toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ================= INSIGHTS: trend d'acquisto e riordino rapido dei prodotti più comprati ================= */}
        {activeNav === 'Insights' && (
          <div className="insights-page">
            <header className="page-header">
              <h1>Insights</h1>
              <p>Trend d'acquisto e prodotti più ordinati.</p>
            </header>

            {productInsights.length === 0 ? (
              <p>Non ci sono ancora dati sufficienti. Effettua un ordine per vedere i trend.</p>
            ) : (
              <div className="history-card">
                <h3 style={{marginBottom: '8px'}}>Prodotti più acquistati</h3>
                {productInsights.map((insight) => (
                  <div key={insight.article_id} className="insight-item-row">
                    <div className="cart-item-details" style={{flex: 1}}>
                      <strong>{insight.article_name}</strong>
                      <span className="cart-item-sub">
                        {insight.totalQuantity} pz totali · {insight.timesOrdered} ordini · ultimo fornitore: {insight.lastSupplierName}
                      </span>
                      <div className="insight-bar-track">
                        <div className="insight-bar-fill" style={{ width: `${maxInsightQuantity ? (insight.totalQuantity / maxInsightQuantity) * 100 : 0}%` }} />
                      </div>
                    </div>
                    <div className="insight-item-actions">
                      <input
                        type="number"
                        min="1"
                        className="insight-qty-input"
                        value={insightQuantities[insight.article_id] ?? 1}
                        onChange={(e) => setInsightQty(insight.article_id, e.target.value)}
                      />
                      <button className="btn-add-cart" onClick={() => addInsightToCart(insight)}>🛒 Aggiungi</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ================= MODALE: carrello e checkout ================= */}
      {showCartModal && (
        <div className="modal-overlay" onClick={() => setShowCartModal(false)}>
          <div className="modal-content cart-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowCartModal(false)}>×</button>
            <h2>🛒 Il Tuo Carrello</h2>
            
            {cart.length === 0 ? (
              <p style={{ marginTop: '20px', color: '#667085' }}>Il carrello è vuoto. Aggiungi prodotti dai risultati per procedere.</p>
            ) : (
              <>
                <div className="cart-items-list">
                  {cart.map((item) => (
                    <div key={item.cart_id} className="cart-item-row">
                      <div className="cart-item-details">
                        <strong>{item.article_name}</strong>
                        <span className="cart-item-sub">Fornitore: {item.supplier_name} | {item.quantity} pz x ${item.unit_price}</span>
                        <span className="cart-item-date">Consegna stimata: {formatDate(item.delivery_date)}</span>
                      </div>
                      <div className="cart-item-right">
                        <span className="cart-item-price">${item.total_price.toFixed(2)}</span>
                        <button className="btn-remove-cart" onClick={() => removeFromCart(item.cart_id)}>🗑️</button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="cart-summary-footer">
                  <div className="cart-total-row">
                    <span>Totale Ordine:</span>
                    <strong>${cartTotal.toFixed(2)}</strong>
                  </div>
                  <button className="btn-checkout" disabled={isSubmittingOrder} onClick={handleCheckout}>
                    {isSubmittingOrder ? 'Elaborazione...' : 'Conferma ed Invia Ordine'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ================= MODALE: fornitori e stock disponibile per un articolo del Catalog ================= */}
      {selectedCatalogItem && (
        <div className="modal-overlay" onClick={closeCatalogModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={closeCatalogModal}>×</button>
            
            <div className="modal-header">
              <img src={selectedCatalogItem.image_url} alt={selectedCatalogItem.name} className="modal-product-img"/>
              <h2>{selectedCatalogItem.name}</h2>
            </div>
            
            <div className="modal-body">
              <h3>Fornitori e Stock Disponibile</h3>
              {loadingSuppliers ? (
                <p>Caricamento fornitori...</p>
              ) : (
                <>
                  <p className="product-meta" style={{marginBottom: '8px'}}>Clicca su un fornitore per acquistare direttamente da qui.</p>
                  <table className="modal-table">
                    <thead>
                      <tr>
                        <th>Fornitore</th>
                        <th>Prezzo Unitario</th>
                        <th>Stock (Pz)</th>
                        <th>Data Consegna</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalogSuppliers.length > 0 ? (
                        catalogSuppliers.map((sup, idx) => (
                          <tr
                            key={idx}
                            className="clickable-row"
                            onClick={() => openQuickBuy({
                              article_id: selectedCatalogItem.id,
                              article_name: selectedCatalogItem.name,
                              article_image_url: selectedCatalogItem.image_url,
                              supplier_id: sup.supplier_id,
                              supplier_name: sup.supplier_name,
                              unit_price: sup.unit_price,
                              stock_quantity: sup.stock_quantity,
                              delivery_date: sup.delivery_date
                            })}
                          >
                            <td><strong>{sup.supplier_name}</strong></td>
                            <td>${sup.unit_price}</td>
                            <td>
                              <span className={`stock-badge ${sup.stock_quantity > 100 ? 'stock-high' : 'stock-low'}`}>
                                {sup.stock_quantity}
                              </span>
                            </td>
                            <td>{formatDate(sup.delivery_date)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr><td colSpan="4">Nessun fornitore trovato.</td></tr>
                      )}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= MODALE: mini-profilo fornitore (assortimento prodotti) ================= */}
      {selectedSupplierProfile && (
        <div className="modal-overlay" onClick={closeSupplierProfile}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={closeSupplierProfile}>×</button>
            <div className="modal-header">
              <div className="supplier-logo-badge">{selectedSupplierProfile.name.substring(0,2).toUpperCase()}</div>
              <h2>Profilo: {selectedSupplierProfile.name}</h2>
            </div>

            <div className="modal-body">
              <h3>Catalogo Prodotti Forniti</h3>
              {supplierProductsLoading ? (
                <p>Caricamento assortimento...</p>
              ) : (
                <>
                  <p className="product-meta" style={{marginBottom: '8px'}}>Clicca su un prodotto per acquistarlo direttamente da qui.</p>
                  <table className="modal-table">
                    <thead>
                      <tr><th>Prodotto</th><th>Prezzo Base</th><th>Stock (pz)</th></tr>
                    </thead>
                    <tbody>
                      {selectedSupplierProfile.products.length > 0 ? (
                        selectedSupplierProfile.products.map((p, idx) => (
                          <tr
                            key={idx}
                            className="clickable-row"
                            onClick={() => openQuickBuy({
                              article_id: p.id,
                              article_name: p.name,
                              article_image_url: p.image_url,
                              supplier_id: selectedSupplierProfile.id,
                              supplier_name: selectedSupplierProfile.name,
                              unit_price: p.unit_price,
                              stock_quantity: p.stock_quantity,
                              delivery_date: p.delivery_date
                            })}
                          >
                            <td style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                              <img src={p.image_url} alt={p.name} style={{width:'32px', height:'32px', borderRadius:'4px', objectFit:'cover'}}/>
                              <strong>{p.name}</strong>
                            </td>
                            <td>${Number(p.unit_price).toFixed(2)}</td>
                            <td><span className={`stock-badge ${p.stock_quantity > 0 ? 'stock-high' : 'stock-low'}`}>{p.stock_quantity}</span></td>
                          </tr>
                        ))
                      ) : (
                        <tr><td colSpan="3">Nessun prodotto configurato per questo fornitore.</td></tr>
                      )}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= MODALE: Account & Debug Tools (inserimento manuale prodotto + offerta + sconto) ================= */}
      {showAccountModal && (
        <div className="modal-overlay" onClick={() => setShowAccountModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowAccountModal(false)}>×</button>
            <div className="modal-header">
              <div className="user-avatar">👤</div>
              <h2>Account & Debug Tools</h2>
            </div>

            <div className="modal-body">
              <div className="discount-debug-box">
                <h3 style={{marginBottom: '12px'}}>➕ Inserisci Prodotto + Offerta Fornitore</h3>
                <form className="add-product-form" onSubmit={handleDebugSubmit}>
                  <div className="input-group">
                    <label>Nome Prodotto</label>
                    <input type="text" value={debugName} onChange={(e) => setDebugName(e.target.value)} required />
                  </div>
                  <div className="input-group">
                    <label>URL Immagine</label>
                    <input type="url" value={debugImageUrl} onChange={(e) => setDebugImageUrl(e.target.value)} required />
                  </div>

                  <div className="input-row-flex">
                    <div className="input-group flex-1">
                      <label>Fornitore *</label>
                      <select value={debugSupplierId} onChange={(e) => setDebugSupplierId(e.target.value)} required>
                        <option value="">Seleziona fornitore...</option>
                        {suppliersList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                    <div className="input-group flex-1">
                      <label>Prezzo Unitario (€) *</label>
                      <input type="number" min="0" step="0.01" value={debugUnitPrice} onChange={(e) => setDebugUnitPrice(e.target.value)} required />
                    </div>
                    <div className="input-group flex-1">
                      <label>Stock (pz) *</label>
                      <input type="number" min="0" value={debugStock} onChange={(e) => setDebugStock(e.target.value)} required />
                    </div>
                  </div>

                  <label className="checkbox-label" style={{marginTop: '8px'}}>
                    <input type="checkbox" checked={debugHasDiscount} onChange={(e) => setDebugHasDiscount(e.target.checked)} />
                    Applica uno sconto a questa offerta
                  </label>

                  {debugHasDiscount && (
                    <div className="discount-options-row animated-expand">
                      <div className="input-group">
                        <label>Tipo Sconto</label>
                        <select value={debugDiscountType} onChange={(e) => setDebugDiscountType(e.target.value)}>
                          <option value="QUANTITY">Quantità</option>
                          <option value="TOTAL_AMOUNT">Valore Ordine</option>
                          <option value="MONTH">Data/Stagione</option>
                        </select>
                      </div>
                      <div className="input-group">
                        <label>Soglia</label>
                        <input type="number" min="0" value={debugThreshold} onChange={(e) => setDebugThreshold(e.target.value)} required={debugHasDiscount} />
                      </div>
                      <div className="input-group">
                        <label>Sconto (%)</label>
                        <input type="number" min="0" max="100" step="0.01" value={debugPercentage} onChange={(e) => setDebugPercentage(e.target.value)} required={debugHasDiscount} />
                      </div>
                    </div>
                  )}

                  <div className="debug-actions-footer">
                    <span className="product-meta">I campi con * sono obbligatori.</span>
                    <button type="submit" className="btn-primary-purple" disabled={isSavingDebug}>
                      {isSavingDebug ? 'Salvataggio...' : 'Salva Prodotto + Offerta'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}

      {/*
        ================= POPUP: acquisto rapido di un'offerta articolo+fornitore =================
        Va tenuto per ultimo tra le modali (subito prima del toast): può essere aperto sia dalla
        modale "Fornitori e Stock Disponibile" del Catalog sia dal profilo Fornitore, ed essendo
        tutte allo stesso z-index vince chi viene dopo nel DOM — qui resta sempre in primo piano.
      */}
      {quickBuyOffer && (
        <div className="modal-overlay" onClick={closeQuickBuy}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={closeQuickBuy}>×</button>

            <div className="modal-header">
              <img src={quickBuyOffer.article_image_url} alt={quickBuyOffer.article_name} className="modal-product-img"/>
              <div>
                <h2 style={{marginBottom: '4px'}}>{quickBuyOffer.article_name}</h2>
                <p className="product-meta">Fornitore: <strong>{quickBuyOffer.supplier_name}</strong></p>
              </div>
            </div>

            <div className="modal-body">
              <div className="quick-buy-summary">
                <div className="summary-col">
                  <span className="summary-label">PREZZO UNITARIO</span>
                  <span className="summary-value highlight">${Number(quickBuyOffer.unit_price).toFixed(2)}</span>
                </div>
                <div className="summary-col">
                  <span className="summary-label">STOCK DISPONIBILE</span>
                  <span className="summary-value">{quickBuyOffer.stock_quantity} pz</span>
                </div>
                <div className="summary-col">
                  <span className="summary-label">CONSEGNA STIMATA</span>
                  <span className="summary-value">{formatDate(quickBuyOffer.delivery_date)}</span>
                </div>
              </div>

              <div className="input-group" style={{marginTop: '20px'}}>
                <label>Quantità</label>
                <input
                  type="number"
                  min="1"
                  max={quickBuyOffer.stock_quantity}
                  value={quickBuyQuantity}
                  onChange={(e) => setQuickBuyQuantity(e.target.value)}
                />
              </div>

              <div className="cart-total-row" style={{marginTop: '16px'}}>
                <span>Totale</span>
                <strong>
                  ${(Math.min(Math.max(1, Number(quickBuyQuantity) || 1), Number(quickBuyOffer.stock_quantity) || 1) * Number(quickBuyOffer.unit_price)).toFixed(2)}
                </strong>
              </div>

              <button className="btn-checkout" style={{marginTop: '20px'}} onClick={confirmQuickBuy}>
                🛒 Aggiungi al Carrello
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notifica "toast" non bloccante, si nasconde da sola dopo 3s (vedi setTimeout nelle funzioni sopra) */}
      {toast && (
        <div className="toast-notification">
          {toast}
        </div>
      )}
    </div>
  );
}