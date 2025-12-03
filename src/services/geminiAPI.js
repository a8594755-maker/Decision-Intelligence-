/**
 * Gemini AI API Service
 * 處理所有與 Google Gemini AI 的互動
 */

const DEFAULT_API_KEY = "AIzaSyBiPV68i9HR_D6a_PQ3lwSEJSIYZ0eF3j4";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

/**
 * 從 localStorage 獲取 API Key，如果沒有則使用預設值
 */
export const getApiKey = () => {
  return localStorage.getItem('gemini_api_key') || DEFAULT_API_KEY;
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
        maxOutputTokens: options.maxOutputTokens || 2048,
      }
    };

    const response = await fetch(
      `${GEMINI_API_URL}?key=${apiKey}`,
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
        return "WARNING: API quota is exhausted.\n\nTry:\n1. Wait for the daily reset\n2. Swap in a new API key in Settings\n3. Upgrade to a paid plan\n\nGet another free key: https://ai.google.dev/";
      }

      throw new Error(`API Error: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
  } catch (error) {
    console.error("Gemini API Failed:", error);
    return `ERROR: AI service request failed: ${error.message}\n\nPlease check:\n- Is your API key correct?\n- Is the network available?\n- Any firewall blocking the request?`;
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
