<template>
  <div class="task-board">
    <div class="section-header">
      <h3>AI Employee Tasks</h3>
      <button class="btn-refresh" @click="loadTasks" :disabled="loading">
        <RefreshCw class="icon" :class="{ spinning: loading }" />
      </button>
    </div>

    <div v-if="error" class="error-msg">{{ error }}</div>

    <div v-if="loading && !tasks.length" class="loading">Loading tasks...</div>

    <div v-for="task in tasks" :key="task.id" class="task-card" :class="task.status">
      <div class="task-header">
        <span class="task-status" :class="task.status">{{ task.status }}</span>
        <span class="task-date">{{ formatDate(task.created_at) }}</span>
      </div>
      <div class="task-title">{{ task.title }}</div>
      <div v-if="task.loop_state?.current_step" class="task-step">
        Step {{ task.loop_state.current_step }} of {{ task.loop_state.total_steps || '?' }}
      </div>
      <div class="task-actions">
        <button v-if="task.status === 'completed'" class="btn-sm" @click="viewArtifacts(task)">
          View Artifacts
        </button>
        <button v-if="task.status === 'pending_review'" class="btn-sm btn-primary" @click="openReview(task)">
          Review
        </button>
      </div>
    </div>

    <div v-if="!loading && !tasks.length" class="empty">
      No tasks found. Create tasks from Decision Intelligence.
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { RefreshCw } from 'lucide-vue-next';

const props = defineProps({
  config: { type: Object, default: () => ({}) },
});

const tasks = ref([]);
const loading = ref(false);
const error = ref(null);

async function loadTasks() {
  loading.value = true;
  error.value = null;
  try {
    const url = props.config.di_api_url || 'http://localhost:8000';
    const res = await fetch(`${url}/api/tasks?limit=20`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    tasks.value = data.tasks || data || [];
  } catch (err) {
    error.value = `Failed to load tasks: ${err.message}`;
  } finally {
    loading.value = false;
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function viewArtifacts(task) {
  // Emit to parent or navigate within extension
  console.log('[DI Extension] View artifacts for task:', task.id);
}

function openReview(task) {
  const url = props.config.di_api_url || 'http://localhost:8000';
  window.open(`${url}/employees/review?taskId=${task.id}`, '_blank');
}

onMounted(loadTasks);
</script>

<style scoped>
.task-board { display: flex; flex-direction: column; gap: 8px; }
.section-header { display: flex; align-items: center; justify-content: space-between; }
.section-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
.btn-refresh {
  border: none; background: transparent; cursor: pointer; padding: 4px;
  border-radius: 4px; display: flex;
}
.btn-refresh:hover { background: #f3f4f6; }
.icon { width: 16px; height: 16px; color: #6b7280; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.task-card {
  border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px;
  transition: border-color 0.2s;
}
.task-card:hover { border-color: #93c5fd; }
.task-card.completed { border-left: 3px solid #10b981; }
.task-card.running { border-left: 3px solid #3b82f6; }
.task-card.pending_review { border-left: 3px solid #f59e0b; }
.task-card.failed { border-left: 3px solid #ef4444; }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.task-status {
  font-size: 11px; padding: 1px 6px; border-radius: 4px; font-weight: 500;
}
.task-status.completed { background: #d1fae5; color: #065f46; }
.task-status.running { background: #dbeafe; color: #1e40af; }
.task-status.pending_review { background: #fef3c7; color: #92400e; }
.task-status.failed { background: #fee2e2; color: #991b1b; }
.task-date { font-size: 11px; color: #9ca3af; }
.task-title { font-size: 13px; font-weight: 500; }
.task-step { font-size: 11px; color: #6b7280; margin-top: 2px; }
.task-actions { display: flex; gap: 4px; margin-top: 6px; }
.btn-sm {
  font-size: 11px; padding: 3px 8px; border: 1px solid #d1d5db;
  border-radius: 4px; background: white; cursor: pointer;
}
.btn-sm:hover { background: #f9fafb; }
.btn-primary { background: #3b82f6; color: white; border-color: #3b82f6; }
.btn-primary:hover { background: #2563eb; }
.error-msg { font-size: 12px; color: #ef4444; padding: 8px; background: #fef2f2; border-radius: 6px; }
.loading { font-size: 12px; color: #6b7280; text-align: center; padding: 20px; }
.empty { font-size: 12px; color: #9ca3af; text-align: center; padding: 20px; }
</style>
