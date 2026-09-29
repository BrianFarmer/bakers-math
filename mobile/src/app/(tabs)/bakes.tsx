import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { FlatList, Pressable, Text, View } from 'react-native';
import { MediaThumb } from '../../components/MediaThumb';
import { Badge, colors, Empty, space, styles } from '../../components/ui';
import { db, useLiveQuery } from '../../data/db';
import { listBakes, listLocalMedia } from '../../data/repo';
import type { LocalBake, LocalMedia } from '../../lib/syncEngine';

async function load() {
  const [bakes, media, queued] = await Promise.all([
    listBakes(),
    listLocalMedia(),
    db.getAllAsync<{ entity_id: string }>(`SELECT entity_id FROM outbox WHERE kind = 'bake'`),
  ]);
  const byBake = new Map<string, LocalMedia[]>();
  for (const m of media) byBake.set(m.bake_id, [...(byBake.get(m.bake_id) ?? []), m]);
  return { bakes, byBake, queued: new Set(queued.map((q) => q.entity_id)) };
}

export default function BakeLog() {
  const data = useLiveQuery(load, []);
  return (
    <View style={styles.screen}>
      <FlatList
        data={data?.bakes ?? []}
        keyExtractor={(b) => b.id}
        contentContainerStyle={[styles.content, { gap: space(3) }]}
        ListEmptyComponent={
          data ? <Empty icon="images-outline" title="No bakes yet" body="Start a bake from a recipe; it shows up here with its notes, photos and videos." /> : null
        }
        renderItem={({ item }) => <BakeRow bake={item} media={data!.byBake.get(item.id) ?? []} queued={data!.queued.has(item.id)} />}
      />
    </View>
  );
}

function BakeRow({ bake, media, queued }: { bake: LocalBake; media: LocalMedia[]; queued: boolean }) {
  const local = media.find((m) => m.kind === 'photo') ?? media[0];
  const remote = bake.media.find((m) => m.kind === 'photo') ?? bake.media[0];
  const thumb = local ? { id: local.id, kind: local.kind, local_uri: local.local_uri } : remote ? { id: remote.id, kind: remote.kind } : null;
  const count = new Set([...media.map((m) => m.id), ...bake.media.map((m) => m.id)]).size;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/bake/[id]', params: { id: bake.id } })}
      style={({ pressed }) => [
        { flexDirection: 'row', gap: space(3), backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: space(3) },
        pressed && { opacity: 0.8 },
      ]}
    >
      {thumb ? (
        <View pointerEvents="none">
          <MediaThumb item={thumb} size={72} />
        </View>
      ) : (
        <View style={{ width: 72, height: 72, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="restaurant-outline" size={28} color={colors.primary} />
        </View>
      )}
      <View style={{ flex: 1, gap: space(1), justifyContent: 'center' }}>
        <Text style={[styles.text, { fontWeight: '600' }]} numberOfLines={1}>
          {bake.recipe_snapshot.name}
        </Text>
        <Text style={styles.muted}>
          {new Date(bake.started_at).toLocaleDateString([], { dateStyle: 'medium' })}
          {bake.rating ? ` · ${'★'.repeat(bake.rating)}` : ''}
          {count ? ` · ${count} ${count === 1 ? 'photo/video' : 'photos/videos'}` : ''}
        </Text>
        <View style={[styles.row, { gap: space(1) }]}>
          {!bake.finished_at ? <Badge text="In progress" tone="primary" /> : null}
          {bake.visibility === 'shared' ? <Badge text="Shared" tone="success" /> : null}
          {queued ? <Badge text="Not synced" tone="warning" /> : null}
        </View>
      </View>
    </Pressable>
  );
}
