import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useSession } from '../data/session';
import { normalizeServerUrl } from '../lib/api';
import { Button, colors, Field, space, styles } from './ui';

/**
 * The API's address on the home network. The API runs on the baker's computer; the phone reaches
 * it over Wi-Fi at the computer's local address, e.g. 192.168.1.20 (port 3000 is assumed).
 */
export function ServerField() {
  const { serverUrl, setServerUrl } = useSession();
  const [text, setText] = useState(serverUrl ?? '');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => setText(serverUrl ?? ''), [serverUrl]);

  async function check() {
    const url = normalizeServerUrl(text);
    if (!url) {
      setStatus({ ok: false, message: 'That does not look like an address.' });
      return;
    }
    await setServerUrl(text);
    setChecking(true);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${url.replace(/\/v1$/, '')}/health`, { signal: controller.signal });
      clearTimeout(t);
      setStatus(res.ok ? { ok: true, message: 'Connected.' } : { ok: false, message: `The server answered ${res.status}.` });
    } catch {
      setStatus({
        ok: false,
        message: "Can't reach it. Check the computer is on the same Wi-Fi and the API is running (docker compose up).",
      });
    } finally {
      setChecking(false);
    }
  }

  return (
    <View style={{ gap: space(2) }}>
      <Field
        label="Server address"
        value={text}
        onChangeText={(t) => {
          setText(t);
          setStatus(null);
        }}
        onEndEditing={() => void setServerUrl(text)}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="192.168.1.20"
        hint="Your computer's address on this Wi-Fi network, where the API runs."
      />
      <View style={styles.row}>
        <Button title="Test connection" variant="secondary" small onPress={check} loading={checking} />
        {status ? <Text style={{ flex: 1, color: status.ok ? colors.success : colors.danger, fontSize: 13 }}>{status.message}</Text> : null}
      </View>
    </View>
  );
}
