import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthSessionProvider } from '@/features/auth/session-provider';
import { initialiseObservability } from '@/lib/observability';

// Initialised before the first render so an early crash is still reported —
// with coordinate scrubbing already installed.
initialiseObservability();

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
        <AuthSessionProvider>
          <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
          <Stack screenOptions={{ headerShown: false }} />
        </AuthSessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
