import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useMediaUri } from '../data/mediaUrls';
import { colors } from './ui';

export interface ThumbItem {
  id: string;
  kind: 'photo' | 'video';
  local_uri?: string | null;
  pending?: boolean;
}

/** A square photo or video thumbnail; tapping opens the full-screen viewer. */
export function MediaThumb({ item, size = 96 }: { item: ThumbItem; size?: number }) {
  const uri = useMediaUri(item.id, item.local_uri);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={item.kind === 'video' ? 'Video' : 'Photo'}
      onPress={() => router.push({ pathname: '/bake/media', params: { id: item.id, kind: item.kind, uri: item.local_uri ?? '' } })}
      style={{ width: size, height: size, borderRadius: 10, overflow: 'hidden', backgroundColor: '#EFE8DF' }}
    >
      {uri && item.kind === 'photo' ? <Image source={{ uri }} style={{ flex: 1 }} contentFit="cover" transition={150} /> : null}
      {item.kind === 'video' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#3A2E24' }}>
          <Ionicons name="play-circle" size={36} color="#fff" />
        </View>
      ) : null}
      {!uri && item.kind === 'photo' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="image-outline" size={28} color={colors.muted} />
        </View>
      ) : null}
      {item.pending ? (
        <View style={{ position: 'absolute', right: 4, bottom: 4, backgroundColor: '#0008', borderRadius: 10, padding: 3 }}>
          <Ionicons name="cloud-upload-outline" size={14} color="#fff" />
        </View>
      ) : null}
    </Pressable>
  );
}
