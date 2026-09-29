import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { Button, colors, Field, styles } from '../components/ui';
import { useSession } from '../data/session';
import { errorMessage } from '../lib/api';

/**
 * There's no email service yet: the API writes the reset link to its log
 * (docker compose logs api). The code is the `token` part of that link.
 */
export default function ResetPassword() {
  const { api } = useSession();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function request() {
    setBusy(true);
    setMessage(null);
    try {
      await api.anon('POST', '/auth/password-reset', { email: email.trim() });
      setSent(true);
      setMessage({ ok: true, text: 'If that account exists, a reset link is on its way. Paste the code from it below.' });
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setMessage(null);
    try {
      // Accept the whole link or just the token.
      const code = /token=([^&\s]+)/.exec(token)?.[1] ?? token.trim();
      await api.anon('POST', '/auth/password-reset/confirm', { token: decodeURIComponent(code), password });
      router.back();
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <Button title="Send reset link" onPress={request} loading={busy && !sent} disabled={!email} variant={sent ? 'secondary' : 'primary'} />
      {message ? <Text style={{ color: message.ok ? colors.success : colors.danger }}>{message.text}</Text> : null}
      <Field label="Reset code or link" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} />
      <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry hint="At least 8 characters" />
      <Button title="Set new password" onPress={confirm} loading={busy && sent} disabled={!token || password.length < 8} />
    </ScrollView>
  );
}
