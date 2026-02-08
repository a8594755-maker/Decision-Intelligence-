"""ML API 启动脚本 - 自动设置 PYTHONPATH"""
import sys
import os

# 将 src 目录加入 Python 路径（同时设置环境变量，确保 reload 子进程也能继承）
src_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src")
sys.path.insert(0, src_path)
os.environ["PYTHONPATH"] = src_path

import uvicorn

if __name__ == "__main__":
    uvicorn.run("ml.api.main:app", host="127.0.0.1", port=8000, reload=True)
