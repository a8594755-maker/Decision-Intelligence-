# 测试数据示例
# 这个文件展示了如何使用Mock ERP连接器进行测试

## 快速测试示例

### 1. 基本预测测试
```bash
curl -X POST "http://localhost:8000/demand-forecast" \
-H "Content-Type: application/json" \
-d '{
    "materialCode": "SKU001",
    "horizonDays": 30,
    "modelType": "auto"
}'
```

### 2. 使用内联数据测试（完全离线）
```bash
curl -X POST "http://localhost:8000/demand-forecast" \
-H "Content-Type: application/json" \
-d '{
    "materialCode": "TEST_SKU",
    "horizonDays": 30,
    "history": [100, 120, 95, 110, 105, 130, 115, 125, 140, 135, 150, 145, 160, 155, 170, 165, 180, 175, 190, 185, 200, 195, 210, 205, 220, 215, 230, 225, 240, 235, 250],
    "modelType": "lightgbm"
}'
```

### 3. 压力测试
```bash
curl -X POST "http://localhost:8000/stress-test" \
-H "Content-Type: application/json" \
-d '{
    "materialCode": "STRESS_TEST",
    "horizonDays": 7,
    "history": [50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400, 425, 450, 475, 500],
    "modelType": "auto"
}'
```

### 4. 模型训练测试
```bash
curl -X POST "http://localhost:8000/train-model" \
-H "Content-Type: application/json" \
-d '{
    "modelType": "all",
    "days": 365,
    "use_optuna": true,
    "optuna_trials": 20,
    "mape_gate": 25.0
}'
```

## 预定义SKU数据模式

### SKU001 - 稳定增长型
- 基础销量: 100
- 趋势: +0.5/天 (轻微增长)
- 季节性: 0.3 (中等季节性)
- 波动性: 10% (相对稳定)

### SKU002 - 下降趋势型
- 基础销量: 50
- 趋势: -0.2/天 (轻微下降)
- 季节性: 0.5 (强季节性)
- 波动性: 15% (中等波动)

### SKU003 - 快速增长型
- 基础销量: 200
- 趋势: +1.0/天 (快速增长)
- 季节性: 0.2 (弱季节性)
- 波动性: 8% (相对稳定)

## 测试场景建议

### 场景1: 模型推荐测试
测试不同SKU的模型自动推荐功能：
- SKU001 (稳定增长) → 应推荐LightGBM
- SKU002 (季节性强) → 应推荐Prophet
- SKU003 (数据充足) → 应推荐LightGBM

### 场景2: 数据量测试
使用不同长度的history数组测试：
- 少于10个点 → 应回退到Chronos
- 10-30个点 → 可使用所有模型
- 超过365个点 → 最佳性能

### 场景3: 异常检测测试
在history中插入异常值测试检测功能：
```json
{
    "materialCode": "ANOMALY_TEST",
    "history": [100, 105, 95, 110, 105, 130, 115, 125, 140, 500, 150, 145],
    "horizonDays": 7
}
```

## 环境变量配置

创建 `.env` 文件或设置环境变量：

```bash
# 启用测试模式（使用Mock数据）
USE_MOCK_ERP=true

# 禁用测试模式（使用真实SAP API）
USE_MOCK_ERP=false

# 其他配置
ERP_ENDPOINT=https://your-sap-api.com
ERP_API_KEY=your-api-key
```

## 验证测试模式

启动服务后检查日志：
- 看到 "🧪 使用Mock ERP连接器 (测试模式)" = 测试模式已启用
- 看到 "🔗 使用真实ERP连接器" = 生产模式

## 数据特征

Mock数据包含以下特征：
- 📅 日期序列
- 📊 销售数据
- 🎯 价格指数 (周期性变化)
- 🏷️ 促销标记 (随机5%概率)
- 📦 库存水平 (基于销量的1.5-3倍)

这些特征可用于测试LightGBM的外部特征处理能力。
