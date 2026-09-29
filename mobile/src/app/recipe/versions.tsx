import { router, useLocalSearchParams } from 'expo-router';
import { Alert, ScrollView, Text } from 'react-native';
import { FormulaTable } from '../../components/FormulaTable';
import { Button, Card, Empty, space, styles } from '../../components/ui';
import { useLiveQuery } from '../../data/db';
import { listVersions, restoreVersion } from '../../data/repo';

/**
 * When the same recipe was edited on two devices, the most recent save wins and the other
 * version is kept here so the baker can bring it back.
 */
export default function Versions() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const versions = useLiveQuery(() => listVersions(id), [id]);
  if (versions && !versions.length) return <Empty icon="time-outline" title="No older versions" />;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {(versions ?? []).map((v) => (
        <Card key={v.id} style={{ gap: space(2) }}>
          <Text style={[styles.text, { fontWeight: '700' }]}>{v.doc.name}</Text>
          <Text style={styles.muted}>
            Saved {new Date(v.doc.modified_at).toLocaleString()} · {v.reason}
          </Text>
          <FormulaTable ingredients={v.doc.ingredients} />
          <Text style={styles.muted}>{v.doc.steps.length} steps</Text>
          <Button
            title="Restore this version"
            variant="secondary"
            onPress={() =>
              Alert.alert('Restore this version?', 'The current version is kept here in its place.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Restore',
                  onPress: async () => {
                    await restoreVersion(v.id);
                    router.back();
                  },
                },
              ])
            }
          />
        </Card>
      ))}
    </ScrollView>
  );
}
