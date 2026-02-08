import requests
from datetime import datetime, timedelta

class ERPConnector:
    """
    ERP 数据连接器
    从企业资源规划系统获取历史销售数据
    """
    def __init__(self, api_endpoint, api_key):
        self.endpoint = api_endpoint
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

    def fetch_sales_data(self, sku, days=730):
        """
        获取指定SKU的历史销售数据
        :param sku: 产品SKU
        :param days: 获取数据的天数（默认2年）
        :return: 销售数据DataFrame
        """
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days)
        
        params = {
            "sku": sku,
            "start_date": start_date.strftime("%Y-%m-%d"),
            "end_date": end_date.strftime("%Y-%m-%d")
        }
        
        try:
            response = requests.get(
                f"{self.endpoint}/sales",
                headers=self.headers,
                params=params,
                timeout=30
            )
            response.raise_for_status()
            return response.json()["data"]
        except requests.exceptions.RequestException as e:
            print(f"ERP连接失败: {e}")
            return None
