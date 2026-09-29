import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { FormulaTable } from '../../components/FormulaTable';
import { SummaryBar } from '../../components/SummaryBar';
import { Button, Card, Loading, NumberInput, Segmented, space, styles } from '../../components/ui';
import { getRemoteRecipe } from '../../data/online';
import { getLocalRecipe, startBake } from '../../data/repo';
import { formatGrams, parseNumber, scaleFormula, summarize, toFormula } from '../../lib/bakersMath';
import type { Recipe } from '../../lib/types';

type By = 'as_is' | 'dough' | 'loaves' | 'flour';

export default function Scale() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [by, setBy] = useState<By>('as_is');
  const [dough, setDough] = useState<number | null>(null);
  const [loaves, setLoaves] = useState<number | null>(null);
  const [perLoaf, setPerLoaf] = useState<number | null>(null);
  const [flour, setFlour] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    (async () => {
      const r = (await getLocalRecipe(id))?.doc ?? getRemoteRecipe(id);
      if (!r) return;
      setRecipe(r);
      const f = toFormula(r.input_mode, r.ingredients, r.base_flour_g);
      const total = summarize(f.ingredients).total_dough_g;
      setDough(total ? Math.round(total) : null);
      setLoaves(r.yield_count ?? 1);
      setPerLoaf(r.yield_unit_weight_g ?? (total && r.yield_count ? Math.round(total / r.yield_count) : null));
      setFlour(f.baseFlourG ? Math.round(f.baseFlourG) : null);
      if (!total) setBy('dough');
    })();
  }, [id]);

  if (!recipe) return <Loading />;

  const formula = toFormula(recipe.input_mode, recipe.ingredients, recipe.base_flour_g);
  const original = summarize(formula.ingredients).total_dough_g;
  const request =
    by === 'dough'
      ? { target_dough_g: dough ?? undefined }
      : by === 'loaves'
        ? { target_dough_g: loaves && perLoaf ? loaves * perLoaf : undefined }
        : by === 'flour'
          ? { base_flour_g: flour ?? undefined }
          : {};
  const scaled = scaleFormula(formula, request);
  const summary = summarize(scaled.formula.ingredients);
  const ready = summary.total_dough_g !== null && summary.total_dough_g > 0;

  async function start() {
    setStarting(true);
    try {
      const bake = await startBake(recipe!, scaled.formula.ingredients, scaled.scale_factor, summary.total_dough_g);
      router.replace({ pathname: '/bake/guided', params: { id: bake.id } });
    } finally {
      setStarting(false);
    }
  }

  const options: { value: By; label: string }[] = [
    ...(original ? [{ value: 'as_is' as const, label: 'As written' }] : []),
    { value: 'dough', label: 'Dough' },
    { value: 'loaves', label: 'Loaves' },
    { value: 'flour', label: 'Flour' },
  ];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{recipe.name}</Text>
      <Segmented options={options} value={by} onChange={setBy} />
      {by === 'dough' ? (
        <Labeled label="Total dough weight">
          <NumberInput value={dough} onChange={setDough} format={(n) => formatGrams(n)} parse={parseNumber} suffix="g" />
        </Labeled>
      ) : null}
      {by === 'loaves' ? (
        <View style={[styles.row, { gap: space(3) }]}>
          <Labeled label="Loaves">
            <NumberInput value={loaves} onChange={setLoaves} format={(n) => (n === null ? '' : String(n))} parse={parseNumber} />
          </Labeled>
          <Labeled label="Weight per loaf">
            <NumberInput value={perLoaf} onChange={setPerLoaf} format={(n) => formatGrams(n)} parse={parseNumber} suffix="g" />
          </Labeled>
        </View>
      ) : null}
      {by === 'flour' ? (
        <Labeled label="Flour weight (100%)">
          <NumberInput value={flour} onChange={setFlour} format={(n) => formatGrams(n)} parse={parseNumber} suffix="g" />
        </Labeled>
      ) : null}

      <SummaryBar summary={summary} />
      <Card>
        <FormulaTable ingredients={scaled.formula.ingredients} />
        {original && ready ? <Text style={styles.muted}>Scale × {scaled.scale_factor.toFixed(2)}</Text> : null}
      </Card>
      <Button title="Start bake" icon="flame-outline" onPress={start} disabled={!ready} loading={starting} />
      <Text style={styles.hint}>Starting a bake adds it to your bake log. It works offline and syncs later.</Text>
    </ScrollView>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, gap: space(1) }}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}
