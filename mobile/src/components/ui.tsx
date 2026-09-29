import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

export const colors = {
  bg: '#FAF6F0',
  surface: '#FFFFFF',
  text: '#2B2118',
  muted: '#7A6A5C',
  border: '#E6DCCF',
  primary: '#A8581C',
  primaryText: '#FFFFFF',
  primarySoft: '#F5E6D6',
  danger: '#B3261E',
  success: '#2E7D32',
  warning: '#9A6B00',
};

export const space = (n: number) => n * 4;

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  small,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const v = buttonVariants[variant];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: v.bg, borderColor: v.border },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={small ? 16 : 20} color={v.fg} /> : null}
          <Text style={[styles.buttonText, small && { fontSize: 14 }, { color: v.fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

const buttonVariants = {
  primary: { bg: colors.primary, fg: colors.primaryText, border: colors.primary },
  secondary: { bg: colors.surface, fg: colors.primary, border: colors.border },
  danger: { bg: colors.surface, fg: colors.danger, border: colors.border },
  ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
};

export function IconButton({
  icon,
  onPress,
  label,
  color = colors.primary,
  size = 22,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  label: string;
  color?: string;
  size?: number;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.iconButton, (pressed || disabled) && { opacity: 0.5 }]}
    >
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}

export function Field({ label, hint, style, ...props }: TextInputProps & { label?: string; hint?: string }) {
  return (
    <View style={{ gap: space(1) }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput placeholderTextColor={colors.muted} style={[styles.input, style]} {...props} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * A number box that keeps what the baker is typing while focused and shows the formatted value
 * otherwise, so live conversion never fights the cursor.
 */
export function NumberInput({
  value,
  onChange,
  format,
  parse,
  editable = true,
  style,
  placeholder,
  accessibilityLabel,
  suffix,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  format: (n: number | null) => string;
  parse: (s: string) => number | null;
  editable?: boolean;
  style?: StyleProp<TextStyle>;
  placeholder?: string;
  accessibilityLabel?: string;
  suffix?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(format(value));
  const last = useRef(value);
  useEffect(() => {
    if (!focused && value !== last.current) setText(format(value));
    last.current = value;
  }, [value, focused, format]);
  return (
    <View style={styles.numberWrap}>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        editable={editable}
        keyboardType="decimal-pad"
        selectTextOnFocus
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        value={focused ? text : format(value)}
        onFocus={() => {
          setText(format(value));
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChangeText={(t) => {
          setText(t);
          onChange(parse(t));
        }}
        style={[styles.input, styles.number, !editable && styles.inputDisabled, style]}
      />
      {suffix ? <Text style={styles.suffix}>{suffix}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'primary' | 'success' | 'warning' }) {
  const t = {
    neutral: { bg: '#EFE8DF', fg: colors.muted },
    primary: { bg: colors.primarySoft, fg: colors.primary },
    success: { bg: '#E3F1E4', fg: colors.success },
    warning: { bg: '#FBF0D4', fg: colors.warning },
  }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }]}>
      <Text style={[styles.badgeText, { color: t.fg }]}>{text}</Text>
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable
          key={o.value}
          accessibilityRole="button"
          accessibilityState={{ selected: o.value === value }}
          onPress={() => onChange(o.value)}
          style={[styles.segment, o.value === value && styles.segmentActive]}
        >
          <Text style={[styles.segmentText, o.value === value && styles.segmentTextActive]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Empty({ icon, title, body, children }: { icon: keyof typeof Ionicons.glyphMap; title: string; body?: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={40} color={colors.muted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {children}
    </View>
  );
}

export function Loading() {
  return (
    <View style={[styles.empty, { flex: 1 }]}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space(4), gap: space(4), paddingBottom: space(12) },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space(2),
    minHeight: 48,
    paddingHorizontal: space(4),
    borderRadius: 12,
    borderWidth: 1,
  },
  buttonSmall: { minHeight: 36, paddingHorizontal: space(3), borderRadius: 10 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  iconButton: { padding: space(1) },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted },
  hint: { fontSize: 12, color: colors.muted },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: space(3),
    paddingVertical: space(2.5),
    fontSize: 16,
    color: colors.text,
  },
  inputDisabled: { backgroundColor: '#F2ECE4', color: colors.muted },
  numberWrap: { flexDirection: 'row', alignItems: 'center', flexGrow: 1, flexShrink: 1, minWidth: 0 },
  number: { textAlign: 'right', flex: 1, minWidth: 0, fontVariant: ['tabular-nums'] },
  suffix: { marginLeft: space(1), color: colors.muted, fontSize: 14, width: 16 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space(4),
    gap: space(3),
  },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  badge: { borderRadius: 999, paddingHorizontal: space(2), paddingVertical: 2, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '600' },
  segmented: { flexDirection: 'row', backgroundColor: '#EFE8DF', borderRadius: 10, padding: 3 },
  segment: { flex: 1, paddingVertical: space(2), alignItems: 'center', borderRadius: 8 },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  segmentTextActive: { color: colors.text },
  empty: { alignItems: 'center', justifyContent: 'center', padding: space(8), gap: space(2) },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.text, textAlign: 'center' },
  emptyBody: { fontSize: 14, color: colors.muted, textAlign: 'center' },
  text: { fontSize: 16, color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
});
