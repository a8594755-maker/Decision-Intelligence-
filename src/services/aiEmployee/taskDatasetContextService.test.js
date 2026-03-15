import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrepareChatUploadFromFile = vi.fn();
const mockCreateDatasetProfileFromSheets = vi.fn();
const mockRegisterLocalProfile = vi.fn();
const mockSaveFile = vi.fn();

vi.mock('../chatDatasetProfilingService.js', () => ({
  prepareChatUploadFromFile: (...args) => mockPrepareChatUploadFromFile(...args),
}));

vi.mock('../datasetProfilingService.js', () => ({
  createDatasetProfileFromSheets: (...args) => mockCreateDatasetProfileFromSheets(...args),
}));

vi.mock('../datasetProfilesService.js', () => ({
  registerLocalProfile: (...args) => mockRegisterLocalProfile(...args),
}));

vi.mock('../supabaseClient.js', () => ({
  userFilesService: {
    saveFile: (...args) => mockSaveFile(...args),
  },
}));

import { createTaskDatasetContextFromFile } from './taskDatasetContextService.js';

describe('taskDatasetContextService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockPrepareChatUploadFromFile.mockResolvedValue({
      sheetsRaw: [
        { sheet_name: 'Demand', rows: [{ a: 1 }, { a: 2 }] },
        { sheet_name: 'Inventory', rows: [{ b: 1 }] },
      ],
      mappingPlans: [{ sheet_name: 'Demand', upload_type: 'demand_fg', mapping: {} }],
      rawRowsForStorage: [{ __sheet_name: 'Demand', a: 1 }],
    });

    mockSaveFile.mockResolvedValue({ id: 'file-1' });
    mockCreateDatasetProfileFromSheets.mockResolvedValue({
      id: 'profile-1',
      user_file_id: 'file-1',
      profile_json: {},
      contract_json: {},
    });
  });

  it('creates a file-backed dataset context for AI Employee tasks', async () => {
    const file = { name: 'test.xlsx', size: 1234 };

    const result = await createTaskDatasetContextFromFile({
      userId: 'user-1',
      file,
    });

    expect(mockPrepareChatUploadFromFile).toHaveBeenCalledWith(file);
    expect(mockSaveFile).toHaveBeenCalledWith('user-1', 'test.xlsx', [{ __sheet_name: 'Demand', a: 1 }]);
    expect(mockCreateDatasetProfileFromSheets).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      userFileId: 'file-1',
      fileName: 'test.xlsx',
      allowLLM: false,
    }));
    expect(result).toEqual(expect.objectContaining({
      datasetProfileId: 'profile-1',
      datasetProfileRow: expect.objectContaining({ id: 'profile-1' }),
      summary: expect.objectContaining({
        fileName: 'test.xlsx',
        sheetCount: 2,
        totalRows: 3,
      }),
    }));
    expect(mockRegisterLocalProfile).not.toHaveBeenCalled();
  });

  it('falls back to inline rows when the source file cannot be persisted', async () => {
    mockSaveFile.mockRejectedValue(new Error('user_files missing'));
    mockCreateDatasetProfileFromSheets.mockResolvedValue({
      id: 'local-profile-1',
      _local: true,
      user_file_id: null,
      profile_json: {},
      contract_json: {},
    });

    const result = await createTaskDatasetContextFromFile({
      userId: 'user-1',
      file: { name: 'offline.xlsx', size: 10 },
    });

    expect(result.datasetProfileRow._inlineRawRows).toEqual([{ __sheet_name: 'Demand', a: 1 }]);
    expect(mockRegisterLocalProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'local-profile-1' })
    );
  });
});
