import { useMemo } from 'react';
import { createClient } from './api.js';
import { Sprite } from './components/Icon.js';
import { DashboardPages } from './pages/lazy.js';
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
      <Shell pages={DashboardPages} />
    </AppProvider>
  );
}
