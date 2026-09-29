import { StyleSheet, Text, View } from 'react-native';
import { formatGrams, formatPercent } from '../lib/bakersMath';
import { ROLES, type Ingredient } from '../lib/types';
import { colors, space } from './ui';

const roleLabel = (r: Ingredient['role']) => ROLES.find((x) => x.value === r)?.label ?? r;

/** Read-only formula: name, role, grams and baker's percentage. */
export function FormulaTable({ ingredients }: { ingredients: Ingredient[] }) {
  const totalG = ingredients.every((i) => i.grams !== null) ? ingredients.reduce((a, i) => a + (i.grams ?? 0), 0) : null;
  const totalP = ingredients.every((i) => i.percent !== null) ? ingredients.reduce((a, i) => a + (i.percent ?? 0), 0) : null;
  return (
    <View>
      <View style={[s.row, s.head]}>
        <Text style={[s.name, s.headText]}>Ingredient</Text>
        <Text style={[s.num, s.headText]}>Grams</Text>
        <Text style={[s.num, s.headText]}>%</Text>
      </View>
      {ingredients.map((i) => (
        <View key={i.id} style={s.row}>
          <View style={s.name}>
            <Text style={s.text}>{i.name}</Text>
            <Text style={s.role}>
              {roleLabel(i.role)}
              {i.role === 'leaven' ? ` · ${formatPercent(i.leaven_hydration ?? 100)}% hydration` : ''}
            </Text>
          </View>
          <Text style={[s.num, s.text]}>{formatGrams(i.grams, i.role) || '–'}</Text>
          <Text style={[s.num, s.text]}>{formatPercent(i.percent) || '–'}</Text>
        </View>
      ))}
      <View style={[s.row, s.total]}>
        <Text style={[s.name, s.bold]}>Total</Text>
        <Text style={[s.num, s.bold]}>{totalG === null ? '–' : formatGrams(totalG)}</Text>
        <Text style={[s.num, s.bold]}>{totalP === null ? '–' : formatPercent(totalP)}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space(2),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  head: { paddingTop: 0 },
  headText: { fontSize: 12, fontWeight: '600', color: colors.muted },
  name: { flex: 1 },
  num: { width: 72, textAlign: 'right', fontVariant: ['tabular-nums'] },
  text: { fontSize: 16, color: colors.text },
  role: { fontSize: 12, color: colors.muted, marginTop: 1 },
  total: { borderBottomWidth: 0 },
  bold: { fontSize: 16, fontWeight: '700', color: colors.text },
});
