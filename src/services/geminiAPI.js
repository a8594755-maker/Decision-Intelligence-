/**
 * Gemini AI API Service
 * 處理所有與 Google Gemini AI 的互動
 */

// Using environment variable for API key (falls back to empty string)
const DEFAULT_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
// Using user-specified model gemini-2.5-flash
const GEMINI_MODEL = "gemini-2.5-flash";
const API_VERSION = "v1beta"; // Use v1beta for experimental models

/**
 * 從環境變數、localStorage 或預設值獲取 API Key
 * 優先順序：環境變數 > localStorage > 預設值
 */
export const getApiKey = () => {
  // 優先使用環境變數（如果存在）
  if (import.meta.env.VITE_GEMINI_API_KEY) {
    return import.meta.env.VITE_GEMINI_API_KEY;
  }
  // 其次使用 localStorage
  const storedKey = localStorage.getItem('gemini_api_key');
  if (storedKey) {
    return storedKey;
  }
  // 最後使用預設值
  return DEFAULT_API_KEY;
};

/**
 * 保存 API Key 到 localStorage
 */
export const saveApiKey = (apiKey) => {
  if (apiKey && apiKey.trim()) {
    localStorage.setItem('gemini_api_key', apiKey.trim());
    return true;
  }
  return false;
};

/**
 * 清除 API Key
 */
export const clearApiKey = () => {
  localStorage.removeItem('gemini_api_key');
};

/**
 * 調用 Gemini API
 * @param {string} prompt - 用戶提示
 * @param {string} systemContext - 系統上下文（可選）
 * @param {object} options - 配置選項
 * @returns {Promise<string>} AI 回應
 */
export const callGeminiAPI = async (prompt, systemContext = "", options = {}) => {
  const apiKey = getApiKey();

  if (!apiKey) {
    console.warn("No API Key found.");
    return "WARNING: No API key found. Add your Google AI API key in Settings.\n\nYou can grab a free key here: https://ai.google.dev/";
  }

  try {
    const fullPrompt = systemContext
      ? `${systemContext}\n\nUser Query: ${prompt}`
      : prompt;

    const requestBody = {
      contents: [{
        parts: [{ text: fullPrompt }]
      }],
      generationConfig: {
        temperature: options.temperature || 0.7,
        maxOutputTokens: options.maxOutputTokens || 8192,  // Increased default for longer responses
      }
    };

    const apiUrl = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${GEMINI_MODEL}:generateContent`;
    console.log(`Using API URL: ${apiUrl}`);

    const response = await fetch(
      `${apiUrl}?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("API Error Details:", errorData);

      // Handle quota errors explicitly
      if (response.status === 429) {
        return "⚠️ API 配額已用完\n\n請嘗試：\n1. 等待每日重置\n2. 在設定中更換新的 API key\n3. 升級至付費方案\n\n取得新的免費 key: https://ai.google.dev/";
      }

      // Handle service unavailable (503) - model overloaded
      if (response.status === 503) {
        return "⚠️ AI 服務暫時不可用\n\n模型目前過載，請稍後再試。\n\n建議：\n1. 等待 30 秒後重試\n2. 檢查網路連線\n3. 如果問題持續，請稍後再試";
      }

      // Handle other errors
      const errorMessage = errorData.error?.message || '未知錯誤';
      return `❌ AI 服務錯誤 (${response.status})\n\n${errorMessage}\n\n請檢查：\n1. API key 是否正確\n2. 網路連線是否正常\n3. 稍後再試`;
    }

    const data = await response.json();
    console.log("=== Gemini API Full Response ===");
    console.log(JSON.stringify(data, null, 2));
    
    // Check for errors in response
    if (data.error) {
      console.error("API returned error:", data.error);
      return `ERROR: ${data.error.message || 'Unknown API error'}`;
    }
    
    // Check for safety filters or blocked content
    if (data.candidates?.[0]?.finishReason === "SAFETY") {
      console.warn("Content blocked by safety filters:", data.candidates[0].safetyRatings);
      return "WARNING: Content blocked by AI safety filters.\n\nThe AI detected potentially sensitive content in the request or response. Try:\n1. Simplify your data\n2. Remove any sensitive information\n3. Try again with different parameters";
    }
    
    // Check finish reason
    const finishReason = data.candidates?.[0]?.finishReason;
    console.log("Finish reason:", finishReason);
    
    // Handle MAX_TOKENS finish reason - response might still have partial text
    if (finishReason === "MAX_TOKENS") {
      const partialText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (partialText) {
        console.warn("Response was truncated due to MAX_TOKENS, but partial text is available");
        return partialText + "\n\n[回應因長度限制被截斷]";
      }
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      console.warn("No text in response. Candidates:", data.candidates);
      return `No response generated.\n\nFinish reason: ${finishReason || 'unknown'}\n\nThis might be due to:\n1. Content safety filters\n2. Model not supporting this request\n3. Invalid model name (current: ${GEMINI_MODEL})\n\nPlease check the console for full details.`;
    }
    
    return text;
  } catch (error) {
    console.error("Gemini API Failed:", error);
    
    // Handle network errors
    if (error.message.includes('fetch') || error.message.includes('network')) {
      return "❌ 網路連線錯誤\n\n無法連接到 AI 服務。\n\n請檢查：\n1. 網路連線是否正常\n2. 防火牆是否阻擋請求\n3. 稍後再試";
    }
    
    // Handle timeout errors
    if (error.message.includes('timeout') || error.name === 'AbortError') {
      return "⏱️ 請求超時\n\nAI 服務回應時間過長。\n\n請嘗試：\n1. 稍後再試\n2. 簡化您的問題\n3. 檢查網路連線";
    }
    
    return `❌ AI 服務請求失敗\n\n錯誤訊息: ${error.message}\n\n請檢查：\n1. API key 是否正確設定\n2. 網路連線是否正常\n3. 防火牆是否阻擋請求\n4. 稍後再試`;
  }
};

/**
 * 專門用於數據分析的 AI 調用
 */
export const analyzeData = async (data, analysisType = "general") => {
  const sample = Array.isArray(data) ? data.slice(0, 30) : data;

  let prompt = "";

  switch (analysisType) {
    case "profile":
      prompt = `You are a data profiler. Given JSON rows, infer field names, data quality issues, and errors. Return JSON {"fields": ["field1", ...], "quality": "Chinese quality summary", "summary": "Chinese content summary"}. Sample rows: ${JSON.stringify(sample).slice(0, 12000)}`;
      break;

    case "quality":
      prompt = `Analyze data quality of the following dataset. Identify missing values, inconsistencies, and potential errors. Provide recommendations in Chinese: ${JSON.stringify(sample).slice(0, 12000)}`;
      break;

    case "insights":
      prompt = `Analyze this dataset and provide key business insights, trends, and actionable recommendations in Chinese: ${JSON.stringify(sample).slice(0, 12000)}`;
      break;

    default:
      prompt = `Analyze this data and provide a summary in Chinese: ${JSON.stringify(sample).slice(0, 12000)}`;
  }

  return await callGeminiAPI(prompt);
};

/**
 * 用於對話式 AI 的調用
 */
export const chatWithAI = async (message, conversationHistory = [], dataContext = null) => {
  let systemContext = "";

  if (dataContext && Array.isArray(dataContext)) {
    systemContext = `USER DATA CONTEXT: ${JSON.stringify(dataContext.slice(0, 5))}`;
  }

  // 構建對話歷史
  if (conversationHistory.length > 0) {
    const historyText = conversationHistory
      .slice(-5) // 只取最近 5 條對話
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');

    systemContext += `\n\nConversation History:\n${historyText}`;
  }

  return await callGeminiAPI(message, systemContext);
};

/**
 * 生成報告摘要
 */
export const generateReportSummary = async (reportType, data) => {
  const prompt = `Generate a comprehensive ${reportType} report summary based on the following data. Provide insights, trends, and recommendations in Chinese: ${JSON.stringify(data).slice(0, 10000)}`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 3000
  });
};

/**
 * 解析 AI 回應中的 JSON
 */
export const extractJsonFromResponse = (text) => {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_err) {
        return {};
      }
    }
    return {};
  }
};

/**
 * 分析成本异常
 * @param {object} anomaly - 异常数据
 * @param {object} historicalData - 历史数据（可选）
 * @returns {Promise<string>} AI 分析结果
 */
export const analyzeCostAnomaly = async (anomaly, historicalData = null) => {
  let prompt = `你是一位成本分析专家。请分析以下成本异常情况，并提供详细的分析和建议。

异常类型: ${anomaly.anomaly_type}
异常日期: ${anomaly.anomaly_date}
检测值: ${anomaly.detected_value}
预期值: ${anomaly.expected_value}
偏差: ${anomaly.deviation_percent}%
描述: ${anomaly.description || '无'}`;

  if (historicalData) {
    prompt += `\n\n历史数据参考:\n${JSON.stringify(historicalData).slice(0, 3000)}`;
  }

  prompt += `\n\n请用中文提供：
1. 可能的原因分析（2-3个主要原因）
2. 对业务的影响评估
3. 具体的改善建议（3-5条可执行的建议）
4. 预防未来发生的措施

请保持专业、简洁，重点突出可执行性。`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 1500
  });
};

/**
 * 生成成本优化建议
 * @param {object} costStructure - 成本结构数据
 * @param {object} trends - 成本趋势数据
 * @returns {Promise<string>} AI 优化建议
 */
export const generateCostOptimizationSuggestions = async (costStructure, trends) => {
  const prompt = `你是一位营运成本优化顾问。请基于以下数据提供成本优化建议。

成本结构:
- 直接人工: ${costStructure.breakdown?.directLabor || 0} 元 (${(costStructure.percentages?.directLabor || 0).toFixed(1)}%)
- 间接人工: ${costStructure.breakdown?.indirectLabor || 0} 元 (${(costStructure.percentages?.indirectLabor || 0).toFixed(1)}%)
- 材料成本: ${costStructure.breakdown?.material || 0} 元 (${(costStructure.percentages?.material || 0).toFixed(1)}%)
- 间接费用: ${costStructure.breakdown?.overhead || 0} 元 (${(costStructure.percentages?.overhead || 0).toFixed(1)}%)
- 总成本: ${costStructure.totalCost || 0} 元
- 单位成本: ${costStructure.costPerUnit || 0} 元/件

近期趋势:
- 平均总成本: ${trends.averages?.avgTotalCost || 0} 元
- 平均单位成本: ${trends.averages?.avgUnitCost || 0} 元

请用中文提供：
1. 成本结构分析（哪些部分占比过高？）
2. 优化机会识别（3-5个具体的优化点）
3. 优先级排序（哪些应该先做？）
4. 预期效益评估

请务实、具体，避免空泛建议。`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.6,
    maxOutputTokens: 2000
  });
};

/**
 * 预测成本趋势
 * @param {Array} historicalCosts - 历史成本数据
 * @param {number} forecastDays - 预测天数
 * @returns {Promise<string>} AI 预测分析
 */
export const predictCostTrend = async (historicalCosts, forecastDays = 7) => {
  const recentData = historicalCosts.slice(-30); // 取最近30天

  const prompt = `你是一位数据分析师，擅长成本预测。请基于以下历史成本数据，预测未来 ${forecastDays} 天的成本趋势。

历史数据（最近30天）:
${JSON.stringify(recentData.map(d => ({
  date: d.cost_date,
  total: d.total_labor_cost,
  unit: d.cost_per_unit,
  output: d.production_output
}))).slice(0, 4000)}

请用中文提供：
1. 趋势分析（上升/下降/稳定？）
2. 关键影响因素识别
3. 未来${forecastDays}天的预测（大致范围）
4. 风险提示（需要注意什么？）

请基于数据说话，避免过度推测。`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 1500
  });
};

export default {
  callGeminiAPI,
  analyzeData,
  chatWithAI,
  generateReportSummary,
  extractJsonFromResponse,
  getApiKey,
  saveApiKey,
  clearApiKey,
  // 成本分析相关 AI 功能
  analyzeCostAnomaly,
  generateCostOptimizationSuggestions,
  predictCostTrend
};
