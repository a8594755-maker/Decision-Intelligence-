# ── Stage 1: builder ──────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# 系統依賴（prophet 需要 libstan，ortools 需要 gcc）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 先複製 requirements（利用 layer cache）
COPY requirements-ml.txt constraints-deploy.txt ./

# 不裝 torch/transformers（減少映像大小，Chronos 改為 optional）
# 如需完整版，移除 grep 過濾改成 pip install -r requirements-ml.txt
RUN pip install --no-cache-dir --upgrade pip && \
    grep -v "^torch\|^transformers\|^accelerate" requirements-ml.txt \
    > requirements-deploy.txt && \
    pip install --no-cache-dir -c constraints-deploy.txt -r requirements-deploy.txt

# ── Stage 2: runtime ──────────────────────────────────────────
FROM python:3.12-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# 從 builder 複製已安裝的 packages
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# 複製 source code
COPY src/ ./src/
COPY run_ml_api.py .

# 環境變數預設值
ENV PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=0 \
    PYTHONPATH=/app/src \
    HOST=0.0.0.0 \
    PORT=8000 \
    DI_SOLVER_ENGINE=ortools \
    DI_CHRONOS_ENABLED=false

EXPOSE 8000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["sh", "-c", "python -c \"import os,urllib.request;urllib.request.urlopen('http://localhost:%s/health'%os.environ.get('PORT','8000'),timeout=5)\" || exit 1"]

CMD ["sh", "-c", "python -m uvicorn ml.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --timeout-keep-alive 30"]
