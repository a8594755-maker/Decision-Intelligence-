import { supabase, userFilesService } from '../services/supabaseClient';
import { diRunsService } from '../services/diRunsService';

const DEFAULT_SIZE_THRESHOLD = 200 * 1024;

const encodeSize = (text) => {
  const value = String(text || '');
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
};

const normalizeFileName = (value, fallback = 'artifact.json') => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
};

const resolveRunIdType = (runId) => {
  const num = Number(runId);
  return Number.isFinite(num) ? num : runId;
};

const inferUserIdFromRun = async (runId) => {
  const row = await diRunsService.getRun(resolveRunIdType(runId));
  if (!row?.user_id) {
    throw new Error(`Cannot resolve user_id for run ${runId}`);
  }
  return row.user_id;
};

const persistLargeArtifactFile = async ({ run_id, user_id, fileName, contentType, payload }) => {
  let fileRow = null;

  try {
    fileRow = await userFilesService.saveFile(user_id, fileName, {
      artifact_type: 'run_artifact_file',
      run_id,
      content_type: contentType,
      payload
    });
  } catch {
    const { data, error } = await supabase
      .from('user_files')
      .insert([{
        user_id,
        filename: fileName,
        data: {
          artifact_type: 'run_artifact_file',
          run_id,
          content_type: contentType,
          payload,
          version: `artifact-${run_id}-${Date.now()}`
        }
      }])
      .select('*')
      .single();

    if (error) throw error;
    fileRow = data;
  }

  return fileRow;
};

export async function saveJsonArtifact(run_id, type, payload, size_threshold = DEFAULT_SIZE_THRESHOLD, options = {}) {
  if (!run_id) throw new Error('run_id is required');
  if (!type) throw new Error('type is required');

  const serialized = JSON.stringify(payload ?? {});
  const sizeBytes = encodeSize(serialized);
  const threshold = Number.isFinite(Number(size_threshold)) ? Number(size_threshold) : DEFAULT_SIZE_THRESHOLD;
  const artifactType = String(type);

  if (sizeBytes <= threshold) {
    const artifact = await diRunsService.saveArtifact({
      run_id,
      artifact_type: artifactType,
      artifact_json: payload ?? {}
    });

    return {
      artifact,
      ref: {
        storage: 'inline',
        artifact_id: artifact.id,
        run_id,
        artifact_type: artifactType,
        size_bytes: sizeBytes,
        content_type: 'application/json'
      }
    };
  }

  const userId = options.user_id || await inferUserIdFromRun(run_id);
  const fileName = normalizeFileName(options.filename || `${artifactType}_run_${run_id}.json`);
  const fileRow = await persistLargeArtifactFile({
    run_id,
    user_id: userId,
    fileName,
    contentType: 'application/json',
    payload: payload ?? {}
  });

  const artifact = await diRunsService.saveArtifact({
    run_id,
    artifact_type: artifactType,
    artifact_json: {
      storage: 'user_files',
      file_id: fileRow?.id || null,
      file_name: fileName,
      size_bytes: sizeBytes,
      content_type: 'application/json'
    }
  });

  return {
    artifact,
    ref: {
      storage: 'user_files',
      artifact_id: artifact.id,
      file_id: fileRow?.id || null,
      file_name: fileName,
      run_id,
      artifact_type: artifactType,
      size_bytes: sizeBytes,
      content_type: 'application/json'
    }
  };
}

const rowsToCsv = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return '';

  const headers = Object.keys(rows[0]);
  const escapeCell = (value) => {
    const raw = String(value ?? '');
    if (/[",\n]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };

  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(','))
  ].join('\n');
};

export async function saveCsvArtifact(run_id, type, rows, filename, size_threshold = DEFAULT_SIZE_THRESHOLD, options = {}) {
  if (!run_id) throw new Error('run_id is required');
  if (!type) throw new Error('type is required');

  const csv = typeof rows === 'string' ? rows : rowsToCsv(rows);
  const sizeBytes = encodeSize(csv);
  const threshold = Number.isFinite(Number(size_threshold)) ? Number(size_threshold) : DEFAULT_SIZE_THRESHOLD;
  const artifactType = String(type);

  if (sizeBytes <= threshold) {
    const artifact = await diRunsService.saveArtifact({
      run_id,
      artifact_type: artifactType,
      artifact_json: {
        filename: normalizeFileName(filename || `${artifactType}_run_${run_id}.csv`),
        content: csv,
        content_type: 'text/csv;charset=utf-8',
        size_bytes: sizeBytes
      }
    });

    return {
      artifact,
      ref: {
        storage: 'inline',
        artifact_id: artifact.id,
        run_id,
        artifact_type: artifactType,
        size_bytes: sizeBytes,
        content_type: 'text/csv;charset=utf-8'
      }
    };
  }

  const userId = options.user_id || await inferUserIdFromRun(run_id);
  const fileName = normalizeFileName(filename || `${artifactType}_run_${run_id}.csv`);
  const fileRow = await persistLargeArtifactFile({
    run_id,
    user_id: userId,
    fileName,
    contentType: 'text/csv;charset=utf-8',
    payload: csv
  });

  const artifact = await diRunsService.saveArtifact({
    run_id,
    artifact_type: artifactType,
    artifact_json: {
      storage: 'user_files',
      file_id: fileRow?.id || null,
      file_name: fileName,
      size_bytes: sizeBytes,
      content_type: 'text/csv;charset=utf-8'
    }
  });

  return {
    artifact,
    ref: {
      storage: 'user_files',
      artifact_id: artifact.id,
      file_id: fileRow?.id || null,
      file_name: fileName,
      run_id,
      artifact_type: artifactType,
      size_bytes: sizeBytes,
      content_type: 'text/csv;charset=utf-8'
    }
  };
}

export async function loadArtifact(ref) {
  if (!ref) return null;

  const artifactRef = ref.artifact_id ? ref : (ref.output_ref || ref.input_ref || ref);

  if (artifactRef.storage === 'inline' && artifactRef.artifact_id) {
    const artifact = await diRunsService.getArtifactById(artifactRef.artifact_id);
    return artifact?.artifact_json ?? null;
  }

  if (artifactRef.storage === 'user_files' && artifactRef.file_id) {
    const { data, error } = await supabase
      .from('user_files')
      .select('data')
      .eq('id', artifactRef.file_id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const fileData = data.data;
    if (fileData && typeof fileData === 'object') {
      if (Object.prototype.hasOwnProperty.call(fileData, 'rows')) {
        const rowsPayload = fileData.rows;
        if (rowsPayload && typeof rowsPayload === 'object' && Object.prototype.hasOwnProperty.call(rowsPayload, 'payload')) {
          return rowsPayload.payload;
        }
        return rowsPayload;
      }
      if (Object.prototype.hasOwnProperty.call(fileData, 'payload')) {
        return fileData.payload;
      }
    }
    return fileData;
  }

  if (artifactRef.artifact_id) {
    const artifact = await diRunsService.getArtifactById(artifactRef.artifact_id);
    return artifact?.artifact_json ?? null;
  }

  return null;
}

export default {
  saveJsonArtifact,
  saveCsvArtifact,
  loadArtifact
};
