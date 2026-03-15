<template>
  <div class="file-actions">
    <h3>Quick Actions</h3>

    <!-- Selected files -->
    <div v-if="selectedFiles.length" class="selected-files">
      <p class="label">Selected files ({{ selectedFiles.length }})</p>
      <div v-for="file in selectedFiles" :key="file.id" class="file-chip">
        <FileText class="icon-sm" />
        <span>{{ file.name }}</span>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="action-grid">
      <button class="action-btn" @click="importToDI" :disabled="!selectedFiles.length">
        <Download class="action-icon" />
        <span>Import to DI</span>
        <span class="action-desc">Create dataset profile from selected files</span>
      </button>

      <button class="action-btn" @click="runForecast" :disabled="!selectedFiles.length">
        <TrendingUp class="action-icon forecast" />
        <span>Run Forecast</span>
        <span class="action-desc">Auto-detect time series and generate forecast</span>
      </button>

      <button class="action-btn" @click="runFullAnalysis" :disabled="!selectedFiles.length">
        <Layers class="action-icon analysis" />
        <span>Full Analysis</span>
        <span class="action-desc">Forecast + Plan + Risk assessment pipeline</span>
      </button>

      <button class="action-btn" @click="setupWatcher">
        <Eye class="action-icon watcher" />
        <span>Watch Folder</span>
        <span class="action-desc">Auto-trigger analysis when new files appear</span>
      </button>
    </div>

    <!-- Status -->
    <div v-if="status" class="status-msg" :class="statusType">{{ status }}</div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { FileText, Download, TrendingUp, Layers, Eye } from 'lucide-vue-next';

const props = defineProps({
  config: { type: Object, default: () => ({}) },
  selectedFiles: { type: Array, default: () => [] },
});

const status = ref('');
const statusType = ref('info');

function apiUrl() {
  return props.config.di_api_url || 'http://localhost:8000';
}

async function importToDI() {
  status.value = 'Importing files...';
  statusType.value = 'info';
  try {
    for (const file of props.selectedFiles) {
      await fetch(`${apiUrl()}/api/opencloud/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driveId: file.driveId, itemId: file.id, name: file.name }),
      });
    }
    status.value = `Imported ${props.selectedFiles.length} file(s) successfully`;
    statusType.value = 'success';
  } catch (err) {
    status.value = `Import failed: ${err.message}`;
    statusType.value = 'error';
  }
}

async function runForecast() {
  status.value = 'Starting forecast task...';
  statusType.value = 'info';
  try {
    const res = await fetch(`${apiUrl()}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Forecast: ${props.selectedFiles.map(f => f.name).join(', ')}`,
        template_id: 'forecast_then_plan',
        input_context: {
          opencloud_files: props.selectedFiles.map(f => ({ driveId: f.driveId, itemId: f.id, name: f.name })),
        },
      }),
    });
    if (res.ok) {
      status.value = 'Forecast task created! Check Tasks tab for progress.';
      statusType.value = 'success';
    }
  } catch (err) {
    status.value = `Failed: ${err.message}`;
    statusType.value = 'error';
  }
}

async function runFullAnalysis() {
  status.value = 'Starting full analysis pipeline...';
  statusType.value = 'info';
  try {
    const res = await fetch(`${apiUrl()}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Full Analysis: ${props.selectedFiles.map(f => f.name).join(', ')}`,
        template_id: 'full_report_with_publish',
        input_context: {
          opencloud_files: props.selectedFiles.map(f => ({ driveId: f.driveId, itemId: f.id, name: f.name })),
        },
      }),
    });
    if (res.ok) {
      status.value = 'Full analysis started! Results will be published back to OpenCloud.';
      statusType.value = 'success';
    }
  } catch (err) {
    status.value = `Failed: ${err.message}`;
    statusType.value = 'error';
  }
}

async function setupWatcher() {
  status.value = 'Setting up folder watcher...';
  statusType.value = 'info';
  try {
    const res = await fetch(`${apiUrl()}/api/opencloud/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: ['.xlsx', '.csv', '.json'],
        preferSSE: true,
      }),
    });
    if (res.ok) {
      status.value = 'Folder watcher active! New files will trigger auto-analysis.';
      statusType.value = 'success';
    }
  } catch (err) {
    status.value = `Failed: ${err.message}`;
    statusType.value = 'error';
  }
}
</script>

<style scoped>
.file-actions { display: flex; flex-direction: column; gap: 12px; }
.file-actions h3 { margin: 0; font-size: 14px; font-weight: 600; }
.label { font-size: 11px; color: #6b7280; margin: 0 0 4px; }
.selected-files { display: flex; flex-direction: column; gap: 4px; }
.file-chip {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; padding: 4px 8px;
  background: #f3f4f6; border-radius: 6px;
}
.icon-sm { width: 14px; height: 14px; color: #6b7280; }
.action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.action-btn {
  display: flex; flex-direction: column; align-items: center;
  gap: 4px; padding: 12px 8px; border: 1px solid #e5e7eb;
  border-radius: 8px; background: white; cursor: pointer;
  text-align: center; transition: all 0.2s;
}
.action-btn:hover:not(:disabled) { border-color: #93c5fd; background: #f0f7ff; }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.action-icon { width: 24px; height: 24px; color: #3b82f6; }
.action-icon.forecast { color: #10b981; }
.action-icon.analysis { color: #8b5cf6; }
.action-icon.watcher { color: #f59e0b; }
.action-btn span:nth-child(2) { font-size: 12px; font-weight: 500; }
.action-desc { font-size: 10px; color: #9ca3af; }
.status-msg { font-size: 12px; padding: 8px 12px; border-radius: 6px; }
.status-msg.info { background: #eff6ff; color: #1e40af; }
.status-msg.success { background: #f0fdf4; color: #166534; }
.status-msg.error { background: #fef2f2; color: #991b1b; }
</style>
