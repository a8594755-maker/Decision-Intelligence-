import { prepareChatUploadFromFile } from '../chatDatasetProfilingService.js';
import { createDatasetProfileFromSheets } from '../datasetProfilingService.js';
import { registerLocalProfile } from '../datasetProfilesService.js';
import { userFilesService } from '../supabaseClient.js';

export async function createTaskDatasetContextFromFile({ userId, file }) {
  if (!userId) {
    throw new Error('userId is required.');
  }
  if (!file) {
    throw new Error('A source file is required.');
  }

  const uploadPreparation = await prepareChatUploadFromFile(file);
  const totalRows = (uploadPreparation.sheetsRaw || []).reduce(
    (sum, sheet) => sum + (Array.isArray(sheet.rows) ? sheet.rows.length : 0),
    0
  );

  let fileRecord = null;
  try {
    fileRecord = await userFilesService.saveFile(userId, file.name, uploadPreparation.rawRowsForStorage || []);
  } catch (error) {
    console.warn('[taskDatasetContextService] File persistence skipped:', error?.message);
  }

  let datasetProfileRow = await createDatasetProfileFromSheets({
    userId,
    userFileId: fileRecord?.id || null,
    fileName: file.name,
    sheetsRaw: uploadPreparation.sheetsRaw || [],
    mappingPlans: uploadPreparation.mappingPlans || [],
    allowLLM: false,
  });

  const hasInlineRows = Array.isArray(uploadPreparation.rawRowsForStorage)
    && uploadPreparation.rawRowsForStorage.length > 0;

  if (!datasetProfileRow?.user_file_id && hasInlineRows) {
    datasetProfileRow = {
      ...datasetProfileRow,
      _inlineRawRows: uploadPreparation.rawRowsForStorage,
    };
  }

  if (datasetProfileRow?._local) {
    registerLocalProfile(datasetProfileRow);
  }

  return {
    datasetProfileId: datasetProfileRow?.id || null,
    datasetProfileRow,
    fileRecord,
    summary: {
      fileName: file.name,
      fileSize: Number(file.size || 0),
      sheetCount: Array.isArray(uploadPreparation.sheetsRaw) ? uploadPreparation.sheetsRaw.length : 0,
      totalRows,
    },
  };
}

export default {
  createTaskDatasetContextFromFile,
};
