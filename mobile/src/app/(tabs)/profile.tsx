import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, Switch, Text, View } from 'react-native';
import { ServerField } from '../../components/ServerField';
import { Button, Card, colors, Field, SectionTitle, space, styles } from '../../components/ui';
import { getKv, setKv, useLiveQuery, wipe } from '../../data/db';
import { ensurePermission } from '../../data/notifications';
import { useOnlineAction } from '../../data/online';
import { outboxErrors } from '../../data/repo';
import { useSession, useUser } from '../../data/session';
import { useSync } from '../../data/sync';
import type { User } from '../../lib/types';

export default function Profile() {
  const session = useSession();
  const user = useUser();
  const sync = useSync();
  const { run, busy } = useOnlineAction();
  const [name, setName] = useState(user.display_name);
  const [sound, setSound] = useState(true);
  const [notifications, setNotifications] = useState<boolean | null>(null);
  const errors = useLiveQuery(outboxErrors, []);

  useEffect(() => {
    getKv('sound').then((v) => setSound(v !== 'off'));
    Notifications.getPermissionsAsync().then((p) => setNotifications(p.granted));
  }, []);

  async function saveName() {
    if (name.trim() === user.display_name || !name.trim()) return;
    const updated = await run('Saving your name', () => session.api.patch<User>('/me', { display_name: name.trim() }));
    if (updated) await session.updateUser({ ...user, display_name: updated.display_name });
    else setName(user.display_name);
  }

  function signOut() {
    const waiting = sync.pending.changes;
    Alert.alert(
      'Sign out?',
      waiting
        ? `${waiting} change${waiting === 1 ? ' has' : 's have'} not synced yet and will be lost. Connect to the server first to keep them.`
        : 'Your recipes and bakes are removed from this phone; they stay on the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void session.signOut() },
      ],
    );
  }

  function deleteAccount() {
    Alert.alert('Delete your account?', 'This deletes your account, recipes, bakes, photos and videos for good.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete account',
        style: 'destructive',
        onPress: async () => {
          const ok = await run('Deleting your account', async () => {
            await session.api.del('/me');
            return true;
          });
          if (ok) {
            await wipe();
            await session.signOut();
          }
        },
      },
    ]);
  }

  const last = sync.lastResult;
  const status =
    sync.online === false
      ? "Offline: can't reach the server."
      : sync.pending.changes
        ? `${sync.pending.changes} change${sync.pending.changes === 1 ? '' : 's'} waiting to sync.`
        : 'Everything is synced.';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Card>
        <SectionTitle>Account</SectionTitle>
        <Field label="Display name" value={name} onChangeText={setName} onEndEditing={saveName} editable={!busy} />
        <Text style={styles.muted}>{user.email}</Text>
      </Card>

      <Card>
        <SectionTitle>Timer alerts</SectionTitle>
        <View style={styles.row}>
          <Text style={[styles.text, { flex: 1 }]}>Play a sound</Text>
          <Switch
            value={sound}
            onValueChange={(v) => {
              setSound(v);
              void setKv('sound', v ? 'on' : 'off');
            }}
            trackColor={{ true: colors.primary }}
          />
        </View>
        {notifications === false ? (
          <View style={{ gap: space(2) }}>
            <Text style={{ color: colors.warning }}>Notifications are off, so timers can't alert you when the phone is locked.</Text>
            <Button
              title="Turn on notifications"
              variant="secondary"
              small
              onPress={async () => {
                const ok = await ensurePermission();
                setNotifications(ok);
                if (!ok) void Linking.openSettings();
              }}
            />
          </View>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Sync</SectionTitle>
        <Text style={styles.text}>{status}</Text>
        {last?.errors.length ? <Text style={{ color: colors.danger }}>{last.errors.slice(0, 3).join('\n')}</Text> : null}
        {errors?.length ? (
          <Text style={{ color: colors.danger }}>
            {errors.length} change{errors.length === 1 ? ' was' : 's were'} rejected by the server: {errors[0].last_error}
          </Text>
        ) : null}
        <Button title="Sync now" icon="sync-outline" variant="secondary" small onPress={() => void sync.syncNow()} loading={sync.syncing} />
        <View style={[styles.divider, { marginVertical: space(1) }]} />
        <ServerField />
      </Card>

      <Button title="Sign out" variant="secondary" onPress={signOut} />
      <Button title="Delete account" variant="danger" onPress={deleteAccount} />
    </ScrollView>
  );
}
