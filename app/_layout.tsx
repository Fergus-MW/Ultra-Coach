import { ConversationProvider } from '@elevenlabs/react-native';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useCoach } from '../src/store/coach';
import { useRuns } from '../src/store/runs';
import { useSettings } from '../src/store/settings';
import { colors } from '../src/theme';
import { CallOverlay } from '../src/ui/CallOverlay';

export default function RootLayout() {
  const hydrateSettings = useSettings((state) => state.hydrate);
  const hydrateRuns = useRuns((state) => state.hydrate);

  useEffect(() => {
    void hydrateSettings();
    void hydrateRuns();
  }, [hydrateRuns, hydrateSettings]);

  useEffect(() => {
    // One socket for the whole app: the coach rings the runner wherever they are, not
    // only while a particular tab happens to be open.
    useCoach.getState().listen();
    // The coach owns the screen, so recommending kit takes the runner to it rather than
    // leaving a badge to be found later.
    const stop = useCoach.subscribe((state, previous) => {
      if (state.pushed && state.pushed !== previous.pushed) router.navigate('/kit');
    });
    return () => {
      stop();
      useCoach.getState().stopListening();
    };
  }, []);

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
        <CallOverlay />
      </SafeAreaProvider>
    </ConversationProvider>
  );
}
