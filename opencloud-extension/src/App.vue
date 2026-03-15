<template>
  <div id="di-extension" class="di-root">
    <!-- Header -->
    <header class="di-header">
      <BarChart2 class="di-icon" />
      <span class="di-title">Decision Intelligence</span>
      <span class="di-badge" :class="statusClass">{{ statusText }}</span>
    </header>

    <!-- Navigation -->
    <nav class="di-nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="['di-tab', { active: activeTab === tab.id }]"
        @click="activeTab = tab.id"
      >
        <component :is="tab.icon" class="di-tab-icon" />
        {{ tab.label }}
      </button>
    </nav>

    <!-- Content -->
    <main class="di-content">
      <TaskBoard v-if="activeTab === 'tasks'" :config="config" />
      <ArtifactViewer v-if="activeTab === 'artifacts'" :config="config" />
      <FileActions v-if="activeTab === 'actions'" :config="config" :selectedFiles="selectedFiles" />
      <Settings v-if="activeTab === 'settings'" :config="config" @update="updateConfig" />
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { BarChart2, ClipboardList, FileText, Zap, Settings as SettingsIcon } from 'lucide-vue-next';
import TaskBoard from './TaskBoard.vue';
import ArtifactViewer from './ArtifactViewer.vue';
import FileActions from './FileActions.vue';
import Settings from './Settings.vue';

// Props from OpenCloud host
const props = defineProps({
  hostApi: { type: Object, default: () => ({}) },
  config: { type: Object, default: () => ({}) },
});

const activeTab = ref('tasks');
const connected = ref(false);
const selectedFiles = ref([]);

const tabs = [
  { id: 'tasks', label: 'Tasks', icon: ClipboardList },
  { id: 'artifacts', label: 'Artifacts', icon: FileText },
  { id: 'actions', label: 'Actions', icon: Zap },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

const statusText = computed(() => connected.value ? 'Connected' : 'Disconnected');
const statusClass = computed(() => connected.value ? 'connected' : 'disconnected');

// Check DI backend connectivity
async function checkConnection() {
  try {
    const url = props.config.di_api_url || 'http://localhost:8000';
    const res = await fetch(`${url}/healthz`, { method: 'GET' });
    connected.value = res.ok;
  } catch {
    connected.value = false;
  }
}

// Listen for file selection events from OpenCloud host
function onFileSelected(files) {
  selectedFiles.value = files;
}

function updateConfig(newConfig) {
  Object.assign(props.config, newConfig);
}

let interval;
onMounted(() => {
  checkConnection();
  interval = setInterval(checkConnection, 30000);

  // Register with OpenCloud host API if available
  if (props.hostApi?.on) {
    props.hostApi.on('fileSelected', onFileSelected);
  }
});

onUnmounted(() => {
  clearInterval(interval);
  if (props.hostApi?.off) {
    props.hostApi.off('fileSelected', onFileSelected);
  }
});
</script>

<style scoped>
.di-root {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--oc-color-background-default, #fff);
  color: var(--oc-color-text-default, #1a1a2e);
}
.di-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--oc-color-border, #e5e7eb);
}
.di-icon { width: 20px; height: 20px; color: #3b82f6; }
.di-title { font-weight: 600; font-size: 14px; }
.di-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}
.di-badge.connected { background: #d1fae5; color: #065f46; }
.di-badge.disconnected { background: #fee2e2; color: #991b1b; }
.di-nav {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--oc-color-border, #e5e7eb);
}
.di-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--oc-color-text-muted, #6b7280);
}
.di-tab:hover { background: var(--oc-color-background-hover, #f3f4f6); }
.di-tab.active { background: #eff6ff; color: #2563eb; font-weight: 500; }
.di-tab-icon { width: 14px; height: 14px; }
.di-content { flex: 1; overflow-y: auto; padding: 12px 16px; }
</style>
