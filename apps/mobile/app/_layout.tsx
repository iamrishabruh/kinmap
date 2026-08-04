import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { installAuthBridge } from '@/features/auth/auth-bridge';
import { RouteGuard } from '@/features/auth/route-guard';
import { AuthSessionProvider } from '@/features/auth/session-provider';
import { ApiProvider } from '@/features/query/api';
import { familyApi } from '@/features/query/transport';
import { initialiseObservability } from '@/lib/observability';

// Initialised before the first render so an early crash is still reported —
// with coordinate scrubbing already installed.
initialiseObservability();

// Before any provider mounts, as auth-bridge.ts says it must be. Without it
// `@/lib/api` takes its anonymous path and every authenticated request goes out
// without a token — the `GET /v1/account` that AuthSessionProvider makes right
// after a successful sign-in would 401, and the user would sit on "we could not
// load your account" with no way forward. It had no caller at all.
installAuthBridge();

void SplashScreen.preventAutoHideAsync();

/**
 * A stale map is safer than a wrong one, so queries refetch when the user
 * returns rather than polling on a timer, and mutations never silently retry.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: 2,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: 0 },
    },
  });
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [queryClient] = useState(createQueryClient);

  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {/*
          Above AuthSessionProvider, because that provider's first act is to
          fetch the account — it calls the API before any screen mounts, so the
          transport has to already be in the tree.
        */}
        <ApiProvider api={familyApi}>
          <AuthSessionProvider>
            <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
            <RouteGuard>
              <Stack screenOptions={{ headerShown: false }} />
            </RouteGuard>
          </AuthSessionProvider>
        </ApiProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
