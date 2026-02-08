# 设置虚拟环境路径
$venvPath = "C:\Users\a8594\smartops-app\.venv\Scripts"

# 添加到当前会话PATH
$env:Path += ";$venvPath"

# 启动ML API
Start-Process -NoNewWindow -FilePath "uvicorn" -ArgumentList "src.ml.api.main:app --reload --port 8000"

# 启动前端
Start-Process -NoNewWindow -FilePath "npm" -ArgumentList "run dev"
