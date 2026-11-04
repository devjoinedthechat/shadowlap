import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { takeToken } from './api.js';
import { App } from './App.js';
import './app.css';

// The dashboard the server serves; an exported copy is built from main-copy.tsx.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App token={takeToken()} />
  </StrictMode>,
);
