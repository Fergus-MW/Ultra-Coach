import { ConversationProvider } from '@elevenlabs/react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useRuns } from '../src/store/runs';
import { useSettings } from '../src/store/settings';
import { colors } from '../src/theme';

export default function RootLayout() {
  const hydrateSettings = useSettings((state) => state.hydrate);
  const hydrateRuns = useRuns((state) => state.hydrate);

  useEffect(() => {
    void hydrateSettings();
    void hydrateRuns();
  }, [hydrateRuns, hydrateSettings]);

  return (
    <ConversationProvider>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="run" options={{ title: 'Run', headerBackVisible: false }} />
        </Stack>
      </SafeAreaProvider>
    </ConversationProvider>
  );
}
