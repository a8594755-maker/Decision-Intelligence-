// Block Component Registry
// Maps block type strings to React components for the Canvas Renderer.

import MetricBlock from './MetricBlock';
import ChartBlock from './ChartBlock';
import TableBlock from './TableBlock';
import NarrativeBlock from './NarrativeBlock';
import FindingsBlock from './FindingsBlock';
import AlertBlock from './AlertBlock';
import DonutGroupBlock from './DonutGroupBlock';
import HorizontalBarBlock from './HorizontalBarBlock';
import KpiRowBlock from './KpiRowBlock';
import ProgressBlock from './ProgressBlock';
import SuggestionBlock from './SuggestionBlock';

const BLOCK_REGISTRY = {
  metric: MetricBlock,
  chart: ChartBlock,
  table: TableBlock,
  narrative: NarrativeBlock,
  findings: FindingsBlock,
  alert: AlertBlock,
  donut_group: DonutGroupBlock,
  horizontal_bar: HorizontalBarBlock,
  kpi_row: KpiRowBlock,
  progress: ProgressBlock,
  suggestion: SuggestionBlock,
};

export default BLOCK_REGISTRY;
