import * as Notifications from 'expo-notifications';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors, Loading } from '../components/ui';
import '../data/media'; // registers the media file deleter
import { setupNotifications } from '../data/notifications';
import { SessionProvider, useSession } from '../data/session';
import { SyncProvider } from '../data/sync';

function RootStack() {
  const { ready, user } = useSession();
  useEffect(() => {
    void setupNotifications();
  }, []);

  // Tapping a "time's up" alert opens that bake's guided mode (also when it launched the app).
  useEffect(() => {
    if (!user || Platform.OS === 'web') return;
    const open = (response: Notifications.NotificationResponse | null) => {
      const bakeId = response?.notification.request.content.data?.bakeId;
      if (typeof bakeId === 'string') router.push({ pathname: '/bake/guided', params: { id: bakeId } });
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      open(last);
      Notifications.clearLastNotificationResponse();
    }
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [user]);

  if (!ready) return <Loading />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.primary,
        headerTitleStyle: { color: colors.text },
        contentStyle: { backgroundColor: colors.bg },
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Protected guard={!user}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="reset-password" options={{ title: 'Reset password' }} />
      </Stack.Protected>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="recipe/[id]" options={{ title: '' }} />
        <Stack.Screen name="recipe/edit" options={{ title: 'Edit recipe' }} />
        <Stack.Screen name="recipe/scale" options={{ title: 'Scale', presentation: 'modal' }} />
        <Stack.Screen name="recipe/versions" options={{ title: 'Older versions' }} />
        <Stack.Screen name="bake/guided" options={{ headerShown: false, presentation: 'fullScreenModal', gestureEnabled: false }} />
        <Stack.Screen name="bake/[id]" options={{ title: 'Bake' }} />
        <Stack.Screen name="bake/media" options={{ title: '', presentation: 'fullScreenModal', headerStyle: { backgroundColor: '#000' } }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <SyncProvider>
          <StatusBar style="dark" />
          <RootStack />
        </SyncProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
