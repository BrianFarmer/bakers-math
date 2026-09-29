import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { FormulaTable } from '../../components/FormulaTable';
import { MediaThumb } from '../../components/MediaThumb';
import { SummaryBar } from '../../components/SummaryBar';
import { Badge, Button, Card, colors, Loading, SectionTitle, space, styles, Toggle } from '../../components/ui';
import { sqliteStore, useLiveQuery } from '../../data/db';
import { cacheRemoteRecipe, getRemoteRecipe, useOnlineAction } from '../../data/online';
import { deleteRecipe, getLocalRecipe, listBakes, listVersions, storeDownload } from '../../data/repo';
import { useSession, useUser } from '../../data/session';
import { summarize, toFormula } from '../../lib/bakersMath';
import { describeSeconds } from '../../lib/timer';
import type { Bake, Recipe } from '../../lib/types';

export default function RecipeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const user = useUser();
  const { run, busy } = useOnlineAction();
  const local = useLiveQuery(() => getLocalRecipe(id), [id]);
  const bakes = useLiveQuery(() => listBakes(id), [id]);
  const versions = useLiveQuery(() => listVersions(id), [id]);
  const [remote, setRemote] = useState<Recipe | null>(getRemoteRecipe(id));
  const [sharedBakes, setSharedBakes] = useState<Bake[] | null>(null);

  // Not on the phone: someone's public recipe opened from Discover.
  useEffect(() => {
    if (local !== null || remote) return;
    void run('Opening this recipe', async () => {
      const r = await api.get<Recipe>(`/recipes/${id}`);
      cacheRemoteRecipe(r);
      setRemote(r);
    });
  }, [local, remote, id, api, run]);

  const loadShared = useCallback(() => {
    api
      .get<{ items: Bake[] }>(`/recipes/${id}/shared-bakes?limit=20`)
      .then((r) => setSharedBakes(r.items.filter((b) => b.user?.id !== user.id)))
      .catch(() => setSharedBakes(null));
  }, [api, id, user.id]);
  useEffect(loadShared, [loadShared]);

  const recipe = local?.doc ?? remote;
  if (local === undefined || !recipe) return <Loading />;

  const own = recipe.owner.id === user.id;
  const downloaded = local?.origin === 'download';
  const formula = toFormula(recipe.input_mode, recipe.ingredients, recipe.base_flour_g);
  const summary = summarize(formula.ingredients);

  async function setPublic(pub: boolean) {
    const updated = await run(pub ? 'Making it public' : 'Making it private', () =>
      api.patch<Recipe>(`/recipes/${id}`, { visibility: pub ? 'public' : 'private' }),
    );
    if (updated && local) await sqliteStore.putRecipe({ ...local.doc, visibility: updated.visibility, published_at: updated.published_at }, 'own');
  }

  async function copy() {
    const copyOf = await run('Copying', () => api.post<Recipe>(`/recipes/${id}/copy`));
    if (copyOf) {
      await sqliteStore.putRecipe({ ...copyOf, base_flour_g: copyOf.summary?.base_flour_g ?? null }, 'own');
      router.replace({ pathname: '/recipe/[id]', params: { id: copyOf.id } });
    }
  }

  async function download() {
    const ok = await run('Downloading', async () => {
      await api.put(`/me/downloads/${id}`);
      return true;
    });
    if (ok) await storeDownload({ ...recipe!, base_flour_g: recipe!.summary?.base_flour_g ?? null });
  }

  async function removeDownload() {
    await run('Removing the download', async () => {
      await api.del(`/me/downloads/${id}`);
      await deleteRecipe(id);
      cacheRemoteRecipe(recipe!);
      setRemote(recipe!);
    });
  }

  function confirmDelete() {
    Alert.alert('Delete this recipe?', 'Its bakes stay in your bake log.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteRecipe(id);
          router.back();
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{
          title: '',
          headerRight: own ? () => <Button title="Edit" small variant="ghost" onPress={() => router.push({ pathname: '/recipe/edit', params: { id } })} /> : undefined,
        }}
      />
      <View style={{ gap: space(2) }}>
        <Text style={styles.title}>{recipe.name}</Text>
        <View style={[styles.row, { flexWrap: 'wrap', gap: space(1) }]}>
          {own ? (
            <Badge text={recipe.visibility === 'public' ? 'Public' : 'Private'} tone={recipe.visibility === 'public' ? 'success' : 'neutral'} />
          ) : (
            <Badge text={`By ${recipe.owner.display_name}`} tone="primary" />
          )}
          {downloaded ? <Badge text="Available offline" tone="primary" /> : null}
          {recipe.copied_from_id ? <Badge text="Copied" /> : null}
          {recipe.tags.map((t) => (
            <Badge key={t} text={`#${t}`} />
          ))}
        </View>
        {recipe.description ? <Text style={styles.text}>{recipe.description}</Text> : null}
        {recipe.yield_count ? (
          <Text style={styles.muted}>
            Makes {recipe.yield_count}
            {recipe.yield_unit_weight_g ? ` × ${Math.round(recipe.yield_unit_weight_g)} g` : ''}
          </Text>
        ) : null}
      </View>

      <Button title="Start bake" icon="flame-outline" onPress={() => router.push({ pathname: '/recipe/scale', params: { id } })} />

      <SummaryBar summary={summary} />
      <Card>
        <SectionTitle>Formula</SectionTitle>
        <FormulaTable ingredients={formula.ingredients} />
        {recipe.input_mode === 'percent' && summary.total_dough_g === null ? (
          <Text style={styles.muted}>Set a dough or flour weight when you scale to see grams.</Text>
        ) : null}
      </Card>

      {recipe.steps.length ? (
        <Card>
          <SectionTitle>Steps</SectionTitle>
          {recipe.steps.map((s, i) => (
            <View key={s.id} style={{ gap: 2 }}>
              <View style={styles.row}>
                <Text style={[styles.text, { fontWeight: '600', flex: 1 }]}>
                  {i + 1}. {s.title}
                </Text>
                {s.timer_seconds ? <Badge text={describeSeconds(s.timer_seconds)} tone="primary" /> : null}
              </View>
              {s.instructions ? <Text style={styles.muted}>{s.instructions}</Text> : null}
            </View>
          ))}
        </Card>
      ) : null}

      {own ? (
        <Card>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.text}>Public</Text>
              <Text style={styles.muted}>Anyone signed in can find, view and copy it. Needs a connection.</Text>
            </View>
            <Toggle
              value={recipe.visibility === 'public'}
              onValueChange={setPublic}
              disabled={busy}
            />
          </View>
        </Card>
      ) : (
        <View style={{ gap: space(2) }}>
          <Button title="Copy to my recipes" icon="copy-outline" variant="secondary" onPress={copy} loading={busy} />
          {downloaded ? (
            <Button title="Remove offline copy" icon="cloud-offline-outline" variant="secondary" onPress={removeDownload} />
          ) : (
            <Button title="Download for offline" icon="download-outline" variant="secondary" onPress={download} />
          )}
        </View>
      )}

      <SectionTitle>Your bakes</SectionTitle>
      {bakes?.length ? (
        bakes.map((b) => <BakeLine key={b.id} bake={b} />)
      ) : (
        <Text style={styles.muted}>No bakes yet.</Text>
      )}

      {sharedBakes?.length ? (
        <>
          <SectionTitle>Shared by other bakers</SectionTitle>
          {sharedBakes.map((b) => (
            <Card key={b.id} style={{ gap: space(2) }}>
              <Text style={[styles.text, { fontWeight: '600' }]}>
                {b.user?.display_name} · {new Date(b.started_at).toLocaleDateString()}
                {b.rating ? ` · ${'★'.repeat(b.rating)}` : ''}
              </Text>
              {b.notes ? <Text style={styles.text}>{b.notes}</Text> : null}
              {b.media.length ? (
                <ScrollView horizontal contentContainerStyle={{ gap: space(2) }}>
                  {b.media.map((m) => (
                    <MediaThumb key={m.id} item={{ id: m.id, kind: m.kind }} size={80} />
                  ))}
                </ScrollView>
              ) : null}
            </Card>
          ))}
        </>
      ) : null}

      {own ? (
        <View style={{ gap: space(2), marginTop: space(4) }}>
          {versions?.length ? (
            <Button
              title={`Older versions (${versions.length})`}
              icon="time-outline"
              variant="secondary"
              onPress={() => router.push({ pathname: '/recipe/versions', params: { id } })}
            />
          ) : null}
          <Button title="Delete recipe" icon="trash-outline" variant="danger" onPress={confirmDelete} />
        </View>
      ) : null}
    </ScrollView>
  );
}

function BakeLine({ bake }: { bake: Bake }) {
  const status = bake.finished_at ? (bake.rating ? '★'.repeat(bake.rating) : 'Finished') : 'In progress';
  return (
    <Button
      title={`${new Date(bake.started_at).toLocaleDateString()} · ${status}`}
      variant="secondary"
      icon={bake.finished_at ? 'checkmark-circle-outline' : 'timer-outline'}
      onPress={() =>
        bake.finished_at
          ? router.push({ pathname: '/bake/[id]', params: { id: bake.id } })
          : router.push({ pathname: '/bake/guided', params: { id: bake.id } })
      }
      style={{ justifyContent: 'flex-start' }}
    />
  );
}
