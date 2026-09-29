import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ServerField } from '../components/ServerField';
import { Button, colors, Field, Segmented, space, styles } from '../components/ui';
import { useSession } from '../data/session';
import { errorMessage } from '../lib/api';

export default function SignIn() {
  const session = useSession();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!session.serverUrl) {
      setError('Enter the server address first.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'in') await session.signIn(email.trim(), password);
      else await session.signUp(email.trim(), password, name.trim());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, { paddingTop: space(8) }]} keyboardShouldPersistTaps="handled">
          <View style={{ gap: space(1) }}>
            <Image source={require('../../assets/splash-icon.png')} style={{ width: 72, height: 72, marginLeft: -6 }} accessibilityIgnoresInvertColors />
            <Text style={[styles.title, { fontSize: 34 }]}>Bakers Math</Text>
            <Text style={styles.muted}>Recipes in grams or baker's percentages, guided bakes and a bake log.</Text>
          </View>
          <Segmented
            options={[
              { value: 'in', label: 'Sign in' },
              { value: 'up', label: 'Create account' },
            ]}
            value={mode}
            onChange={setMode}
          />
          {mode === 'up' ? <Field label="Your name" value={name} onChangeText={setName} autoComplete="name" placeholder="Shown on public recipes" /> : null}
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            textContentType={mode === 'in' ? 'password' : 'newPassword'}
            hint={mode === 'up' ? 'At least 8 characters' : undefined}
            onSubmitEditing={submit}
          />
          {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
          <Button title={mode === 'in' ? 'Sign in' : 'Create account'} onPress={submit} loading={busy} disabled={!email || !password} />
          {mode === 'in' ? <Button title="Forgot password?" variant="ghost" onPress={() => router.push('/reset-password')} /> : null}
          <View style={[styles.divider, { marginVertical: space(2) }]} />
          <ServerField />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
