import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaView, View, Text, FlatList, StyleSheet, ActivityIndicator, Dimensions, ScrollView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { PieChart, LineChart } from 'react-native-chart-kit';
import Slider from '@react-native-community/slider';

const API = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';
const screenWidth = Dimensions.get('window').width;

// Category Totals Screen with Pie Chart
function CategoryTotalsScreen() {
  const [data, setData] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API}/totals`)
      .then((r) => r.json())
      .then((json) => {
        const totals = json.totals || [];
        // Transform data for pie chart
        const chartData = totals.map((item, index) => ({
          name: item.category,
          amount: Math.abs(item.total),
          color: getColor(index),
          legendFontColor: '#7F7F7F',
          legendFontSize: 12
        }));
        setData(chartData);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.pageContent}>
        <Text style={styles.h1}>Category Totals</Text>
        {loading ? <ActivityIndicator /> : error ? <Text>{error}</Text> : (
          <>
            <PieChart
              data={data}
              width={screenWidth - 32}
              height={220}
              chartConfig={{
                backgroundColor: '#ffffff',
                backgroundGradientFrom: '#ffffff',
                backgroundGradientTo: '#ffffff',
                color: (opacity = 1) => `rgba(0, 0, 0, ${opacity})`,
              }}
              accessor="amount"
              backgroundColor="transparent"
              paddingLeft="15"
            />
            <FlatList
              data={data}
              keyExtractor={(item) => item.name}
              renderItem={({ item }) => (
                <View style={styles.row}>
                  <Text style={styles.cat}>{item.name}</Text>
                  <Text style={styles.val}>${item.amount.toFixed(2)}</Text>
                </View>
              )}
              scrollEnabled={false}
            />
          </>
        )}
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

// Recurring Spenders Screen
function RecurringSpendersScreen() {
  const [data, setData] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API}/recurring`)
      .then((r) => r.json())
      .then((json) => setData(json.recurring || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        contentContainerStyle={styles.pageContent}
        ListHeaderComponent={<Text style={styles.h1}>Recurring Spenders</Text>}
        data={data}
        keyExtractor={(item) => item.merchant}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.merchantInfo}>
              <Text style={styles.merchant}>{item.merchant}</Text>
              <Text style={styles.subtext}>
                {item.txn_count} transactions over {item.months_count} months
              </Text>
            </View>
            <Text style={styles.val}>${item.total_abs.toFixed(2)}</Text>
          </View>
        )}
        ListEmptyComponent={
          loading ? <ActivityIndicator /> : error ? <Text>{error}</Text> : null
        }
      />
    </SafeAreaView>
  );
}

// Forecast Screen with per-category safe budgets
function ForecastScreen() {
  const [data, setData] = React.useState({ history: [], forecast: null, safeToSpend: null });
  const [adjustments, setAdjustments] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API}/forecast`)
      .then((r) => r.json())
      .then((json) => setData(json))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const latestMonth = React.useMemo(() => {
    if (!data.history?.length) return null;
    return data.history[data.history.length - 1];
  }, [data.history]);

  const actualMap = React.useMemo(() => {
    const map = {};
    latestMonth?.perCategory?.forEach((c) => {
      map[c.category] = c.actual;
    });
    return map;
  }, [latestMonth]);

  const categories = React.useMemo(() => {
    if (!data.forecast?.perCategory) return [];
    return data.forecast.perCategory.map((p) => {
      const safe = data.safeToSpend?.perCategory?.find((s) => s.category === p.category);
      const multiplier = adjustments[p.category] ?? 1;
      const adjustedPred = p.predicted * multiplier;
      const safeBudget = safe?.safeBudget ?? null;
      const safeRatio = p.predicted !== 0 && safeBudget ? safeBudget / p.predicted : null;
      // Expand slider bounds so user can cross meaningful thresholds
      const baseMin = 0.6;
      const baseMax =
        safeRatio !== null ? Math.max(1.6, safeRatio * 1.5) : 1.6;
      const markerPercent =
        safeRatio !== null
          ? Math.min(100, Math.max(0, ((safeRatio - baseMin) / (baseMax - baseMin)) * 100))
          : null;
      return {
        category: p.category,
        predicted: p.predicted,
        adjustedPred,
        safeBudget,
        actualLastMonth: actualMap[p.category] ?? 0,
        multiplier,
        sliderMin: baseMin,
        sliderMax: baseMax,
        markerPercent,
      };
    });
  }, [data.forecast?.perCategory, data.safeToSpend?.perCategory, actualMap, adjustments]);

  const chartData = React.useMemo(() => {
    if (!data.history?.length) return null;

    const labels = [...data.history.map((h) => h.monthKey.slice(0, 7))];
    const historyValues = data.history.map((h) => Math.max(0, h.totalActual));
    if (data.forecast?.totalPredicted) {
      labels.push('Forecast');
      const adjustedTotal = categories.reduce((sum, c) => sum + Math.max(0, c.adjustedPred), 0);
      historyValues.push(Math.max(0, adjustedTotal || data.forecast.totalPredicted));
    }

    return {
      labels,
      datasets: [
        {
          data: historyValues,
          color: (opacity = 1) => `rgba(134, 65, 244, ${opacity})`,
          strokeWidth: 2,
        },
      ],
    };
  }, [data.history, data.forecast?.totalPredicted]);

  const summaryMessage = React.useMemo(() => {
    if (!data.forecast || !data.safeToSpend) return null;
    const months = data.history?.length || 0;
    const adjustedTotal = categories.reduce((sum, c) => sum + Math.max(0, c.adjustedPred), 0);
    const forecasted = Math.max(0, adjustedTotal || data.forecast.totalPredicted || 0).toFixed(0);
    const safe = data.safeToSpend.safeTotalBudget
      ? Math.max(0, data.safeToSpend.safeTotalBudget).toFixed(0)
      : null;
    const avgIncome = data.safeToSpend.avgMonthlyIncome;
    const achievedSavings =
      avgIncome && avgIncome > 0 ? Math.max(0, (avgIncome - adjustedTotal) / avgIncome) * 100 : null;
    return {
      months,
      forecasted,
      safe,
      savingsRate: data.safeToSpend.targetSavingsRate * 100,
      achievedSavings,
    };
  }, [data.forecast, data.safeToSpend, data.history?.length, categories]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.pageContent}>
        <Text style={styles.h1}>Forecast & Safe Budget</Text>
        {loading ? <ActivityIndicator /> : error ? <Text>{error}</Text> : (
          <>
            {summaryMessage && (
              <View style={styles.summaryCard}>
                <Text style={styles.summaryText}>
                  Given your past {summaryMessage.months} months, your forecasted spend is $
                  {summaryMessage.forecasted}
                  {summaryMessage.safe ? ` and your safe-to-spend (at ${summaryMessage.savingsRate}% savings) is $${summaryMessage.safe}.` : '.'}
                </Text>
                {summaryMessage.achievedSavings !== null && (
                  <Text style={[styles.summaryText, { marginTop: 6 }]}>
                    With your tweaks, projected savings rate would be {summaryMessage.achievedSavings.toFixed(1)}%.
                  </Text>
                )}
              </View>
            )}

            {chartData && (
              <LineChart
                data={chartData}
                width={screenWidth - 32}
                height={220}
                chartConfig={{
                  backgroundColor: '#ffffff',
                  backgroundGradientFrom: '#ffffff',
                  backgroundGradientTo: '#ffffff',
                  decimalPlaces: 0,
                  color: (opacity = 1) => `rgba(0, 0, 0, ${opacity})`,
                  style: {
                    borderRadius: 16
                  }
                }}
                bezier
                style={{
                  marginVertical: 8,
                  borderRadius: 16
                }}
              />
            )}

            <Text style={styles.statsHeader}>Category Breakdown</Text>
            {categories.map((item) => {
              const atRisk = item.safeBudget !== null && item.predicted > item.safeBudget;
              return (
                <View key={item.category} style={styles.itemContainer}>
                  <View style={styles.firstRow}>
                    <View style={styles.merchantInfo}>
                      <Text style={styles.merchant}>{item.category}</Text>
                      <Text style={styles.subtext}>
                        Last month: ${Math.max(0, item.actualLastMonth).toFixed(0)}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.val}>Pred ${Math.max(0, item.adjustedPred).toFixed(0)}</Text>
                      <Text style={[styles.subtext, atRisk && styles.atRisk]}>
                        Safe {item.safeBudget !== null ? `$${Math.max(0, item.safeBudget).toFixed(0)}` : '--'}
                      </Text>
                    </View>
                  </View>
                  {item.markerPercent !== null && (
                    <View style={styles.sliderWrapper}>
                      <View style={styles.thresholdTrack} />
                      <View
                        style={[
                          styles.thresholdMarker,
                          { left: `${item.markerPercent}%` },
                        ]}
                      />
                    </View>
                  )}
                  <View style={styles.sliderRow}>
                    <Text style={styles.subtext}>{Math.round(item.multiplier * 100)}%</Text>
                    <Slider
                      style={{ flex: 1, marginHorizontal: 8 }}
                      thumbTintColor="#4B0082"
                      minimumTrackTintColor="#6A5ACD"
                      maximumTrackTintColor="#ddd"
                      value={item.multiplier}
                      minimumValue={item.sliderMin}
                      maximumValue={item.sliderMax}
                      step={0.05}
                      onValueChange={(v) =>
                        setAdjustments((prev) => ({ ...prev, [item.category]: v }))
                      }
                    />
                  </View>
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// Import History Screen
function ImportHistoryScreen() {
  const [data, setData] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    fetch(`${API}/imports`)
      .then((r) => r.json())
      .then((json) => setData(json.batches || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        contentContainerStyle={styles.pageContent}
        ListHeaderComponent={<Text style={styles.h1}>Import History</Text>}
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.importInfo}>
              <Text style={styles.filename}>{item.filename || 'Unnamed Import'}</Text>
              <Text style={styles.subtext}>
                {new Date(item.createdAt).toLocaleDateString()} - {item.recordCount} records
              </Text>
            </View>
            <Text style={styles.account}>{item.account?.name || 'No Account'}</Text>
          </View>
        )}
        ListEmptyComponent={
          loading ? <ActivityIndicator /> : error ? <Text>{error}</Text> : null
        }
      />
    </SafeAreaView>
  );
}

// Color generator for pie chart
function getColor(index) {
  const colors = [
    '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF',
    '#FF9F40', '#FF6384', '#C9CBCF', '#4BC0C0', '#FF9F40'
  ];
  return colors[index % colors.length];
}

// Main App Component with Navigation
export default function App() {
  const Tab = createBottomTabNavigator();
  
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          tabBarStyle: { paddingBottom: 5 },
          tabBarLabelStyle: { fontSize: 12 }
        }}
      >
        <Tab.Screen 
          name="Categories" 
          component={CategoryTotalsScreen}
          options={{ 
            title: 'Categories',
            tabBarLabel: 'Categories'
          }}
        />
        <Tab.Screen 
          name="Recurring" 
          component={RecurringSpendersScreen}
          options={{ 
            title: 'Recurring',
            tabBarLabel: 'Recurring'
          }}
        />
        <Tab.Screen 
          name="Forecast" 
          component={ForecastScreen}
          options={{ 
            title: 'Forecast',
            tabBarLabel: 'Forecast'
          }}
        />
        <Tab.Screen 
          name="Imports" 
          component={ImportHistoryScreen}
          options={{ 
            title: 'Imports',
            tabBarLabel: 'Imports'
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 16,
    paddingBottom: 16,
    backgroundColor: '#fff'
  },
  pageContent: {
    paddingHorizontal: 24
  },
  h1: { 
    fontSize: 24, 
    fontWeight: '700', 
    marginBottom: 16 
  },
  row: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center',
    paddingVertical: 12, 
    borderBottomWidth: 1, 
    borderColor: '#eee' 
  },
  merchantInfo: {
    flex: 1,
    marginRight: 16
  },
  merchant: {
    fontSize: 16,
    fontWeight: '600'
  },
  subtext: {
    fontSize: 12,
    color: '#666'
  },
  val: { 
    fontSize: 16, 
    fontWeight: '600' 
  },
  importInfo: {
    flex: 1
  },
  filename: {
    fontSize: 16,
    fontWeight: '500'
  },
  account: {
    fontSize: 14,
    color: '#666'
  },
  forecastStats: {
    padding: 16,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    marginTop: 16
  },
  statsHeader: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8
  },
  statsText: {
    fontSize: 14,
    color: '#666'
  },
  summaryCard: {
    padding: 16,
    backgroundColor: '#eef6ff',
    borderRadius: 8,
    marginBottom: 12
  },
  summaryText: {
    fontSize: 14,
    color: '#1e3a8a'
  },
  atRisk: {
    color: '#c0392b',
    fontWeight: '700'
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    width: '100%'
  },
  itemContainer: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: '#eee',
    width: '100%'
  },
  firstRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%'
  },
  sliderWrapper: {
    width: '100%',
    marginTop: 8,
    marginBottom: 4,
    position: 'relative',
    height: 10,
    justifyContent: 'center'
  },
  thresholdTrack: {
    height: 2,
    width: '100%',
    backgroundColor: '#e0e0e0',
    borderRadius: 2
  },
  thresholdMarker: {
    position: 'absolute',
    width: 2,
    height: 12,
    backgroundColor: '#4b5563',
    top: -1
  }
});
