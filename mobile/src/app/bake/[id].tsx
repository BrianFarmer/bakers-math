import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { FormulaTable } from '../../components/FormulaTable';
import { MediaThumb, type ThumbItem } from '../../components/MediaThumb';
import { SummaryBar } from '../../components/SummaryBar';
import { Button, Card, colors, Empty, Field, Loading, SectionTitle, space, styles } from '../../components/ui';
import { db, useLiveQuery } from '../../data/db';
import { captureMedia, pickMedia } from '../../data/media';
import { deleteBake, deleteMedia, getLocalBake, listLocalMedia, saveBake } from '../../data/repo';
import { formatGrams } from '../../lib/bakersMath';
import { describeSeconds } from '../../lib/timer';

export default function BakeDetail() {
  const { id, finished } = useLocalSearchParams<{ id: string; finished?: string }>();
  const bake = useLiveQuery(() => getLocalBake(id), [id]);
  const localMedia = useLiveQuery(() => listLocalMedia(id), [id]);
  const deletedIds = useLiveQuery(
    async () => (await db.getAllAsync<{ id: string }>('SELECT id FROM media WHERE deleted = 1')).map((r) => r.id),
    [],
  );
  const [notes, setNotes] = useState<string | null>(null);

  useEffect(() => {
    if (bake && notes === null) setNotes(bake.notes);
  }, [bake, notes]);

  if (bake === undefined || !localMedia || !deletedIds) return <Loading />;
  if (bake === null) return <Empty icon="alert-circle-outline" title="This bake was deleted" />;

  const snapshot = bake.recipe_snapshot;
  const localIds = new Set(localMedia.map((m) => m.id));
  const media: ThumbItem[] = [
    ...localMedia.map((m) => ({ id: m.id, kind: m.kind, local_uri: m.local_uri, pending: m.status === 'pending' })),
    ...bake.media.filter((m) => !localIds.has(m.id) && !deletedIds.includes(m.id)).map((m) => ({ id: m.id, kind: m.kind })),
  ];

  const save = async (patch: Partial<typeof bake>) => {
    await saveBake({ ...bake, ...patch });
  };

  function removeMedia(item: ThumbItem) {
    Alert.alert(item.kind === 'video' ? 'Delete this video?' : 'Delete this photo?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMedia(item.id, !item.local_uri || !item.pending) },
    ]);
  }

  function addMedia() {
    Alert.alert('Add to this bake', undefined, [
      { text: 'Take photo or video', onPress: () => captureMedia(bake!.id) },
      { text: 'Choose from library', onPress: () => pickMedia(bake!.id) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function confirmDelete() {
    Alert.alert('Delete this bake?', 'Its notes, photos and videos are deleted too.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteBake(bake!.id);
          router.back();
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {finished ? (
        <Card style={{ backgroundColor: '#E3F1E4', borderColor: '#C5E1C7' }}>
          <Text style={[styles.text, { fontWeight: '600' }]}>Bake finished. Add a rating, notes and photos below.</Text>
        </Card>
      ) : null}
      <View style={{ gap: space(1) }}>
        <Pressable onPress={() => router.push({ pathname: '/recipe/[id]', params: { id: bake.recipe_id } })}>
          <Text style={styles.title}>{snapshot.name}</Text>
        </Pressable>
        <Text style={styles.muted}>
          {new Date(bake.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
          {bake.target_dough_g ? ` · ${formatGrams(bake.target_dough_g)} g dough` : ''}
          {bake.scale_factor && Math.abs(bake.scale_factor - 1) > 0.005 ? ` · × ${bake.scale_factor.toFixed(2)}` : ''}
        </Text>
      </View>

      {!bake.finished_at ? (
        <Button title="Continue guided bake" icon="timer-outline" onPress={() => router.push({ pathname: '/bake/guided', params: { id } })} />
      ) : null}

      <Card>
        <Text style={styles.label}>Rating</Text>
        <View style={[styles.row, { gap: space(3) }]}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Pressable
              key={n}
              accessibilityRole="button"
              accessibilityLabel={`${n} star${n > 1 ? 's' : ''}`}
              onPress={() => save({ rating: bake.rating === n ? null : n })}
              hitSlop={6}
            >
              <Text style={{ fontSize: 32, color: (bake.rating ?? 0) >= n ? colors.primary : colors.border }}>★</Text>
            </Pressable>
          ))}
        </View>
        <Field
          label="Notes"
          value={notes ?? ''}
          onChangeText={setNotes}
          onEndEditing={() => notes !== bake.notes && save({ notes: notes ?? '' })}
          multiline
          placeholder="Crumb, crust, what you'd change next time"
          style={{ minHeight: 100, textAlignVertical: 'top' }}
        />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.text}>Shared</Text>
            <Text style={styles.muted}>
              Show these notes, photos and videos on the recipe's page to anyone who can see the recipe.
            </Text>
          </View>
          <Switch
            value={bake.visibility === 'shared'}
            onValueChange={(on) => save({ visibility: on ? 'shared' : 'private' })}
            trackColor={{ true: colors.primary }}
          />
        </View>
      </Card>

      <SectionTitle right={<Button title="Add" icon="camera-outline" small variant="secondary" onPress={addMedia} />}>
        Photos and videos
      </SectionTitle>
      {media.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space(2) }}>
          {media.map((m) => (
            <Pressable key={m.id} onLongPress={() => removeMedia(m)} delayLongPress={400}>
              <MediaThumb item={m} size={104} />
            </Pressable>
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>No photos or videos yet.</Text>
      )}
      {media.length ? <Text style={styles.hint}>Press and hold to delete. Files upload on any connection.</Text> : null}

      {snapshot.steps.length ? (
        <Card>
          <SectionTitle>Steps</SectionTitle>
          {snapshot.steps.map((s, i) => {
            const r = bake.steps.find((x) => x.step_id === s.id);
            const actual = r?.actual_seconds;
            return (
              <View key={s.id} style={{ gap: 2 }}>
                <View style={styles.row}>
                  <Text style={[styles.text, { flex: 1 }]}>
                    {i + 1}. {s.title}
                  </Text>
                  <Text style={styles.muted}>
                    {actual != null ? describeSeconds(actual) : r?.started_at ? 'started' : 'not done'}
                    {s.timer_seconds ? ` / ${describeSeconds(s.timer_seconds)}` : ''}
                  </Text>
                </View>
                {r?.note ? <Text style={[styles.muted, { fontStyle: 'italic' }]}>“{r.note}”</Text> : null}
              </View>
            );
          })}
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Formula used</SectionTitle>
        <SummaryBar summary={snapshot.summary} />
        <FormulaTable ingredients={snapshot.ingredients} />
      </Card>

      <Button title="Delete bake" icon="trash-outline" variant="danger" onPress={confirmDelete} />
    </ScrollView>
  );
}
