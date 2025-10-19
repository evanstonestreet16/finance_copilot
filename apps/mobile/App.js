import React, { useEffect, useState } from 'react';
import { SafeAreaView, View, Text, FlatList, StyleSheet, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';

const API = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

export default function App() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API}/totals`)
      .then((r) => r.json())
      .then((json) => setData(json.totals || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.h1}>Finance Copilot</Text>
      <Text style={styles.h2}>Category Totals</Text>
      {loading ? <ActivityIndicator /> : error ? <Text>{error}</Text> : (
        <FlatList
          data={data}
          keyExtractor={(item, idx) => `${item.category}-${idx}`}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.cat}>{item.category}</Text>
              <Text style={styles.val}>${item.total.toFixed(2)}</Text>
            </View>
          )}
        />
      )}
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#fff' },
  h1: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  h2: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderColor: '#eee' },
  cat: { fontSize: 16 },
  val: { fontSize: 16, fontWeight: '600' }
});
