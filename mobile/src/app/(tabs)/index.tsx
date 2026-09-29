import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { RecipeRow } from '../../components/RecipeRow';
import { Button, Empty, Field, space, styles } from '../../components/ui';
import { useLiveQuery } from '../../data/db';
import { listRecipes } from '../../data/repo';

export default function MyRecipes() {
  const [q, setQ] = useState('');
  const recipes = useLiveQuery(() => listRecipes(q), [q]);

  return (
    <View style={styles.screen}>
      <FlatList
        data={recipes ?? []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={[styles.content, { gap: space(3) }]}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: space(3) }}>
            <Field value={q} onChangeText={setQ} placeholder="Search by name or tag" clearButtonMode="while-editing" autoCorrect={false} />
            <Button title="New recipe" icon="add" onPress={() => router.push('/recipe/edit')} />
          </View>
        }
        ListEmptyComponent={
          recipes ? (
            <Empty
              icon="book-outline"
              title={q ? 'No recipes match' : 'No recipes yet'}
              body={q ? undefined : 'Write your first formula, or find one in Discover and download it.'}
            />
          ) : null
        }
        renderItem={({ item }) => (
          <RecipeRow
            recipe={item.doc}
            onPress={() => router.push({ pathname: '/recipe/[id]', params: { id: item.id } })}
            badges={[
              item.origin === 'download'
                ? { text: `Downloaded · ${item.doc.owner.display_name}`, tone: 'primary' as const }
                : item.doc.visibility === 'public'
                  ? { text: 'Public', tone: 'success' as const }
                  : { text: 'Private' },
              ...(item.queued ? [{ text: 'Not synced', tone: 'warning' as const }] : []),
            ]}
          />
        )}
      />
    </View>
  );
}
