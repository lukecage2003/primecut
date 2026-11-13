import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { api } from './api';
import './styles/app.css';

// interface errors go to the technical log (Réglages → Dépendances et journal)
window.addEventListener('error', (e) => api.system.reportError({ message: e.message, stack: e.error?.stack, source: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => api.system.reportError({ message: e.reason instanceof Error ? e.reason.message : String(e.reason), stack: e.reason?.stack, source: 'promesse' }));

createRoot(document.getElementById('root')!).render(<App />);
