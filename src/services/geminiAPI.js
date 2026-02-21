/**
 * Gemini AI API Service
 * Handles all interactions with Google Gemini AI
 */

import { buildDataProfilerPrompt } from '../prompts/dataProfilerPrompt';

// Using environment variable for API key (falls back to empty string)
const DEFAULT_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
// Model is env-driven; default to Gemini 3.1 Pro.
const GEMINI_MODEL = import.meta.env.VITE_GEMINI_MODEL || import.meta.env.VITE_DI_GEMINI_MODEL || "gemini-3.1-pro";
const API_VERSION = "v1beta"; // Use v1beta for experimental models

/**
 * Get API Key from environment variable, localStorage, or default value
 * Priority: environment variable > localStorage > default value
 */
export const getApiKey = () => {
  // Prefer environment variable (if exists)
  if (import.meta.env.VITE_GEMINI_API_KEY) {
    return import.meta.env.VITE_GEMINI_API_KEY;
  }
  // Then use localStorage
  const storedKey = localStorage.getItem('gemini_api_key');
  if (storedKey) {
    return storedKey;
  }
  // Finally use default value
  return DEFAULT_API_KEY;
};

/**
 * Save API Key to localStorage
 */
export const saveApiKey = (apiKey) => {
  if (apiKey && apiKey.trim()) {
    localStorage.setItem('gemini_api_key', apiKey.trim());
    return true;
  }
  return false;
};

/**
 * Clear API Key
 */
export const clearApiKey = () => {
  localStorage.removeItem('gemini_api_key');
};

/**
 * Call Gemini API
 * @param {string} prompt - User prompt
 * @param {string} systemContext - System context (optional)
 * @param {object} options - Configuration options
 * @returns {Promise<string>} AI response
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
        return "⚠️ API quota exhausted\n\nPlease try:\n1. Wait for daily reset\n2. Replace with a new API key in Settings\n3. Upgrade to a paid plan\n\nGet a new free key: https://ai.google.dev/";
      }

      // Handle service unavailable (503) - model overloaded
      if (response.status === 503) {
        return "⚠️ AI service temporarily unavailable\n\nModel is currently overloaded, please try again later.\n\nSuggestions:\n1. Wait 30 seconds and retry\n2. Check network connection\n3. If the issue persists, try again later";
      }

      // Handle other errors
      const errorMessage = errorData.error?.message || 'Unknown error';
      return `❌ AI service error (${response.status})\n\n${errorMessage}\n\nPlease check:\n1. Is the API key correct\n2. Is the network connection working\n3. Try again later`;
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
        return partialText + "\n\n[Response truncated due to length limit]";
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
      return "❌ Network connection error\n\nUnable to connect to AI service.\n\nPlease check:\n1. Is the network connection working\n2. Is the firewall blocking requests\n3. Try again later";
    }
    
    // Handle timeout errors
    if (error.message.includes('timeout') || error.name === 'AbortError') {
      return "⏱️ Request timeout\n\nAI service response took too long.\n\nPlease try:\n1. Try again later\n2. Simplify your question\n3. Check network connection";
    }
    
    return `❌ AI service request failed\n\nError message: ${error.message}\n\nPlease check:\n1. Is the API key configured correctly\n2. Is the network connection working\n3. Is the firewall blocking requests\n4. Try again later`;
  }
};

/**
 * AI call specifically for data analysis
 */
export const analyzeData = async (data, analysisType = "general") => {
  const sample = Array.isArray(data) ? data.slice(0, 30) : data;

  let prompt = "";

  switch (analysisType) {
    case "profile":
      prompt = buildDataProfilerPrompt(sample);
      break;

    case "quality":
      prompt = `Analyze data quality of the following dataset. Identify missing values, inconsistencies, and potential errors. Provide recommendations: ${JSON.stringify(sample).slice(0, 12000)}`;
      break;

    case "insights":
      prompt = `Analyze this dataset and provide key business insights, trends, and actionable recommendations: ${JSON.stringify(sample).slice(0, 12000)}`;
      break;

    default:
      prompt = `Analyze this data and provide a summary: ${JSON.stringify(sample).slice(0, 12000)}`;
  }

  return await callGeminiAPI(prompt);
};

/**
 * AI call for conversational chat
 */
export const chatWithAI = async (message, conversationHistory = [], dataContext = null) => {
  let systemContext = "";

  if (dataContext && Array.isArray(dataContext)) {
    systemContext = `USER DATA CONTEXT: ${JSON.stringify(dataContext.slice(0, 5))}`;
  }

  // Build conversation history
  if (conversationHistory.length > 0) {
    const historyText = conversationHistory
      .slice(-5) // Only take last 5 messages
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');

    systemContext += `\n\nConversation History:\n${historyText}`;
  }

  return await callGeminiAPI(message, systemContext);
};

/**
 * Generate report summary
 */
export const generateReportSummary = async (reportType, data) => {
  const prompt = `Generate a comprehensive ${reportType} report summary based on the following data. Provide insights, trends, and recommendations: ${JSON.stringify(data).slice(0, 10000)}`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 3000
  });
};

/**
 * Extract JSON from AI response
 */
export const extractJsonFromResponse = (text) => {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return {};
      }
    }
    return {};
  }
};

/**
 * Analyze cost anomaly
 * @param {object} anomaly - Anomaly data
 * @param {object} historicalData - Historical data (optional)
 * @returns {Promise<string>} AI analysis result
 */
export const analyzeCostAnomaly = async (anomaly, historicalData = null) => {
  let prompt = `You are a cost analysis expert. Please analyze the following cost anomaly and provide detailed analysis and recommendations.

Anomaly Type: ${anomaly.anomaly_type}
Anomaly Date: ${anomaly.anomaly_date}
Detected Value: ${anomaly.detected_value}
Expected Value: ${anomaly.expected_value}
Deviation: ${anomaly.deviation_percent}%
Description: ${anomaly.description || 'None'}`;

  if (historicalData) {
    prompt += `\n\nHistorical data reference:\n${JSON.stringify(historicalData).slice(0, 3000)}`;
  }

  prompt += `\n\nPlease provide:
1. Possible root cause analysis (2-3 main causes)
2. Business impact assessment
3. Specific improvement recommendations (3-5 actionable suggestions)
4. Preventive measures for the future

Please be professional, concise, and focus on actionability.`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 1500
  });
};

/**
 * Generate cost optimization suggestions
 * @param {object} costStructure - Cost structure data
 * @param {object} trends - Cost trend data
 * @returns {Promise<string>} AI optimization suggestions
 */
export const generateCostOptimizationSuggestions = async (costStructure, trends) => {
  const prompt = `You are an operational cost optimization consultant. Please provide cost optimization suggestions based on the following data.

Cost Structure:
- Direct Labor: ${costStructure.breakdown?.directLabor || 0} (${(costStructure.percentages?.directLabor || 0).toFixed(1)}%)
- Indirect Labor: ${costStructure.breakdown?.indirectLabor || 0} (${(costStructure.percentages?.indirectLabor || 0).toFixed(1)}%)
- Material Cost: ${costStructure.breakdown?.material || 0} (${(costStructure.percentages?.material || 0).toFixed(1)}%)
- Overhead: ${costStructure.breakdown?.overhead || 0} (${(costStructure.percentages?.overhead || 0).toFixed(1)}%)
- Total Cost: ${costStructure.totalCost || 0}
- Cost Per Unit: ${costStructure.costPerUnit || 0}/unit

Recent Trends:
- Average Total Cost: ${trends.averages?.avgTotalCost || 0}
- Average Unit Cost: ${trends.averages?.avgUnitCost || 0}

Please provide:
1. Cost structure analysis (which parts have disproportionately high ratios?)
2. Optimization opportunity identification (3-5 specific optimization points)
3. Priority ranking (which should be done first?)
4. Expected benefit assessment

Please be practical and specific, avoid generic suggestions.`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.6,
    maxOutputTokens: 2000
  });
};

/**
 * Predict cost trend
 * @param {Array} historicalCosts - Historical cost data
 * @param {number} forecastDays - Number of days to forecast
 * @returns {Promise<string>} AI prediction analysis
 */
export const predictCostTrend = async (historicalCosts, forecastDays = 7) => {
  const recentData = historicalCosts.slice(-30); // Take last 30 days

  const prompt = `You are a data analyst specializing in cost prediction. Based on the following historical cost data, predict the cost trend for the next ${forecastDays} days.

Historical Data (last 30 days):
${JSON.stringify(recentData.map(d => ({
  date: d.cost_date,
  total: d.total_labor_cost,
  unit: d.cost_per_unit,
  output: d.production_output
}))).slice(0, 4000)}

Please provide:
1. Trend analysis (rising/declining/stable?)
2. Key influencing factors identification
3. Forecast for the next ${forecastDays} days (approximate range)
4. Risk alerts (what should be watched?)

Please base your analysis on data, avoid excessive speculation.`;

  return await callGeminiAPI(prompt, "", {
    temperature: 0.5,
    maxOutputTokens: 1500
  });
};

/**
 * Streaming chat with AI - sends tokens to onChunk callback as they arrive.
 * Falls back to non-streaming callGeminiAPI if streaming fails.
 * @param {string} message - User message
 * @param {Array} conversationHistory - Recent messages [{role, content}, ...]
 * @param {string} systemPrompt - Rich system context (supply-chain state)
 * @param {function} onChunk - Called with each text chunk as it streams
 * @returns {Promise<string>} Full concatenated response
 */
export const streamChatWithAI = async (message, conversationHistory = [], systemPrompt = '', onChunk = null) => {
  const apiKey = getApiKey();

  if (!apiKey) {
    const fallback = "WARNING: No API key found. Add your Google AI API key in Settings.\n\nGet a free key: https://ai.google.dev/";
    onChunk?.(fallback);
    return fallback;
  }

  // Build context with history
  let fullContext = systemPrompt || '';

  if (conversationHistory.length > 0) {
    const historyText = conversationHistory
      .slice(-10)
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');
    fullContext += `\n\nConversation History:\n${historyText}`;
  }

  const fullPrompt = fullContext
    ? `${fullContext}\n\nUser Query: ${message}`
    : message;

  const requestBody = {
    contents: [{ parts: [{ text: fullPrompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    }
  };

  const apiUrl = `https://generativelanguage.googleapis.com/${API_VERSION}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      // Fall back to non-streaming
      console.warn('Streaming failed, falling back to non-streaming');
      const result = await callGeminiAPI(message, fullContext);
      onChunk?.(result);
      return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (chunk) {
            fullText += chunk;
            onChunk?.(chunk);
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }

    return fullText || 'No response generated.';
  } catch (error) {
    console.warn('Streaming error, falling back:', error.message);
    // Fall back to non-streaming
    const result = await callGeminiAPI(message, fullContext);
    onChunk?.(result);
    return result;
  }
};

export default {
  callGeminiAPI,
  analyzeData,
  chatWithAI,
  streamChatWithAI,
  generateReportSummary,
  extractJsonFromResponse,
  getApiKey,
  saveApiKey,
  clearApiKey,
  // Cost analysis related AI functions
  analyzeCostAnomaly,
  generateCostOptimizationSuggestions,
  predictCostTrend
};
