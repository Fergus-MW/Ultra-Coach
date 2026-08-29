import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { fetchProducts, type Product } from '../../src/coach/api';
import { useCoach } from '../../src/store/coach';
import { colors, radius, spacing } from '../../src/theme';
import { Muted, Screen } from '../../src/ui/components';

/** Healf's range, and whatever the coach put in front of the runner mid-call. */
export default function KitTab() {
  const who = useCoach((state) => state.who);
  const pushed = useCoach((state) => state.pushed);
  const seenProducts = useCoach((state) => state.seenProducts);
  const [range, setRange] = useState<Product[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!who) return;
    fetchProducts(who).then(setRange, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [who]);

  useFocusEffect(useCallback(() => seenProducts(), [seenProducts]));

  const products = pushed?.products.length ? pushed.products : range;

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.body}
        data={products}
        keyExtractor={(product) => product.handle}
        ListHeaderComponent={
          <View style={styles.head}>
            <Muted>
              {pushed?.need
                ? `Picked for ${pushed.need}`
                : 'What the coach reaches for. It puts its picks here when it calls.'}
            </Muted>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={error ? null : <Muted>Loading the range…</Muted>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={item.title}
            onPress={() => void Linking.openURL(item.url)}
            style={({ pressed }) => [styles.card, { opacity: pressed ? 0.8 : 1 }]}
          >
            {item.image ? <Image source={{ uri: item.image }} style={styles.shot} /> : null}
            <View style={styles.details}>
              <Text style={styles.brand}>{item.brand}</Text>
              <Text style={styles.name}>{item.title}</Text>
              {item.price ? (
                <Text style={styles.price}>
                  {item.currency === 'GBP' ? '£' : ''}
                  {item.price}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  head: {
    marginBottom: spacing.sm,
  },
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  shot: {
    width: 72,
    height: 72,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  details: {
    flex: 1,
    justifyContent: 'center',
  },
  brand: {
    color: colors.textMuted,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  name: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  price: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 2,
  },
  error: {
    color: colors.bad,
    fontSize: 13,
  },
});
