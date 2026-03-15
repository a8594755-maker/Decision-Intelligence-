<template>
  <div class="settings">
    <h3>Extension Settings</h3>

    <div class="setting-group">
      <label>DI API URL</label>
      <input v-model="localConfig.di_api_url" placeholder="http://localhost:8000" />
    </div>

    <div class="setting-group">
      <label>Supabase URL</label>
      <input v-model="localConfig.supabase_url" placeholder="https://xxx.supabase.co" />
    </div>

    <div class="setting-group">
      <label class="checkbox-label">
        <input type="checkbox" v-model="localConfig.auto_import" />
        Auto-import files on selection
      </label>
    </div>

    <button class="btn-save" @click="save">Save Settings</button>

    <div class="info-section">
      <h4>Desktop Sync</h4>
      <p>To sync DI artifacts to your local machine, configure the OpenCloud desktop client:</p>
      <ol>
        <li>Open OpenCloud Desktop Client</li>
        <li>Add sync connection to your server</li>
        <li>Select the <code>Decision-Intelligence</code> folder</li>
        <li>Choose a local sync directory</li>
      </ol>
      <p class="hint">Set <code>VITE_OPENCLOUD_DESKTOP_SYNC_FOLDER</code> to your local sync path for DI to detect synced files.</p>
    </div>
  </div>
</template>

<script setup>
import { reactive } from 'vue';

const props = defineProps({
  config: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update']);

const localConfig = reactive({
  di_api_url: props.config.di_api_url || '',
  supabase_url: props.config.supabase_url || '',
  auto_import: props.config.auto_import || false,
});

function save() {
  emit('update', { ...localConfig });
}
</script>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 12px; }
.settings h3 { margin: 0; font-size: 14px; font-weight: 600; }
.setting-group { display: flex; flex-direction: column; gap: 4px; }
.setting-group label { font-size: 12px; font-weight: 500; color: #374151; }
.setting-group input[type="text"],
.setting-group input:not([type]) {
  padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 6px;
  font-size: 12px; outline: none;
}
.setting-group input:focus { border-color: #93c5fd; }
.checkbox-label {
  display: flex; align-items: center; gap: 6px; cursor: pointer;
}
.btn-save {
  padding: 8px 16px; background: #3b82f6; color: white; border: none;
  border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer;
  align-self: flex-start;
}
.btn-save:hover { background: #2563eb; }
.info-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb; }
.info-section h4 { margin: 0 0 8px; font-size: 13px; }
.info-section p { font-size: 12px; color: #6b7280; margin: 4px 0; }
.info-section ol { font-size: 12px; color: #374151; padding-left: 20px; }
.info-section li { margin: 4px 0; }
.info-section code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.hint { font-style: italic; color: #9ca3af !important; }
</style>
