import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { RecipeRow } from '../../components/RecipeRow';
import { Button, colors, Empty, Field, space, styles } from '../../components/ui';
import { useSession } from '../../data/session';
import { useSync } from '../../data/sync';
import { errorMessage, isNetworkError } from '../../lib/api';
import type { Recipe } from '../../lib/types';

interface Page {
  items: Recipe[];
  next_cursor: string | null;
}

/** Public recipes from every baker. Needs a connection. Type #tag to filter by tag. */
export default function Discover() {
  const { api } = useSession();
  const { reportReachable } = useSync();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Recipe[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ offline: boolean; message: string } | null>(null);

  const load = useCallback(
    async (query: string, after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const params: Record<string, string> = { sort: 'recent', limit: '20' };
        const t = query.trim();
        if (t.startsWith('#')) params.tag = t.slice(1).toLowerCase();
        else if (t) params.q = t;
        if (after) params.cursor = after;
        const qs = Object.entries(params)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join('&');
        const page = await api.get<Page>(`/public/recipes?${qs}`);
        reportReachable(true);
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch (e) {
        if (isNetworkError(e)) reportReachable(false);
        setError({ offline: isNetworkError(e), message: errorMessage(e) });
      } finally {
        setLoading(false);
      }
    },
    [api, reportReachable],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(q, null), 300);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(r) => r.id}
        contentContainerStyle={[styles.content, { gap: space(3) }]}
        keyboardShouldPersistTaps="handled"
        onRefresh={() => load(q, null)}
        refreshing={false}
        ListHeaderComponent={
          <Field value={q} onChangeText={setQ} placeholder="Search public recipes, or #tag" autoCapitalize="none" autoCorrect={false} />
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: space(8) }} />
          ) : error ? (
            <Empty
              icon={error.offline ? 'cloud-offline-outline' : 'alert-circle-outline'}
              title={error.offline ? 'Discover needs a connection' : "Couldn't load recipes"}
              body={error.offline ? 'Your own and downloaded recipes still work offline.' : error.message}
            >
              <Button title="Try again" variant="secondary" small onPress={() => load(q, null)} />
            </Empty>
          ) : (
            <Empty icon="compass-outline" title="No public recipes found" />
          )
        }
        renderItem={({ item }) => (
          <RecipeRow
            recipe={item}
            onPress={() => router.push({ pathname: '/recipe/[id]', params: { id: item.id } })}
            badges={[{ text: `By ${item.owner.display_name}`, tone: 'primary' }]}
          />
        )}
        ListFooterComponent={
          cursor && items.length ? <Button title="Load more" variant="ghost" loading={loading} onPress={() => load(q, cursor)} /> : null
        }
      />
    </View>
  );
}
