-- ============================================================================
-- schema.sql — Schema del database "stock_replenishment"
--
-- Ricostruito a partire dal dump reale del database (phpMyAdmin, MariaDB
-- 10.4.32), non da una supposizione sulle query: rispecchia esattamente
-- tipi di colonna, l'ENUM di discounts.discount_type e i vincoli di chiave
-- esterna in uso. Eseguire questo script una sola volta su un database
-- vuoto prima di avviare il backend; i dati di esempio si popolano poi
-- dall'app (Settings → "Reset Database Iniziale"), non da questo file.
--
-- Utilizzo:
--   mysql -u root -p < schema.sql
--   (compatibile sia con MySQL sia con MariaDB, come nell'ambiente originale)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS stock_replenishment
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE stock_replenishment;

-- ----------------------------------------------------------------------------
-- articles — catalogo dei prodotti vendibili (prezzo di vendita escluso:
-- il progetto si concentra sul prezzo di ACQUISTO dai fornitori, come da
-- consegna "Purchase orders for stock replenishment").
-- ----------------------------------------------------------------------------
CREATE TABLE articles (
  id         INT(11) NOT NULL AUTO_INCREMENT,
  NAME       VARCHAR(255) NOT NULL,
  image_url  VARCHAR(500) DEFAULT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ----------------------------------------------------------------------------
-- suppliers — anagrafica fornitori.
-- ----------------------------------------------------------------------------
CREATE TABLE suppliers (
  id    INT(11) NOT NULL AUTO_INCREMENT,
  NAME  VARCHAR(255) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ----------------------------------------------------------------------------
-- supplier_articles — offerta di un fornitore per un articolo: prezzo
-- unitario di acquisto, quantità disponibile a magazzino e data di
-- consegna stimata per quella specifica offerta. È la tabella "ponte"
-- (relazione N:N tra suppliers e articles con attributi propri).
-- ----------------------------------------------------------------------------
CREATE TABLE supplier_articles (
  id              INT(11) NOT NULL AUTO_INCREMENT,
  supplier_id     INT(11) NOT NULL,
  article_id      INT(11) NOT NULL,
  stock_quantity  INT(11) NOT NULL,
  unit_price      DECIMAL(10, 2) NOT NULL,
  delivery_date   DATE NOT NULL,
  PRIMARY KEY (id),
  KEY supplier_id (supplier_id),
  KEY article_id (article_id),
  CONSTRAINT supplier_articles_ibfk_1
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE,
  CONSTRAINT supplier_articles_ibfk_2
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ----------------------------------------------------------------------------
-- discounts — sconti applicabili a una specifica offerta fornitore
-- (supplier_articles). discount_type è un ENUM con le tre modalità
-- previste dalla consegna:
--   'QUANTITY'     -> soglia espressa in pezzi ordinati (unico tipo oggi
--                     applicato dal calcolo del preventivo in server.js)
--   'TOTAL_AMOUNT' -> soglia espressa in valore totale dell'ordine (€)
--   'MONTH'        -> sconto stagionale/legato a un periodo dell'anno
-- 'TOTAL_AMOUNT' e 'MONTH' sono già inseribili (anche dal pannello di
-- debug del frontend), ma non ancora considerati dall'algoritmo di calcolo
-- del preventivo: vedi il paragrafo "Limiti noti" nel README.
-- ----------------------------------------------------------------------------
CREATE TABLE discounts (
  id                   INT(11) NOT NULL AUTO_INCREMENT,
  supplier_article_id  INT(11) NOT NULL,
  discount_type        ENUM('QUANTITY', 'TOTAL_AMOUNT', 'MONTH') NOT NULL,
  threshold_value       DECIMAL(10, 2) NOT NULL,
  percentage           DECIMAL(5, 2) NOT NULL,
  PRIMARY KEY (id),
  KEY supplier_article_id (supplier_article_id),
  CONSTRAINT discounts_ibfk_1
    FOREIGN KEY (supplier_article_id) REFERENCES supplier_articles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
