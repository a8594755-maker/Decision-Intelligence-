"""ML API 启动脚本 - 自动设置 PYTHONPATH"""
import sys
import os

# 将 src 目录加入 Python 路径（同时设置环境变量，确保 reload 子进程也能继承）
src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")
sys.path.insert(0, src_path)
os.environ["PYTHONPATH"] = src_path

# 加载 .env 文件（确保 VITE_SUPABASE_URL 等变量可用）
try:
    from dotenv import load_dotenv
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(env_path)
    print(f"✅ Loaded .env from {env_path}")
except ImportError:
    print("⚠️ python-dotenv not installed, reading env vars from system only")

import uvicorn

if __name__ == "__main__":
    uvicorn.run("ml.api.main:app", host="127.0.0.1", port=8000, reload=True)
