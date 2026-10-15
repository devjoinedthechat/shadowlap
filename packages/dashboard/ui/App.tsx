import { useMemo } from 'react';
import { createClient, type Client } from './api.js';
import { Sprite } from './components/Icon.js';
import { Gate } from './shell/Connection.js';
import { Shell } from './shell/Shell.js';
import { AppProvider } from './state.js';

/** The dashboard, or, for a link without a session token, the gate that says where the right link comes from. */
export function App({ token, client }: { token: string | null; client?: Client }) {
  const c = useMemo(() => client ?? (token ? createClient(token) : null), [client, token]);
  if (!c)
    return (
      <>
        <Sprite />
        <Gate />
      </>
    );
  return (
    <AppProvider client={c}>
      <Shell />
    </AppProvider>
  );
}
