import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createExportedClient, exportedData, takeToken } from './api.js';
import { App } from './App.js';
import './style.css';

// An exported HTML file carries its own data; otherwise the page talks to the dashboard server.
const exported = exportedData();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App token={exported ? 'exported' : takeToken()} {...(exported ? { client: createExportedClient(exported) } : {})} />
  </StrictMode>,
);
