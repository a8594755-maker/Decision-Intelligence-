/**
 * ChartTest — Quick test page for InsightsChartCard with mock data.
 * Route: /chart-test
 */
import InsightsChartCard from '../components/insights/InsightsChartCard';

const MOCK_CARDS = [
  {
    id: 'line_revenue',
    title: 'Monthly Revenue & Orders',
    type: 'chart_line',
    analysis: 'Revenue grew 20x from Oct 2016 to May 2018, peaking at R$988K in Nov 2017. Orders follow a similar trajectory with 7.3K orders at peak.',
    chartData: {
      type: 'line',
      title: 'Monthly Revenue & Order Trends',
      labels: ['2016-10','2016-12','2017-02','2017-04','2017-06','2017-08','2017-10','2017-12','2018-02','2018-04','2018-06','2018-08'],
      values: [40145, 131232, 186031, 401936, 481421, 641872, 648248, 726033, 821429, 973534, 905507, 838557],
      series2Values: [328, 798, 1395, 2050, 3138, 4599, 4478, 5513, 6354, 6798, 6376, 6336],
      series1Name: 'Revenue (R$)',
      series2Name: 'Orders',
    },
  },
  {
    id: 'bar_category',
    title: 'Top 10 Product Categories',
    type: 'chart_bar',
    analysis: 'Health & Beauty leads at R$1.26M (9.3%), followed by Watches & Gifts at R$1.21M. Top 10 categories account for 62% of total revenue.',
    chartData: {
      type: 'bar',
      title: 'Top 10 Product Categories by Revenue',
      labels: ['Health & Beauty','Watches & Gifts','Bed & Bath','Sports & Leisure','Computers','Furniture','Cool Stuff','Housewares','Auto','Garden Tools'],
      values: [1258681, 1205006, 1036989, 988049, 911954, 730213, 635489, 632400, 593320, 485329],
    },
  },
  {
    id: 'donut_payment',
    title: 'Payment Method Distribution',
    type: 'mixed',
    analysis: 'Credit cards dominate at 78.3% of payment value, followed by Boleto at 17.9%. This reflects typical Brazilian e-commerce payment patterns.',
    chartData: {
      type: 'donut',
      title: 'Payment Methods by Value',
      labels: ['Credit Card', 'Boleto', 'Voucher', 'Debit Card'],
      values: [12542084, 2869361, 379437, 217990],
    },
  },
  {
    id: 'bar_states',
    title: 'Revenue by State',
    type: 'chart_bar',
    analysis: 'São Paulo dominates with 38% of revenue (R$5.2M). The top 3 states (SP, RJ, MG) account for 63% of total revenue.',
    chartData: {
      type: 'bar',
      title: 'Top 5 States by Revenue',
      labels: ['SP', 'RJ', 'MG', 'RS', 'PR'],
      values: [5202955, 1824093, 1585308, 750304, 683084],
    },
  },
];

export default function ChartTest() {
  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 24, background: '#f8fafc', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Recharts Test — InsightsChartCard</h1>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>Mock data, no LLM calls. Testing chart rendering quality.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        {MOCK_CARDS.map(card => (
          <InsightsChartCard key={card.id} card={card} />
        ))}
      </div>
    </div>
  );
}
