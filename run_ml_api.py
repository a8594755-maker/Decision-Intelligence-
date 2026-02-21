"""ML API 启动脚本 - 自动设置 PYTHONPATH"""
import sys
import os

# 将 src 目录加入 Python 路径（同时设置环境变量，确保 reload 子进程也能继承）
src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")
sys.path.insert(0, src_path)
os.environ["PYTHONPATH"] = src_path

# 加载 .env / .env.local 文件（确保 VITE_SUPABASE_URL 等变量可用）
try:
    from dotenv import load_dotenv
    base_dir = os.path.dirname(os.path.abspath(__file__))
    for env_file in (".env", ".env.local"):
        env_path = os.path.join(base_dir, env_file)
        if os.path.isfile(env_path):
            load_dotenv(env_path, override=True)
            print(f"✅ Loaded {env_file}")
    # Bridge VITE_ prefixed keys to non-prefixed names for Python backend
    if not os.getenv("DEEPSEEK_API_KEY") and os.getenv("VITE_DEEPSEEK_API_KEY"):
        os.environ["DEEPSEEK_API_KEY"] = os.getenv("VITE_DEEPSEEK_API_KEY")
    if not os.getenv("DEEPSEEK_BASE_URL") and os.getenv("VITE_DI_DEEPSEEK_BASE_URL"):
        os.environ["DEEPSEEK_BASE_URL"] = os.getenv("VITE_DI_DEEPSEEK_BASE_URL")
except ImportError:
    print("⚠️ python-dotenv not installed, reading env vars from system only")

import uvicorn

if __name__ == "__main__":
    uvicorn.run("ml.api.main:app", host="127.0.0.1", port=8000, reload=True)
