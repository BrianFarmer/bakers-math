import { StyleSheet, Text, View } from 'react-native';
import { formatGrams, formatPercent } from '../lib/bakersMath';
import type { FormulaSummary } from '../lib/types';
import { colors, space } from './ui';

/** Total dough, flour, hydration, salt and prefermented flour. Starter flour and water are included. */
export function SummaryBar({ summary }: { summary: FormulaSummary }) {
  const items = [
    { label: 'Dough', value: summary.total_dough_g === null ? '–' : `${formatGrams(summary.total_dough_g)} g` },
    { label: 'Flour', value: summary.total_flour_g === null ? '–' : `${formatGrams(summary.total_flour_g)} g` },
    { label: 'Hydration', value: summary.hydration_pct === null ? '–' : `${formatPercent(summary.hydration_pct)}%` },
    { label: 'Salt', value: summary.salt_pct === null ? '–' : `${formatPercent(summary.salt_pct)}%` },
    { label: 'Prefermented', value: summary.prefermented_flour_pct === null ? '–' : `${formatPercent(summary.prefermented_flour_pct)}%` },
  ];
  return (
    <View style={s.bar} accessibilityRole="summary">
      {items.map((i) => (
        <View key={i.label} style={s.item}>
          <Text style={s.value} numberOfLines={1} adjustsFontSizeToFit>
            {i.value}
          </Text>
          <Text style={s.label} numberOfLines={1}>
            {i.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.primarySoft,
    borderRadius: 12,
    paddingVertical: space(2),
    paddingHorizontal: space(1),
  },
  item: { flex: 1, alignItems: 'center', paddingHorizontal: 2 },
  value: { fontSize: 15, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  label: { fontSize: 10, color: colors.muted, marginTop: 2 },
});
