import { useMemo } from 'react';
import { createClient } from './api.js';
import { Sprite } from './components/Icon.js';
import { DashboardPages } from './pages/lazy.js';
import { SERVED_PARTS } from './pages/served.js';
import { ServedPartsContext } from './served-parts.js';
import { Gate } from './shell/Connection.js';
import { Shell } from './shell/Shell.js';
import { AppProvider } from './state.js';

/** The dashboard, or, for a link without a session token, the gate that says where the right link comes from. */
export function App({ token }: { token: string | null }) {
  const c = useMemo(() => (token ? createClient(token) : null), [token]);
  if (!c)
    return (
      <>
        <Sprite />
        <Gate />
      </>
    );
  return (
    <AppProvider client={c}>
      <ServedPartsContext.Provider value={SERVED_PARTS}>
        <Shell pages={DashboardPages} />
      </ServedPartsContext.Provider>
    </AppProvider>
  );
}
