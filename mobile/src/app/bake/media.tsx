import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ActivityIndicator, Text, View } from 'react-native';
import { useMediaUri } from '../../data/mediaUrls';

/** Full-screen photo or video. Local files play offline; server copies need a connection. */
export default function MediaViewer() {
  const { id, kind, uri: localUri } = useLocalSearchParams<{ id: string; kind: 'photo' | 'video'; uri?: string }>();
  const uri = useMediaUri(id, localUri || null);
  return (
    <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center' }}>
      {!uri ? (
        <View style={{ alignItems: 'center', gap: 12 }}>
          <ActivityIndicator color="#fff" />
          <Text style={{ color: '#aaa' }}>Loading. Photos and videos from the server need a connection.</Text>
        </View>
      ) : kind === 'video' ? (
        <Video uri={uri} />
      ) : (
        <Image source={{ uri }} style={{ flex: 1 }} contentFit="contain" />
      )}
    </View>
  );
}

function Video({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.play();
  });
  return <VideoView player={player} style={{ flex: 1 }} nativeControls contentFit="contain" />;
}
