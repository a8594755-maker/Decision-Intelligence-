<template>
  <div class="artifact-viewer">
    <div class="section-header">
      <h3>DI Artifacts</h3>
      <div class="search-box">
        <input
          v-model="searchQuery"
          placeholder="Search artifacts (Tags:di_forecast)..."
          @keyup.enter="searchArtifacts"
        />
        <button @click="searchArtifacts" :disabled="searching">
          <Search class="icon" />
        </button>
      </div>
    </div>

    <!-- Tag filters -->
    <div class="tag-filters">
      <button
        v-for="tag in quickTags"
        :key="tag.value"
        :class="['tag-chip', { active: activeTag === tag.value }]"
        @click="filterByTag(tag.value)"
      >
        {{ tag.label }}
      </button>
    </div>

    <div v-if="searching" class="loading">Searching...</div>

    <div v-for="item in artifacts" :key="item.id" class="artifact-card">
      <div class="artifact-icon">
        <component :is="getIcon(item)" class="icon" />
      </div>
      <div class="artifact-info">
        <div class="artifact-name">{{ item.name }}</div>
        <div class="artifact-meta">
          <span v-for="tag in (item.tags || [])" :key="tag" class="artifact-tag">{{ tag }}</span>
        </div>
        <div class="artifact-date">{{ formatDate(item.lastModifiedDateTime) }}</div>
      </div>
      <div class="artifact-actions">
        <button class="btn-icon" title="Open" @click="openItem(item)">
          <ExternalLink class="icon-sm" />
        </button>
        <button class="btn-icon" title="Download" @click="downloadItem(item)">
          <Download class="icon-sm" />
        </button>
      </div>
    </div>

    <div v-if="!searching && !artifacts.length" class="empty">
      No artifacts found. Try searching with DI tags like "Tags:di_forecast".
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import {
  Search, ExternalLink, Download,
  FileText, FileSpreadsheet, BarChart2, Shield,
} from 'lucide-vue-next';

const props = defineProps({
  config: { type: Object, default: () => ({}) },
});

const searchQuery = ref('');
const activeTag = ref(null);
const searching = ref(false);
const artifacts = ref([]);

const quickTags = [
  { label: 'Forecasts', value: 'di:forecast' },
  { label: 'Plans', value: 'di:plan' },
  { label: 'Reports', value: 'di:report' },
  { label: 'Risk', value: 'di:risk' },
  { label: 'All DI', value: 'di:artifact' },
];

const iconMap = {
  forecast: BarChart2,
  plan: FileSpreadsheet,
  risk: Shield,
  report: FileText,
};

function getIcon(item) {
  const tags = item.tags || [];
  for (const [key, icon] of Object.entries(iconMap)) {
    if (tags.some(t => t.includes(key))) return icon;
  }
  return FileText;
}

async function searchArtifacts() {
  if (!searchQuery.value && !activeTag.value) return;
  searching.value = true;
  try {
    const url = props.config.di_api_url || 'http://localhost:8000';
    const query = searchQuery.value || `Tags:${activeTag.value}`;
    const res = await fetch(`${url}/api/opencloud/search?q=${encodeURIComponent(query)}`);
    if (res.ok) {
      const data = await res.json();
      artifacts.value = data.items || data || [];
    }
  } catch (err) {
    console.warn('[DI Extension] Search failed:', err);
  } finally {
    searching.value = false;
  }
}

function filterByTag(tag) {
  activeTag.value = activeTag.value === tag ? null : tag;
  searchQuery.value = `Tags:${tag}`;
  searchArtifacts();
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function openItem(item) {
  if (item.webUrl) window.open(item.webUrl, '_blank');
}

function downloadItem(item) {
  if (item.webUrl) {
    const a = document.createElement('a');
    a.href = item['@microsoft.graph.downloadUrl'] || item.webUrl;
    a.download = item.name;
    a.click();
  }
}
</script>

<style scoped>
.artifact-viewer { display: flex; flex-direction: column; gap: 8px; }
.section-header h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
.search-box { display: flex; gap: 4px; }
.search-box input {
  flex: 1; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px;
  font-size: 12px; outline: none;
}
.search-box input:focus { border-color: #93c5fd; }
.search-box button {
  border: 1px solid #d1d5db; background: white; border-radius: 6px;
  padding: 4px 8px; cursor: pointer;
}
.tag-filters { display: flex; gap: 4px; flex-wrap: wrap; }
.tag-chip {
  font-size: 11px; padding: 2px 8px; border: 1px solid #e5e7eb;
  border-radius: 12px; background: white; cursor: pointer;
}
.tag-chip:hover { background: #f9fafb; }
.tag-chip.active { background: #eff6ff; border-color: #93c5fd; color: #2563eb; }
.artifact-card {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border: 1px solid #e5e7eb; border-radius: 8px;
}
.artifact-card:hover { background: #f9fafb; }
.artifact-icon { color: #3b82f6; }
.icon { width: 16px; height: 16px; }
.icon-sm { width: 14px; height: 14px; color: #6b7280; }
.artifact-info { flex: 1; min-width: 0; }
.artifact-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.artifact-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
.artifact-tag {
  font-size: 10px; padding: 0 4px; background: #f3f4f6; border-radius: 3px; color: #6b7280;
}
.artifact-date { font-size: 11px; color: #9ca3af; margin-top: 1px; }
.artifact-actions { display: flex; gap: 2px; }
.btn-icon {
  border: none; background: transparent; cursor: pointer; padding: 4px;
  border-radius: 4px; display: flex;
}
.btn-icon:hover { background: #f3f4f6; }
.loading { font-size: 12px; color: #6b7280; text-align: center; padding: 16px; }
.empty { font-size: 12px; color: #9ca3af; text-align: center; padding: 20px; }
</style>
