import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { SummaryBar } from '../../components/SummaryBar';
import { Button, Card, colors, Field, IconButton, Loading, NumberInput, Segmented, space, styles } from '../../components/ui';
import { getLocalRecipe, newIngredient, newRecipe, newStep, saveRecipe } from '../../data/repo';
import { useUser } from '../../data/session';
import {
  fillFlourGap,
  flourGap,
  formatGrams,
  formatPercent,
  hasFlour,
  parseNumber,
  recompute,
  setBaseFlour,
  setGrams,
  setMode,
  setPercent,
  summarize,
  toFormula,
  type Formula,
} from '../../lib/bakersMath';
import { parseHhMm, toHhMm } from '../../lib/timer';
import { ROLES, type Ingredient, type IngredientRole, type Recipe, type Step } from '../../lib/types';

type Tab = 'formula' | 'steps' | 'settings';

export default function EditRecipe() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const user = useUser();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [formula, setFormula] = useState<Formula | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [tab, setTab] = useState<Tab>('formula');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const existing = id ? (await getLocalRecipe(id))?.doc : null;
      const r = existing ?? {
        ...newRecipe(user),
        ingredients: [
          { ...newIngredient('flour'), name: 'Bread flour' },
          { ...newIngredient('water'), name: 'Water' },
          { ...newIngredient('salt'), name: 'Salt' },
        ],
      };
      setRecipe(r);
      setFormula(toFormula(r.input_mode, r.ingredients, r.base_flour_g));
      setSteps(r.steps);
      setTags(r.tags.join(', '));
    })();
  }, [id, user]);

  if (!recipe || !formula) return <Loading />;

  const summary = summarize(formula.ingredients);
  const gap = formula.mode === 'percent' ? flourGap(formula.ingredients) : 0;
  const flourPresent = hasFlour(formula.ingredients);

  const update = (patch: Partial<Recipe>) => setRecipe({ ...recipe, ...patch });
  const updateRow = (index: number, patch: Partial<Ingredient>) => {
    const rows = formula.ingredients.map((r, i) => (i === index ? { ...r, ...patch } : r));
    setFormula(recompute({ ...formula, ingredients: rows }));
  };
  const moveRow = (index: number, delta: number) => {
    const rows = [...formula.ingredients];
    const [r] = rows.splice(index, 1);
    rows.splice(Math.max(0, Math.min(rows.length, index + delta)), 0, r);
    setFormula({ ...formula, ingredients: rows });
  };

  function problems(): string[] {
    const p: string[] = [];
    if (!recipe!.name.trim()) p.push('Give the recipe a name (Settings).');
    if (formula!.ingredients.some((i) => !i.name.trim())) p.push('Every ingredient needs a name.');
    if (formula!.mode === 'grams' && formula!.ingredients.some((i) => i.grams === null)) p.push('Every ingredient needs a weight.');
    if (formula!.mode === 'percent') {
      if (!flourPresent && formula!.ingredients.length) p.push('Add a flour before using percentages.');
      if (formula!.ingredients.some((i) => i.percent === null)) p.push('Every ingredient needs a percentage.');
      if (gap !== 0) p.push(`Flour percentages must add up to 100% (${formatPercent(100 - gap)}% now).`);
    }
    if (steps.some((s) => !s.title.trim())) p.push('Every step needs a title.');
    return p;
  }

  async function save() {
    const p = problems();
    if (p.length) {
      Alert.alert("Can't save yet", p.join('\n'));
      return;
    }
    setSaving(true);
    try {
      const saved = await saveRecipe({
        ...recipe!,
        name: recipe!.name.trim(),
        input_mode: formula!.mode,
        ingredients: formula!.ingredients.map((i) => ({ ...i, name: i.name.trim() })),
        base_flour_g: formula!.baseFlourG,
        steps: steps.map((s) => ({ ...s, title: s.title.trim() })),
        tags: [...new Set(tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))],
      });
      if (id) router.back();
      else router.replace({ pathname: '/recipe/[id]', params: { id: saved.id } });
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen
        options={{
          title: id ? 'Edit recipe' : 'New recipe',
          headerRight: () => <Button title="Save" small onPress={save} loading={saving} />,
        }}
      />
      <View style={{ padding: space(4), paddingBottom: space(2), gap: space(3) }}>
        <Segmented
          options={[
            { value: 'formula', label: 'Formula' },
            { value: 'steps', label: `Steps${steps.length ? ` (${steps.length})` : ''}` },
            { value: 'settings', label: 'Settings' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'formula' ? <SummaryBar summary={summary} /> : null}
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: space(2) }]} keyboardShouldPersistTaps="handled">
        {tab === 'formula' ? (
          <>
            <View style={{ gap: space(2) }}>
              <Text style={styles.label}>I enter</Text>
              <Segmented
                options={[
                  { value: 'grams', label: 'Grams' },
                  { value: 'percent', label: "Baker's %" },
                ]}
                value={formula.mode}
                onChange={(m) => setFormula(setMode(formula, m))}
              />
            </View>
            {formula.mode === 'percent' ? (
              <Card>
                <View style={[styles.row, { gap: space(3) }]}>
                  <View style={{ flex: 1, gap: space(1) }}>
                    <Text style={styles.label}>Flour weight (100%)</Text>
                    <NumberInput
                      value={formula.baseFlourG}
                      onChange={(n) => setFormula(setBaseFlour(formula, n))}
                      format={(n) => formatGrams(n)}
                      parse={parseNumber}
                      suffix="g"
                      placeholder="e.g. 1000"
                      editable={flourPresent}
                    />
                  </View>
                  <View style={{ flex: 1, gap: space(1) }}>
                    <Text style={styles.label}>or dough weight</Text>
                    <NumberInput
                      value={summary.total_dough_g}
                      onChange={(n) => {
                        const pct = formula.ingredients.reduce((a, i) => a + (i.percent ?? 0), 0);
                        if (n && pct > 0) setFormula(setBaseFlour(formula, (n * 100) / pct));
                      }}
                      format={(n) => formatGrams(n)}
                      parse={parseNumber}
                      suffix="g"
                      placeholder="e.g. 1800"
                      editable={flourPresent}
                    />
                  </View>
                </View>
                {!formula.baseFlourG ? <Text style={styles.hint}>Enter a flour or dough weight to see grams.</Text> : null}
              </Card>
            ) : null}
            {!flourPresent && formula.ingredients.length ? (
              <Text style={{ color: colors.warning }}>Add a flour first: percentages are relative to the flour.</Text>
            ) : null}
            {gap !== 0 ? (
              <Card style={{ borderColor: colors.warning, backgroundColor: '#FFF8E6' }}>
                <Text style={styles.text}>
                  Flour adds up to {formatPercent(100 - gap)}%, {formatPercent(Math.abs(gap))}% {gap > 0 ? 'short of' : 'over'} 100%.
                </Text>
                <Button title="Put the difference on the last flour" small variant="secondary" onPress={() => setFormula(fillFlourGap(formula))} />
              </Card>
            ) : null}

            {formula.ingredients.map((row, i) => (
              <IngredientEditor
                key={row.id}
                row={row}
                mode={formula.mode}
                percentEnabled={flourPresent}
                first={i === 0}
                last={i === formula.ingredients.length - 1}
                onName={(name) => updateRow(i, { name })}
                onRole={(role) =>
                  updateRow(i, { role, leaven_hydration: role === 'leaven' ? (row.leaven_hydration ?? 100) : null })
                }
                onHydration={(h) => updateRow(i, { leaven_hydration: h })}
                onGrams={(g) => setFormula(setGrams(formula, i, g))}
                onPercent={(p) => setFormula(setPercent(formula, i, p))}
                onMove={(d) => moveRow(i, d)}
                onRemove={() => setFormula(recompute({ ...formula, ingredients: formula.ingredients.filter((_, j) => j !== i) }))}
              />
            ))}
            <Button
              title="Add ingredient"
              icon="add"
              variant="secondary"
              onPress={() => setFormula(recompute({ ...formula, ingredients: [...formula.ingredients, newIngredient(flourPresent ? 'other' : 'flour')] }))}
            />
            <Text style={styles.hint}>
              Percentages are relative to the flour added directly to the dough. A starter's own flour and water are split using its
              hydration and counted in the hydration and prefermented flour above, not in the 100%.
            </Text>
          </>
        ) : null}

        {tab === 'steps' ? (
          <>
            {steps.map((s, i) => (
              <StepEditor
                key={s.id}
                index={i}
                step={s}
                first={i === 0}
                last={i === steps.length - 1}
                onChange={(patch) => setSteps(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
                onMove={(d) => {
                  const next = [...steps];
                  const [x] = next.splice(i, 1);
                  next.splice(Math.max(0, Math.min(next.length, i + d)), 0, x);
                  setSteps(next);
                }}
                onRemove={() => setSteps(steps.filter((_, j) => j !== i))}
              />
            ))}
            {!steps.length ? <Text style={styles.muted}>Add steps like autolyse 0:30, bulk 4:00, proof 1:00 and bake 0:45.</Text> : null}
            <Button title="Add step" icon="add" variant="secondary" onPress={() => setSteps([...steps, newStep()])} />
          </>
        ) : null}

        {tab === 'settings' ? (
          <>
            <Field label="Name" value={recipe.name} onChangeText={(name) => update({ name })} placeholder="Country loaf" />
            <Field
              label="Description"
              value={recipe.description}
              onChangeText={(description) => update({ description })}
              multiline
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
            <Field label="Tags" value={tags} onChangeText={setTags} placeholder="sourdough, rye" autoCapitalize="none" hint="Separate with commas" />
            <View style={[styles.row, { gap: space(3) }]}>
              <View style={{ flex: 1, gap: space(1) }}>
                <Text style={styles.label}>Loaves</Text>
                <NumberInput
                  value={recipe.yield_count}
                  onChange={(n) => update({ yield_count: n ? Math.round(n) : null })}
                  format={(n) => (n === null ? '' : String(n))}
                  parse={parseNumber}
                />
              </View>
              <View style={{ flex: 1, gap: space(1) }}>
                <Text style={styles.label}>Weight per loaf</Text>
                <NumberInput
                  value={recipe.yield_unit_weight_g}
                  onChange={(n) => update({ yield_unit_weight_g: n || null })}
                  format={(n) => formatGrams(n)}
                  parse={parseNumber}
                  suffix="g"
                />
              </View>
            </View>
            <Text style={styles.hint}>
              New recipes are private. You can make a recipe public from its page when you're connected.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function IngredientEditor(props: {
  row: Ingredient;
  mode: Formula['mode'];
  percentEnabled: boolean;
  first: boolean;
  last: boolean;
  onName(v: string): void;
  onRole(v: IngredientRole): void;
  onHydration(v: number | null): void;
  onGrams(v: number | null): void;
  onPercent(v: number | null): void;
  onMove(d: number): void;
  onRemove(): void;
}) {
  const { row } = props;
  const [picking, setPicking] = useState(false);
  const roleLabel = ROLES.find((r) => r.value === row.role)?.label;
  return (
    <Card style={{ gap: space(2), padding: space(3) }}>
      <View style={styles.row}>
        <TextInput
          value={row.name}
          onChangeText={props.onName}
          placeholder="Ingredient"
          placeholderTextColor={colors.muted}
          style={[styles.text, { flex: 1, fontWeight: '600', paddingVertical: space(1) }]}
        />
        <IconButton icon="chevron-up" label="Move up" onPress={() => props.onMove(-1)} disabled={props.first} size={20} />
        <IconButton icon="chevron-down" label="Move down" onPress={() => props.onMove(1)} disabled={props.last} size={20} />
        <IconButton icon="trash-outline" label="Remove ingredient" onPress={props.onRemove} color={colors.danger} size={20} />
      </View>
      <View style={[styles.row, { gap: space(2) }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Role: ${roleLabel}`}
          onPress={() => setPicking(!picking)}
          style={{ flex: 1.1, paddingVertical: space(2.5), paddingHorizontal: space(2), borderRadius: 10, backgroundColor: colors.primarySoft }}
        >
          <Text style={{ color: colors.primary, fontWeight: '600' }} numberOfLines={1}>
            {roleLabel} ▾
          </Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <NumberInput
            accessibilityLabel={`${row.name || 'Ingredient'} grams`}
            value={row.grams}
            onChange={props.onGrams}
            format={(n) => formatGrams(n, row.role)}
            parse={parseNumber}
            suffix="g"
            style={props.mode === 'grams' ? { borderColor: colors.primary } : undefined}
          />
        </View>
        <View style={{ flex: 1 }}>
          <NumberInput
            accessibilityLabel={`${row.name || 'Ingredient'} percent`}
            value={row.percent}
            onChange={props.onPercent}
            format={formatPercent}
            parse={parseNumber}
            suffix="%"
            editable={props.percentEnabled}
            style={props.mode === 'percent' ? { borderColor: colors.primary } : undefined}
          />
        </View>
      </View>
      {picking ? (
        <View style={[styles.row, { flexWrap: 'wrap', gap: space(1.5) }]}>
          {ROLES.map((r) => (
            <Pressable
              key={r.value}
              onPress={() => {
                props.onRole(r.value);
                setPicking(false);
              }}
              style={{
                paddingVertical: space(1.5),
                paddingHorizontal: space(3),
                borderRadius: 999,
                borderWidth: 1,
                borderColor: r.value === row.role ? colors.primary : colors.border,
                backgroundColor: r.value === row.role ? colors.primarySoft : colors.surface,
              }}
            >
              <Text style={{ color: r.value === row.role ? colors.primary : colors.text }}>{r.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {row.role === 'leaven' ? (
        <View style={[styles.row, { gap: space(2) }]}>
          <Text style={[styles.muted, { flex: 2.1 }]}>Starter hydration</Text>
          <View style={{ flex: 1 }}>
            <NumberInput value={row.leaven_hydration} onChange={props.onHydration} format={formatPercent} parse={parseNumber} suffix="%" />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

function StepEditor(props: {
  index: number;
  step: Step;
  first: boolean;
  last: boolean;
  onChange(patch: Partial<Step>): void;
  onMove(d: number): void;
  onRemove(): void;
}) {
  const { step } = props;
  const [timer, setTimer] = useState(toHhMm(step.timer_seconds));
  const timerValid = timer.trim() === '' || parseHhMm(timer) !== null;
  return (
    <Card style={{ gap: space(2), padding: space(3) }}>
      <View style={styles.row}>
        <Text style={[styles.muted, { width: 24 }]}>{props.index + 1}.</Text>
        <TextInput
          value={step.title}
          onChangeText={(title) => props.onChange({ title })}
          placeholder="Step title, e.g. Bulk ferment"
          placeholderTextColor={colors.muted}
          style={[styles.text, { flex: 1, fontWeight: '600', paddingVertical: space(1) }]}
        />
        <IconButton icon="chevron-up" label="Move up" onPress={() => props.onMove(-1)} disabled={props.first} size={20} />
        <IconButton icon="chevron-down" label="Move down" onPress={() => props.onMove(1)} disabled={props.last} size={20} />
        <IconButton icon="trash-outline" label="Remove step" onPress={props.onRemove} color={colors.danger} size={20} />
      </View>
      <Field
        value={step.instructions}
        onChangeText={(instructions) => props.onChange({ instructions })}
        placeholder="Instructions"
        multiline
        style={{ minHeight: 60, textAlignVertical: 'top' }}
      />
      <View style={[styles.row, { gap: space(3) }]}>
        <View style={{ width: 110, gap: space(1) }}>
          <Text style={styles.label}>Timer (h:mm)</Text>
          <TextInput
            value={timer}
            onChangeText={(t) => {
              setTimer(t);
              const secs = parseHhMm(t);
              if (t.trim() === '' || secs !== null) props.onChange({ timer_seconds: secs });
            }}
            placeholder="none"
            placeholderTextColor={colors.muted}
            keyboardType="numbers-and-punctuation"
            style={[styles.input, !timerValid && { borderColor: colors.danger }]}
          />
        </View>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space(2) }}>
          <Text style={[styles.muted, { flexShrink: 1 }]}>Start automatically</Text>
          <Switch
            value={step.auto_start}
            onValueChange={(auto_start) => props.onChange({ auto_start })}
            disabled={!step.timer_seconds}
            trackColor={{ true: colors.primary }}
          />
        </View>
      </View>
    </Card>
  );
}
