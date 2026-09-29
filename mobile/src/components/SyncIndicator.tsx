import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, Text } from 'react-native';
import { useSync } from '../data/sync';
import { colors, space } from './ui';

/** Small header indicator: offline, syncing, or how many changes are waiting. Tap to sync. */
export function SyncIndicator() {
  const { online, syncing, pending, syncNow } = useSync();
  const waiting = pending.changes;
  let icon: keyof typeof Ionicons.glyphMap = 'cloud-done-outline';
  let label = '';
  let color = colors.muted;
  if (online === false) {
    icon = 'cloud-offline-outline';
    label = waiting ? `Offline · ${waiting} waiting` : 'Offline';
    color = colors.warning;
  } else if (pending.errors) {
    icon = 'alert-circle-outline';
    label = `${waiting} not synced`;
    color = colors.danger;
  } else if (waiting) {
    icon = 'cloud-upload-outline';
    label = `${waiting} waiting`;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label || 'All changes synced'}
      onPress={() => void syncNow()}
      hitSlop={8}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space(1), paddingHorizontal: space(3) }}
    >
      {syncing ? <ActivityIndicator size="small" color={colors.muted} /> : <Ionicons name={icon} size={18} color={color} />}
      {label ? <Text style={{ fontSize: 12, color, fontWeight: '600' }}>{label}</Text> : null}
    </Pressable>
  );
}
