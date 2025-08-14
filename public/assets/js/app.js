import { TradingApp } from './TradingApp.js';

// Configurazione iniziale
const config = {
    apiBaseUrl: window.location.origin,
    defaultTheme: localStorage.getItem('theme') || 'light',
    autoConnect: true,
    version: '2.0.0'
};

// Avvia l'applicazione
document.addEventListener('DOMContentLoaded', () => {
    const app = new TradingApp(config);
    app.init();
    
    // Service Worker per offline mode
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Service Worker registrato'))
            .catch(err => console.error('Errore SW:', err));
    }
});