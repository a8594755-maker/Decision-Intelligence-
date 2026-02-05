/**
 * Upload Workflow State Management Hook
 * 使用 useReducer 集中管理上傳流程的核心狀態
 */

import { useReducer } from 'react';

// 初始狀態
const initialState = {
  // Workflow 核心狀態
  currentStep: 1, // 1: select type, 2: upload, 3: mapping, 4: validation, 5: save
  uploadType: '',
  
  // 檔案與資料
  file: null,
  fileName: '',
  rawRows: [],
  columns: [],
  
  // 欄位映射
  columnMapping: {},
  mappingComplete: false,
  
  // 驗證結果
  validationResult: null,
  
  // 匯入模式（Phase 3）
  strictMode: false, // false = Best-effort（預設）, true = Strict
  
  // UI 狀態
  loading: false,
  saving: false,
  error: null
};

// Action Types
const ActionTypes = {
  SET_UPLOAD_TYPE: 'SET_UPLOAD_TYPE',
  SET_FILE: 'SET_FILE',
  SET_MAPPING: 'SET_MAPPING',
  SET_MAPPING_COMPLETE: 'SET_MAPPING_COMPLETE',
  SET_VALIDATION: 'SET_VALIDATION',
  SET_STEP: 'SET_STEP',
  SET_STRICT_MODE: 'SET_STRICT_MODE',
  START_LOADING: 'START_LOADING',
  STOP_LOADING: 'STOP_LOADING',
  START_SAVING: 'START_SAVING',
  SAVE_SUCCESS: 'SAVE_SUCCESS',
  SAVE_ERROR: 'SAVE_ERROR',
  SET_ERROR: 'SET_ERROR',
  RESET: 'RESET',
  GO_BACK: 'GO_BACK'
};

// Reducer
function uploadWorkflowReducer(state, action) {
  switch (action.type) {
    case ActionTypes.SET_UPLOAD_TYPE:
      return {
        ...state,
        uploadType: action.payload,
        currentStep: 2,
        // 重置其他狀態
        file: null,
        fileName: '',
        rawRows: [],
        columns: [],
        columnMapping: {},
        mappingComplete: false,
        validationResult: null,
        error: null
      };

    case ActionTypes.SET_FILE:
      return {
        ...state,
        file: action.payload.file,
        fileName: action.payload.fileName,
        rawRows: action.payload.rawRows,
        columns: action.payload.columns,
        currentStep: 3,
        error: null
      };

    case ActionTypes.SET_MAPPING:
      return {
        ...state,
        columnMapping: action.payload
      };

    case ActionTypes.SET_MAPPING_COMPLETE:
      return {
        ...state,
        mappingComplete: action.payload
      };

    case ActionTypes.SET_VALIDATION:
      return {
        ...state,
        validationResult: action.payload,
        currentStep: 4,
        loading: false
      };

    case ActionTypes.SET_STRICT_MODE:
      return {
        ...state,
        strictMode: action.payload
      };

    case ActionTypes.SET_STEP:
      return {
        ...state,
        currentStep: action.payload
      };

    case ActionTypes.START_LOADING:
      return {
        ...state,
        loading: true,
        error: null
      };

    case ActionTypes.STOP_LOADING:
      return {
        ...state,
        loading: false
      };

    case ActionTypes.START_SAVING:
      return {
        ...state,
        saving: true,
        error: null
      };

    case ActionTypes.SAVE_SUCCESS:
      return {
        ...state,
        saving: false,
        error: null
      };

    case ActionTypes.SAVE_ERROR:
      return {
        ...state,
        saving: false,
        error: action.payload
      };

    case ActionTypes.SET_ERROR:
      return {
        ...state,
        error: action.payload,
        loading: false,
        saving: false
      };

    case ActionTypes.GO_BACK:
      return {
        ...state,
        currentStep: Math.max(1, state.currentStep - 1)
      };

    case ActionTypes.RESET:
      return initialState;

    default:
      return state;
  }
}

/**
 * Upload Workflow Hook
 * @returns {Object} { state, actions }
 */
export function useUploadWorkflow() {
  const [state, dispatch] = useReducer(uploadWorkflowReducer, initialState);

  // Actions
  const actions = {
    setUploadType: (uploadType) => 
      dispatch({ type: ActionTypes.SET_UPLOAD_TYPE, payload: uploadType }),

    setFile: (file, fileName, rawRows, columns) => 
      dispatch({ 
        type: ActionTypes.SET_FILE, 
        payload: { file, fileName, rawRows, columns } 
      }),

    setMapping: (mapping) => 
      dispatch({ type: ActionTypes.SET_MAPPING, payload: mapping }),

    setMappingComplete: (isComplete) => 
      dispatch({ type: ActionTypes.SET_MAPPING_COMPLETE, payload: isComplete }),

    setValidation: (validationResult) => 
      dispatch({ type: ActionTypes.SET_VALIDATION, payload: validationResult }),

    setStrictMode: (isStrict) => 
      dispatch({ type: ActionTypes.SET_STRICT_MODE, payload: isStrict }),

    setStep: (step) => 
      dispatch({ type: ActionTypes.SET_STEP, payload: step }),

    startLoading: () => 
      dispatch({ type: ActionTypes.START_LOADING }),

    stopLoading: () => 
      dispatch({ type: ActionTypes.STOP_LOADING }),

    startSaving: () => 
      dispatch({ type: ActionTypes.START_SAVING }),

    saveSuccess: () => 
      dispatch({ type: ActionTypes.SAVE_SUCCESS }),

    saveError: (error) => 
      dispatch({ type: ActionTypes.SAVE_ERROR, payload: error }),

    setError: (error) => 
      dispatch({ type: ActionTypes.SET_ERROR, payload: error }),

    goBack: () => 
      dispatch({ type: ActionTypes.GO_BACK }),

    reset: () => 
      dispatch({ type: ActionTypes.RESET })
  };

  return { state, actions };
}

export { ActionTypes };
