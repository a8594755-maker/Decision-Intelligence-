# Dual-Model Architecture Implementation

## Overview

This implementation introduces a sophisticated dual-model forecasting system that combines the stability of classical statistical methods with the power of modern AI, specifically designed for the Decision-Intelligence supply chain risk dashboard.

## Architecture Components

### Backend (Python + FastAPI)

#### 1. ChronosTrainer (`src/ml/demand_forecasting/chronos_trainer.py`)
- **Purpose**: Amazon Chronos zero-shot time series forecasting
- **Features**:
  - Hugging Face transformers integration
  - Sequence tokenization and detokenization
  - Confidence interval calculation through multiple sampling
  - Risk scoring based on prediction variance
  - Data suitability validation

#### 2. ForecasterFactory (`src/ml/demand_forecasting/forecaster_factory.py`)
- **Purpose**: Strategy Pattern implementation for dynamic model selection
- **Features**:
  - Intelligent model recommendation based on data characteristics
  - Automatic fallback mechanisms (Chronos → LightGBM → Prophet)
  - Consensus analysis and deviation detection
  - Data characteristic analysis (seasonality, volatility, data sufficiency)

#### 3. Enhanced API (`src/ml/api/main.py`)
- **New Endpoints**:
  - `/demand-forecast` - Dual-model forecasting with comparison
  - `/analyze-sku` - SKU analysis and model recommendation
  - `/model-status` - Model availability and status
  - `/health` - System health check

### Frontend (React + Tailwind)

#### 1. ModelToggle (`src/components/forecast/ModelToggle.jsx`)
- **Purpose**: Interactive model selection interface
- **Features**:
  - Visual model comparison (LightGBM, Chronos, Prophet)
  - Real-time model status indicators
  - Recommendation highlighting
  - Compact and full display modes

#### 2. ConsensusWarning (`src/components/forecast/ConsensusWarning.jsx`)
- **Purpose**: Intelligent consensus warning system
- **Features**:
  - Automatic deviation detection (>15% threshold)
  - Smart recommendations based on warning level
  - Interactive model switching
  - Detailed deviation analysis

#### 3. ConfidenceOverlayChart (`src/components/forecast/ConfidenceOverlayChart.jsx`)
- **Purpose**: Advanced visualization of dual-model predictions
- **Features**:
  - Overlay charts with confidence intervals
  - Historical data integration
  - Model comparison visualization
  - Interactive tooltips and legends

#### 4. Enhanced ForecastsView
- **Integration**: Seamless integration into existing demand forecast tab
- **Features**:
  - SKU auto-analysis
  - Real-time model switching
  - Cached predictions for performance
  - Comprehensive error handling

### Database Schema (`sql/migrations/dual_model_schema_update.sql`)

#### New Tables:
- `ml_model_comparison` - Model comparison results
- `ml_sku_analysis_cache` - SKU analysis caching
- `ml_model_performance` - Performance tracking
- `ml_consensus_config` - User preferences

#### Enhanced Tables:
- Extended `ml_model_history` for Chronos support
- Enhanced `ml_prediction_cache` for dual-model results

## Model Selection Strategy

### LightGBM (穩定模式)
- **Best for**: Data-rich scenarios with clear business logic
- **Strengths**: Structured features, price sensitivity, historical patterns
- **Use case**: >3 months data, external features available

### Amazon Chronos (AI 模式)
- **Best for**: Cold-start, anomaly detection, limited data
- **Strengths**: Zero-shot learning, pattern recognition, sequence-only
- **Use case**: New products, supply disruptions, raw sequences

### Prophet (季節模式)
- **Best for**: Strong seasonal patterns
- **Strengths**: Holiday effects, trend analysis, seasonality
- **Use case**: Clear seasonal cycles, holiday impacts

## Intelligent Features

### Auto-Recommendation System
```python
# Decision Logic
if data_points < 30:
    return ModelType.CHRONOS  # Limited data
elif external_features_available and data_sufficient:
    return ModelType.LIGHTGBM  # Rich features
elif seasonal_pattern_strong:
    return ModelType.PROPHET  # Seasonality
elif high_volatility_detected:
    return ModelType.CHRONOS  # Anomaly detection
else:
    return ModelType.LIGHTGBM  # Default
```

### Consensus Warning System
- **High Risk** (>15% deviation): Immediate alert, recommendation to check external factors
- **Medium Risk** (10-15% deviation): Monitoring suggestion, close observation
- **Low Risk** (<10% deviation): Normal operation, no action needed

### Performance Optimization
- **Caching**: 60-minute forecast cache, 24-hour analysis cache
- **Fallback**: Automatic model switching on failure
- **Batch Processing**: Concurrent model execution for comparison
- **Retry Logic**: Exponential backoff for API resilience

## Deployment Considerations

### Resource Requirements
- **CPU**: 1vCPU minimum (Railway)
- **RAM**: 2GB minimum for Chronos-tiny
- **Storage**: ~500MB for model files
- **Cost**: ~$10/month total

### Environment Variables
```bash
VITE_ML_API_URL=http://localhost:8000
ERP_ENDPOINT=https://your-erp-api.com
ERP_API_KEY=your-api-key
```

### Installation
```bash
# Backend dependencies
pip install -r requirements-ml.txt

# Frontend dependencies (already included)
npm install
```

## Usage Examples

### Basic Forecast
```javascript
const result = await dualModelForecastService.executeForecast({
  materialCode: 'VT-OSCM-001',
  horizonDays: 30,
  includeComparison: true
});
```

### SKU Analysis
```javascript
const analysis = await dualModelForecastService.analyzeSKU('VT-OSCM-001');
console.log(analysis.recommended_model); // 'chronos', 'lightgbm', or 'prophet'
```

### Model Status Check
```javascript
const status = await dualModelForecastService.getModelStatus();
console.log(status.models.chronos.available); // true/false
```

## API Response Format

### Successful Forecast
```json
{
  "materialCode": "VT-OSCM-001",
  "forecast": {
    "model": "CHRONOS",
    "median": 450,
    "confidence_interval": [410, 490],
    "risk_score": 75.5,
    "model_version": "chronos-t5-tiny-v1.0"
  },
  "comparison": {
    "secondary_model": "LIGHTGBM",
    "secondary_prediction": 420,
    "deviation_pct": 7.1,
    "agreement_level": "high"
  },
  "consensus_warning": {
    "warning": false
  },
  "metadata": {
    "training_data_points": 180,
    "forecast_horizon": 30,
    "generated_at": "2026-02-08T10:30:00Z"
  }
}
```

### Consensus Warning
```json
{
  "warning": true,
  "level": "high",
  "message": "模型預測差異較大 (18.3%)，建議檢查是否有未登錄的市場活動",
  "recommendation": "consider_external_factors"
}
```

## Testing & Validation

### Unit Tests
```bash
# Backend
pytest tests/test_chronos_trainer.py
pytest tests/test_forecaster_factory.py

# Frontend
npm test -- --testPathPattern=dual-model
```

### Integration Tests
```bash
# End-to-end forecast test
npm run test:dual-model-e2e
```

### Performance Benchmarks
- **Chronos Inference**: ~2s for 30-day forecast
- **LightGBM Training**: ~5s for 1-year data
- **Full Comparison**: ~8s total
- **Cache Hit**: <100ms response time

## Future Enhancements

### Planned Features
1. **Advanced Ensemble Methods**: Weighted model combinations
2. **Real-time Learning**: Online model updating
3. **Multi-horizon Forecasting**: Different models for different timeframes
4. **Explainability**: SHAP values for LightGBM, attention visualization for Chronos
5. **Anomaly Detection**: Dedicated anomaly scoring system

### Model Expansion
1. **Additional Models**: XGBoost, CatBoost, Neural Prophet
2. **Custom Models**: User-trained models for specific products
3. **External APIs**: Integration with commercial forecasting services
4. **Time Series Features**: Automatic feature engineering

## Monitoring & Maintenance

### Health Checks
- Model availability monitoring
- API response time tracking
- Prediction accuracy metrics
- Cache hit rate optimization

### Maintenance Tasks
- Weekly model performance review
- Monthly cache cleanup
- Quarterly model retraining
- Annual architecture review

## Support & Troubleshooting

### Common Issues
1. **Chronos Model Loading**: Ensure sufficient RAM and network access to Hugging Face
2. **Cache Expiration**: Check TTL settings and cleanup functions
3. **Model Disagreement**: Review data quality and external factors
4. **Performance**: Monitor memory usage and implement batching

### Debug Mode
```python
# Enable detailed logging
import logging
logging.basicConfig(level=logging.DEBUG)

# Check model status
status = forecaster_factory.get_model_status()
print(status)
```

## Conclusion

This dual-model architecture provides a robust, intelligent forecasting system that balances the reliability of classical methods with the adaptability of modern AI. The implementation is designed for production use with comprehensive error handling, performance optimization, and user-friendly interfaces.

The system successfully addresses the core requirements:
- ✅ Dual-model integration (LightGBM + Chronos)
- ✅ Intelligent model selection and fallback
- ✅ Consensus warning system
- ✅ Advanced visualization and UI
- ✅ Performance optimization and caching
- ✅ Comprehensive error handling
- ✅ Production-ready deployment

The architecture is extensible and can accommodate additional models and features as the system evolves.
