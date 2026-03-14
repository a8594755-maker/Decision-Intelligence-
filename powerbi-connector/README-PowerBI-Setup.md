# SmartOps DI — Power BI Connector Setup

## Quick Start

### 1. Create Parameters in Power BI Desktop

Go to **Home → Manage Parameters → New Parameter** and create:

| Parameter Name | Type | Value |
|---|---|---|
| `SupabaseUrl` | Text | Your Supabase project URL (e.g. `https://xyz.supabase.co`) |
| `SupabaseAccessToken` | Text | Your Supabase JWT access token |

### 2. Import the Query

1. Open Power BI Desktop
2. **Home → Get Data → Blank Query**
3. Click **Advanced Editor**
4. Paste the contents of `SmartOpsDI.pq`
5. Click **Done**

### 3. Available Tables

The connector provides these data sources:

| Table | Description |
|---|---|
| **Reports** | List of all AI employee task reports |
| **KPIs** | Current key performance indicators |
| **Forecast** | Time-series forecast data |
| **Plan** | Replenishment plan table |
| **Risk Scores** | Supply chain risk scores by entity |
| **Reviews** | AI quality review results |

### 4. Refresh

- **Manual**: Click Refresh in Power BI Desktop
- **Scheduled**: Set up in Power BI Service (requires gateway for on-prem, or direct cloud access)

### 5. Getting an Access Token

Option A — Use the SmartOps app:
1. Sign into the SmartOps DI web app
2. Open browser DevTools → Application → Local Storage
3. Find `sb-<project>-auth-token` → copy `access_token`

Option B — Use the API:
```
POST https://<your-project>.supabase.co/auth/v1/token?grant_type=password
Content-Type: application/json
apikey: <your-anon-key>

{ "email": "you@example.com", "password": "..." }
```

Note: Tokens expire after 1 hour. For production, set up a service role key or OAuth flow.

## Individual Queries

If you only need specific data, import individual functions from `SmartOpsDI.pq`:

### Forecast Only
```m
let
    Source = GetForecast("task-id-here")
in
    Source
```

### Monthly Report
```m
let
    Source = GetMonthly(2026, 2)
in
    Source[Tasks]
```
