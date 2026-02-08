import axios from 'axios';

// API base URL - adjust according to your deployment
const API_BASE_URL = import.meta.env.VITE_ML_API_URL || 'http://localhost:8000';

class DualModelForecastService {
  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000, // 30 seconds timeout for ML operations
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Execute dual-model forecast
   * @param {Object} params - Forecast parameters
   * @param {string} params.materialCode - SKU/material code
   * @param {number} params.horizonDays - Forecast horizon (default: 30)
   * @param {string} params.modelType - Preferred model type (optional)
   * @param {boolean} params.includeComparison - Include model comparison (default: true)
   * @param {string} params.userPreference - User's preferred model (optional)
   * @returns {Promise<Object>} Forecast results
   */
  async executeForecast(params) {
    try {
      const response = await this.client.post('/demand-forecast', {
        materialCode: params.materialCode,
        horizonDays: params.horizonDays || 30,
        modelType: params.modelType || null,
        includeComparison: params.includeComparison !== false,
        userPreference: params.userPreference || null,
      });

      return response.data;
    } catch (error) {
      console.error('Forecast API error:', error);
      throw this.handleError(error);
    }
  }

  /**
   * Analyze SKU characteristics and get model recommendation
   * @param {string} materialCode - SKU/material code
   * @returns {Promise<Object>} Analysis results
   */
  async analyzeSKU(materialCode) {
    try {
      const response = await this.client.post('/analyze-sku', {
        materialCode,
      });

      return response.data;
    } catch (error) {
      console.error('SKU analysis error:', error);
      throw this.handleError(error);
    }
  }

  /**
   * Get model status and availability
   * @returns {Promise<Object>} Model status information
   */
  async getModelStatus() {
    try {
      const response = await this.client.post('/model-status', {});
      return response.data;
    } catch (error) {
      console.error('Model status error:', error);
      throw this.handleError(error);
    }
  }

  /**
   * Health check for the API
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      const response = await this.client.get('/health');
      return response.data;
    } catch (error) {
      console.error('Health check error:', error);
      throw this.handleError(error);
    }
  }

  /**
   * Execute forecast with automatic retry and fallback
   * @param {Object} params - Forecast parameters
   * @param {number} maxRetries - Maximum retry attempts
   * @returns {Promise<Object>} Forecast results
   */
  async executeForecastWithRetry(params, maxRetries = 2) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeForecast(params);
        
        // If successful, return result
        if (result && !result.error) {
          return result;
        }
        
        // If there's an error but we have fallback models, it might still be usable
        if (result.error && result.attempted_models && result.attempted_models.length > 1) {
          console.warn(`Forecast partially successful on attempt ${attempt}:`, result);
          return result;
        }
        
        lastError = result.error || 'Unknown error';
        
        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
      } catch (error) {
        lastError = error.message || error.toString();
        console.warn(`Forecast attempt ${attempt} failed:`, lastError);
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`Forecast failed after ${maxRetries} attempts: ${lastError}`);
  }

  /**
   * Batch forecast for multiple SKUs
   * @param {Array} skuList - List of SKU codes
   * @param {Object} options - Forecast options
   * @returns {Promise<Array>} Array of forecast results
   */
  async executeBatchForecast(skuList, options = {}) {
    const results = [];
    const concurrency = options.concurrency || 3; // Process 3 at a time
    
    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < skuList.length; i += concurrency) {
      const batch = skuList.slice(i, i + concurrency);
      const batchPromises = batch.map(async (sku) => {
        try {
          const result = await this.executeForecast({
            materialCode: sku,
            ...options
          });
          return { sku, success: true, result };
        } catch (error) {
          console.error(`Batch forecast failed for SKU ${sku}:`, error);
          return { sku, success: false, error: error.message };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Small delay between batches
      if (i + concurrency < skuList.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    return results;
  }

  /**
   * Get forecast comparison statistics
   * @param {string} materialCode - SKU code
   * @param {number} horizonDays - Forecast horizon
   * @returns {Promise<Object>} Comparison statistics
   */
  async getComparisonStats(materialCode, horizonDays = 30) {
    try {
      // Execute forecast with comparison enabled
      const result = await this.executeForecast({
        materialCode,
        horizonDays,
        includeComparison: true,
      });
      
      if (!result.comparison) {
        return {
          hasComparison: false,
          message: 'No comparison data available'
        };
      }
      
      return {
        hasComparison: true,
        primaryModel: result.forecast.model,
        secondaryModel: result.comparison.secondary_model,
        deviation: result.comparison.deviation_pct,
        agreementLevel: result.comparison.agreement_level,
        consensusWarning: result.consensus_warning,
        primaryMean: result.forecast.median,
        secondaryMean: result.comparison.secondary_prediction,
      };
      
    } catch (error) {
      console.error('Comparison stats error:', error);
      throw this.handleError(error);
    }
  }

  /**
   * Cache forecast results in localStorage (for demo purposes)
   * @param {string} key - Cache key
   * @param {Object} data - Data to cache
   * @param {number} ttl - Time to live in minutes (default: 60)
   */
  cacheForecast(key, data, ttl = 60) {
    try {
      const cacheData = {
        data,
        timestamp: Date.now(),
        ttl: ttl * 60 * 1000, // Convert to milliseconds
      };
      
      localStorage.setItem(`forecast_cache_${key}`, JSON.stringify(cacheData));
    } catch (error) {
      console.warn('Failed to cache forecast data:', error);
    }
  }

  /**
   * Get cached forecast results
   * @param {string} key - Cache key
   * @returns {Object|null} Cached data or null if expired/not found
   */
  getCachedForecast(key) {
    try {
      const cached = localStorage.getItem(`forecast_cache_${key}`);
      
      if (!cached) {
        return null;
      }
      
      const cacheData = JSON.parse(cached);
      const now = Date.now();
      
      // Check if cache is expired
      if (now - cacheData.timestamp > cacheData.ttl) {
        localStorage.removeItem(`forecast_cache_${key}`);
        return null;
      }
      
      return cacheData.data;
    } catch (error) {
      console.warn('Failed to retrieve cached forecast data:', error);
      return null;
    }
  }

  /**
   * Handle API errors consistently
   * @param {Error} error - API error
   * @returns {Error} Formatted error
   */
  handleError(error) {
    if (error.response) {
      // Server responded with error status
      const status = error.response.status;
      const message = error.response.data?.error || error.response.data?.message || 'Unknown server error';
      
      switch (status) {
        case 400:
          return new Error(`Bad request: ${message}`);
        case 404:
          return new Error(`Resource not found: ${message}`);
        case 429:
          return new Error(`Rate limit exceeded: ${message}`);
        case 500:
          return new Error(`Server error: ${message}`);
        default:
          return new Error(`API error (${status}): ${message}`);
      }
    } else if (error.request) {
      // Network error
      return new Error('Network error: Unable to connect to the forecast service');
    } else {
      // Other error
      return new Error(`Forecast service error: ${error.message}`);
    }
  }

  /**
   * Generate cache key for forecast requests
   * @param {Object} params - Forecast parameters
   * @returns {string} Cache key
   */
  generateCacheKey(params) {
    const keyParts = [
      params.materialCode,
      params.horizonDays || 30,
      params.modelType || 'auto',
      params.includeComparison ? 'cmp' : 'nocmp',
      params.userPreference || 'nopref'
    ];
    
    return keyParts.join('_');
  }
}

// Create singleton instance
const dualModelForecastService = new DualModelForecastService();

export default dualModelForecastService;
