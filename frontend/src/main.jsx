// main.jsx — entry point dell'applicazione: monta il componente <App />
// (definito in App.jsx, che contiene tutta la logica e l'interfaccia)
// nel nodo #root di index.html. StrictMode attiva controlli aggiuntivi di
// React solo in sviluppo, per intercettare prima possibile effetti
// collaterali non sicuri o pattern deprecati.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
