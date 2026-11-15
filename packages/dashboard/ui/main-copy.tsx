import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createExportedClient, exportedData } from './api.js';
import { CopyPages } from './pages/copy.js';
import { Shell } from './shell/Shell.js';
import { AppProvider } from './state.js';

/**
 * An exported copy's script, which `shadowlap export html` inlines into the file (src/static.ts):
 * the dashboard's shell over the data the file carries, with only the pages a copy shows (its runs,
 * a run's page and Compare between them, pages/copy.tsx), so none of the dashboard's other pages is
 * in it. Its styles are the dashboard's own (assets/app.css), inlined beside it, so it imports none.
 */
const data = exportedData();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {data ? (
      <AppProvider client={createExportedClient(data)}>
        <Shell pages={CopyPages} />
      </AppProvider>
    ) : (
      <p className="empty tall">This exported shadowlap run carries no data it can read. Export it again with shadowlap export html.</p>
    )}
  </StrictMode>,
);
