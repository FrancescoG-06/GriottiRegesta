/**
 * db.js — pool di connessioni MySQL condiviso da tutti gli endpoint di
 * `server.js`. Le credenziali sono lette da variabili d'ambiente (file
 * `.env`, non versionato) per non avere segreti hard-coded nel codice.
 * Un pool (anziché una singola connessione) permette di gestire più
 * richieste concorrenti riutilizzando le connessioni già aperte.
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;