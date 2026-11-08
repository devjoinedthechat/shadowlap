import { useMemo } from 'react';
import { createClient } from './api.js';
import { Sprite } from './components/Icon.js';
import { DashboardPages } from './pages/lazy.js';
import { Gate } from './shell/Connection.js';
import { Shell } from './shell/Shell.js';
import { AppProvider } from './state.js';
import { onShow } from './components/OnShow.js';
import { BuilderLost, CheckBuilderPart } from './run/check-part.js';

/** The check builder, a part of its own, which the served dashboard hands a run's page and an exported copy never has (run/check-part.tsx). */
const CheckBuilder = onShow(() => import('./checks/Builder.js').then((m) => m.Builder), { failed: <BuilderLost /> });

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
      <CheckBuilderPart.Provider value={CheckBuilder}>
        <Shell pages={DashboardPages} />
      </CheckBuilderPart.Provider>
    </AppProvider>
  );
}
