import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FormulaTable } from '../../components/FormulaTable';
import { Button, colors, IconButton, Loading, space, styles } from '../../components/ui';
import { captureMedia } from '../../data/media';
import { cancelAlert, ensurePermission, scheduleTimerAlert } from '../../data/notifications';
import { getLocalBake, saveBake, saveGuidedState, upsertBakeStep } from '../../data/repo';
import type { GuidedState, LocalBake } from '../../lib/syncEngine';
import { addTime, formatDuration, newTimer, pause, remainingMs, settle, start, type TimerState } from '../../lib/timer';

const FIVE_MIN = 5 * 60_000;

export default function Guided() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [bake, setBake] = useState<LocalBake | null>(null);
  const [now, setNow] = useState(Date.now());
  const [noteOpen, setNoteOpen] = useState(false);
  const [showFormula, setShowFormula] = useState(false);
  const bakeRef = useRef<LocalBake | null>(null);
  const alerted = useRef(new Set<string>());

  useEffect(() => {
    getLocalBake(id).then((b) => {
      if (!b) return;
      const guided: GuidedState = b.guided ?? { position: b.current_step_position ?? 0, timers: {}, notifications: {} };
      bakeRef.current = { ...b, guided };
      setBake(bakeRef.current);
    });
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const steps = bake?.recipe_snapshot.steps ?? [];
  const position = Math.min(bake?.guided?.position ?? 0, Math.max(0, steps.length - 1));
  const step = steps[position];
  const timer: TimerState | null = step?.timer_seconds
    ? settle(bake?.guided?.timers[step.id] ?? newTimer(step.timer_seconds), now)
    : null;

  // Buzz when a timer runs out on screen; the scheduled notification brings the sound.
  useEffect(() => {
    if (step && timer?.status === 'finished' && !alerted.current.has(step.id)) {
      alerted.current.add(step.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [timer?.status, step]);

  /** Applies a change, saves it, and (for anything the server should know) queues a sync. */
  const commit = useCallback(async (next: LocalBake, { sync }: { sync: boolean }) => {
    bakeRef.current = next;
    setBake(next);
    if (sync) bakeRef.current = await saveBake(next);
    else await saveGuidedState(next);
  }, []);

  if (!bake) return <Loading />;
  const guided = bake.guided!;

  const withTimer = (b: LocalBake, stepId: string, t: TimerState, notificationId?: string | null): LocalBake => {
    const notifications = { ...b.guided!.notifications };
    if (notificationId === null) delete notifications[stepId];
    else if (notificationId) notifications[stepId] = notificationId;
    return { ...b, guided: { ...b.guided!, timers: { ...b.guided!.timers, [stepId]: t }, notifications } };
  };

  async function schedule(t: TimerState, stepTitle: string) {
    if (t.status !== 'running' || !t.endsAt) return null;
    return scheduleTimerAlert({ bakeId: bake!.id, stepTitle, recipeName: bake!.recipe_snapshot.name, endsAt: t.endsAt });
  }

  async function startTimer(b: LocalBake, index: number): Promise<LocalBake> {
    const s = b.recipe_snapshot.steps[index];
    if (!s?.timer_seconds) return b;
    const allowed = await ensurePermission();
    if (!allowed) {
      Alert.alert('Alerts are off', "Allow notifications in Settings so you hear when a timer ends, even with the phone locked.");
    }
    const t = start(b.guided!.timers[s.id] ?? newTimer(s.timer_seconds), Date.now());
    const notificationId = allowed ? await schedule(t, s.title) : null;
    let next = withTimer(b, s.id, t, notificationId ?? undefined);
    const record = next.steps.find((r) => r.step_id === s.id);
    if (!record?.started_at) next = upsertBakeStep(next, s.id, { started_at: new Date(t.startedAt!).toISOString() }) as LocalBake;
    return next;
  }

  async function onStart() {
    await commit(await startTimer(bake!, position), { sync: true });
  }

  async function onPause() {
    await cancelAlert(guided.notifications[step.id]);
    await commit(withTimer(bake!, step.id, pause(timer!, Date.now()), null), { sync: false });
  }

  async function onAddFive() {
    await cancelAlert(guided.notifications[step.id]);
    const t = addTime(timer!, FIVE_MIN, Date.now());
    alerted.current.delete(step.id);
    const notificationId = await schedule(t, step.title);
    await commit(withTimer(bake!, step.id, t, notificationId ?? null), { sync: false });
  }

  /** Leaves the current step (done or skipped) and moves on; the last step finishes the bake. */
  async function advance(markDone: boolean) {
    const nowIso = new Date().toISOString();
    await cancelAlert(guided.notifications[step.id]);
    let next: LocalBake = bake!;
    if (timer) next = withTimer(next, step.id, timer.status === 'running' ? pause(timer, Date.now()) : timer, null);
    if (markDone) {
      const record = next.steps.find((r) => r.step_id === step.id);
      next = upsertBakeStep(next, step.id, {
        started_at: record?.started_at ?? guided.enteredAt ?? nowIso,
        ended_at: nowIso,
      }) as LocalBake;
    }
    const nextPos = position + 1;
    if (nextPos >= steps.length) {
      next = { ...next, finished_at: nowIso, current_step_position: position, guided: { ...next.guided!, position } };
      await commit(next, { sync: true });
      router.replace({ pathname: '/bake/[id]', params: { id: bake!.id, finished: '1' } });
      return;
    }
    next = { ...next, current_step_position: nextPos, guided: { ...next.guided!, position: nextPos, enteredAt: nowIso } };
    const upcoming = steps[nextPos];
    if (upcoming.auto_start && upcoming.timer_seconds) next = await startTimer(next, nextPos);
    await commit(next, { sync: true });
  }

  async function goTo(index: number) {
    if (index === position) return;
    await commit(
      { ...bake!, current_step_position: index, guided: { ...guided, position: index, enteredAt: new Date().toISOString() } },
      { sync: true },
    );
  }

  async function saveNote(note: string) {
    await commit(upsertBakeStep(bake!, step.id, { note }) as LocalBake, { sync: true });
    setNoteOpen(false);
  }

  if (!steps.length) {
    return (
      <SafeAreaView style={[styles.screen, { padding: space(6), justifyContent: 'center', gap: space(4) }]}>
        <Text style={styles.title}>This recipe has no steps</Text>
        <Text style={styles.muted}>Add steps with timers in the recipe editor. You can still log notes, photos and videos for this bake.</Text>
        <Button title="Go to the bake" onPress={() => router.replace({ pathname: '/bake/[id]', params: { id: bake.id } })} />
      </SafeAreaView>
    );
  }

  const left = timer ? remainingMs(timer, now) : 0;
  const note = bake.steps.find((r) => r.step_id === step.id)?.note ?? '';

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: '#FFFDF9' }]}>
      <View style={g.top}>
        <IconButton icon="close" label="Leave guided mode" onPress={() => router.back()} color={colors.text} />
        <Text style={g.recipeName} numberOfLines={1}>
          {bake.recipe_snapshot.name}
        </Text>
        <IconButton icon="list-outline" label="Show formula" onPress={() => setShowFormula(true)} color={colors.text} />
      </View>

      <View style={g.dots} accessibilityLabel={`Step ${position + 1} of ${steps.length}`}>
        {steps.map((s, i) => {
          const done = bake.steps.some((r) => r.step_id === s.id && r.ended_at);
          return (
            <Pressable
              key={s.id}
              onPress={() => goTo(i)}
              hitSlop={6}
              style={[g.dot, done && { backgroundColor: colors.primary }, i === position && g.dotCurrent]}
            />
          );
        })}
      </View>

      <ScrollView contentContainerStyle={g.body}>
        <Text style={g.stepCount}>
          Step {position + 1} of {steps.length}
        </Text>
        <Text style={g.stepTitle}>{step.title}</Text>
        {step.instructions ? <Text style={g.instructions}>{step.instructions}</Text> : null}

        {timer ? (
          <View style={g.timerBox}>
            <Text
              style={[g.time, timer.status === 'finished' && { color: colors.success }]}
              accessibilityRole="timer"
              accessibilityLabel={`${formatDuration(left)} left`}
            >
              {timer.status === 'finished' ? "Time's up" : formatDuration(left)}
            </Text>
            <Text style={styles.muted}>
              {timer.status === 'idle' ? (step.auto_start ? 'Starts automatically' : 'Start when you are ready') : null}
              {timer.status === 'paused' ? 'Paused' : null}
              {timer.status === 'running' ? `Ends at ${new Date(timer.endsAt!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : null}
            </Text>
          </View>
        ) : null}

        {note ? (
          <Pressable onPress={() => setNoteOpen(true)} style={g.note}>
            <Ionicons name="document-text-outline" size={16} color={colors.muted} />
            <Text style={[styles.text, { flex: 1 }]}>{note}</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <View style={g.controls}>
        {timer ? (
          <View style={[styles.row, { gap: space(2) }]}>
            {timer.status === 'running' ? (
              <Button title="Pause" icon="pause" variant="secondary" onPress={onPause} style={{ flex: 1 }} />
            ) : timer.status !== 'finished' ? (
              <Button title={timer.status === 'paused' ? 'Resume' : 'Start'} icon="play" onPress={onStart} style={{ flex: 1 }} />
            ) : null}
            <Button title="+5 min" variant="secondary" onPress={onAddFive} style={{ flex: timer.status === 'finished' ? 1 : undefined }} />
          </View>
        ) : null}
        <View style={[styles.row, { gap: space(2) }]}>
          {timer ? <Button title="Skip" variant="ghost" onPress={() => advance(false)} /> : null}
          <Button
            title={position === steps.length - 1 ? 'Finish bake' : timer ? 'Done' : 'Next'}
            icon={position === steps.length - 1 ? 'checkmark-done' : 'arrow-forward'}
            variant={timer && timer.status !== 'finished' ? 'secondary' : 'primary'}
            onPress={() => advance(true)}
            style={{ flex: 1 }}
          />
        </View>
        <View style={[styles.row, { justifyContent: 'center', gap: space(6) }]}>
          <Button title="Note" icon="create-outline" variant="ghost" small onPress={() => setNoteOpen(true)} />
          <Button title="Photo / video" icon="camera-outline" variant="ghost" small onPress={() => captureMedia(bake.id)} />
        </View>
      </View>

      <NoteSheet visible={noteOpen} initial={note} stepTitle={step.title} onCancel={() => setNoteOpen(false)} onSave={saveNote} />

      <Modal visible={showFormula} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowFormula(false)}>
        <SafeAreaView style={styles.screen}>
          <View style={g.top}>
            <Text style={[styles.sectionTitle, { flex: 1, paddingLeft: space(3) }]}>Formula for this bake</Text>
            <IconButton icon="close" label="Close" onPress={() => setShowFormula(false)} color={colors.text} />
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <FormulaTable ingredients={bake.recipe_snapshot.ingredients} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function NoteSheet(props: { visible: boolean; initial: string; stepTitle: string; onCancel(): void; onSave(note: string): void }) {
  const [text, setText] = useState(props.initial);
  useEffect(() => {
    if (props.visible) setText(props.initial);
  }, [props.visible, props.initial]);
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onCancel}>
      <SafeAreaView style={[styles.screen, { padding: space(4), gap: space(3) }]}>
        <View style={styles.row}>
          <Button title="Cancel" variant="ghost" small onPress={props.onCancel} />
          <Text style={[styles.text, { flex: 1, textAlign: 'center', fontWeight: '600' }]} numberOfLines={1}>
            Note on {props.stepTitle}
          </Text>
          <Button title="Save" small onPress={() => props.onSave(text.trim())} />
        </View>
        <TextInput
          autoFocus
          multiline
          value={text}
          onChangeText={setText}
          placeholder="Shaping was sticky at 78%"
          placeholderTextColor={colors.muted}
          style={[styles.input, { minHeight: 160, textAlignVertical: 'top' }]}
        />
      </SafeAreaView>
    </Modal>
  );
}

const g = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(2), paddingVertical: space(1) },
  recipeName: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', color: colors.muted },
  dots: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: space(2), paddingVertical: space(2) },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.border },
  dotCurrent: { borderWidth: 2, borderColor: colors.primary, width: 14, height: 14, borderRadius: 7, marginTop: -2 },
  body: { padding: space(6), gap: space(4), flexGrow: 1 },
  stepCount: { fontSize: 14, fontWeight: '600', color: colors.primary, textTransform: 'uppercase', letterSpacing: 1 },
  stepTitle: { fontSize: 34, fontWeight: '800', color: colors.text },
  instructions: { fontSize: 19, lineHeight: 27, color: colors.text },
  timerBox: { alignItems: 'center', paddingVertical: space(6), gap: space(1) },
  time: { fontSize: 76, fontWeight: '300', color: colors.text, fontVariant: ['tabular-nums'] },
  note: { flexDirection: 'row', gap: space(2), backgroundColor: colors.primarySoft, padding: space(3), borderRadius: 10 },
  controls: { padding: space(4), gap: space(3), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
