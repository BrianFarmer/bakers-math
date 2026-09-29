import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import { formatGrams, formatPercent } from '../lib/bakersMath';
import type { Recipe } from '../lib/types';
import { Badge, colors, space, styles } from './ui';

export function RecipeRow({
  recipe,
  onPress,
  badges = [],
}: {
  recipe: Pick<Recipe, 'name' | 'tags' | 'summary' | 'owner'> & Partial<Recipe>;
  onPress: () => void;
  badges?: { text: string; tone?: 'neutral' | 'primary' | 'success' | 'warning' }[];
}) {
  const s = recipe.summary;
  const facts = [
    s?.hydration_pct != null ? `${formatPercent(s.hydration_pct)}% hydration` : null,
    s?.total_dough_g != null ? `${formatGrams(s.total_dough_g)} g dough` : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        {
          backgroundColor: colors.surface,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: colors.border,
          padding: space(4),
          flexDirection: 'row',
          alignItems: 'center',
          gap: space(3),
        },
        pressed && { opacity: 0.8 },
      ]}
    >
      <View style={{ flex: 1, gap: space(1) }}>
        <Text style={[styles.text, { fontWeight: '600', fontSize: 17 }]}>{recipe.name || 'Untitled recipe'}</Text>
        {facts.length ? <Text style={styles.muted}>{facts.join(' · ')}</Text> : null}
        {badges.length || recipe.tags.length ? (
          <View style={[styles.row, { flexWrap: 'wrap', gap: space(1) }]}>
            {badges.map((b) => (
              <Badge key={b.text} text={b.text} tone={b.tone} />
            ))}
            {recipe.tags.slice(0, 4).map((t) => (
              <Badge key={`#${t}`} text={`#${t}`} />
            ))}
          </View>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
    </Pressable>
  );
}
