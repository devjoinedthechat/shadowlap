import { useMemo } from 'react';
import { createClient } from './api.js';
import { Sprite } from './components/Icon.js';
import { DashboardPages } from './pages/lazy.js';
import { Gate } from './shell/Connection.js';
import { Shell } from './shell/Shell.js';
import { AppProvider } from './state.js';
import { onShow } from './components/OnShow.js';
import { BuilderLost, CheckBuilderPart, CheckMenuPart } from './run/check-part.js';

/** The check builder, a part of its own, which the served dashboard hands a run's page and an exported copy never has (run/check-part.tsx). */
const CheckBuilder = onShow(() => import('./checks/Builder.js').then((m) => m.Builder), { failed: <BuilderLost /> });
/** The check menu at a tool call, whose pick opens the builder: handed in beside it, and as a copy never has it. */
const CheckMenu = onShow(() => import('./run/CheckMenu.js').then((m) => m.CheckMenu), { failed: <BuilderLost /> });

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
        <CheckMenuPart.Provider value={CheckMenu}>
          <Shell pages={DashboardPages} />
        </CheckMenuPart.Provider>
      </CheckBuilderPart.Provider>
    </AppProvider>
  );
}
