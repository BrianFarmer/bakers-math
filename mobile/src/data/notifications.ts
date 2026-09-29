/**
 * "Time's up" alerts for step timers. Each running timer schedules a local notification at its
 * end time, so the alert fires with sound even when the phone is locked or the app is closed,
 * and without any connection.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getKv } from './db';

const CHANNEL = 'timers';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function setupNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Step timers',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 400, 200, 400],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

export async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

export async function soundEnabled() {
  return (await getKv('sound')) !== 'off';
}

export async function scheduleTimerAlert(opts: { bakeId: string; stepTitle: string; recipeName: string; endsAt: number }) {
  if (opts.endsAt <= Date.now()) return null;
  const sound = await soundEnabled();
  return Notifications.scheduleNotificationAsync({
    content: {
      title: `Time's up: ${opts.stepTitle}`,
      body: opts.recipeName,
      sound: sound ? 'default' : false,
      data: { bakeId: opts.bakeId },
      priority: Notifications.AndroidNotificationPriority.MAX,
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: opts.endsAt, channelId: CHANNEL },
  });
}

export async function cancelAlert(id: string | undefined | null) {
  if (!id) return;
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
}
