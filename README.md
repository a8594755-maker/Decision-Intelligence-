# Decision Intelligence

An intelligent supplier performance and cost operations dashboard built with React + Vite, integrating Supabase cloud database, Google Gemini AI decision assistant, Excel/CSV import, KPI visualization, anomaly analysis, and automated workflows.

## 🌟 Key Features

### 📊 Supplier Management
- **Supplier Master Management**: Complete CRUD operations, advanced search and filtering
- **Batch Import**: Support for Excel/CSV with intelligent deduplication and validation
- **AI Field Mapping**: Automatically identify field correspondences, reducing manual configuration
- **KPI Integration**: Real-time display of supplier performance summary

### 📈 KPI & Dashboard
- **Receiving Quality Rate**: Track supplier delivery quality
- **On-Time Delivery Rate**: Monitor delivery schedule achievement
- **Defect Rate Analysis**: Identify quality issue trends
- **Price Trends**: Visualize price change history
- **Interactive Charts**: Filterable, zoomable dynamic dashboard

### 💰 Material Cost Analysis (New Feature)
- **Cost Structure Analysis**: Automatically calculate material cost proportions
- **Anomaly Detection**: Identify price anomalies and cost fluctuations
- **AI Insight Reports**: Gemini AI generates improvement suggestions
- **Historical Trend Tracking**: Multi-period cost comparison analysis
- 📖 See details: [Material Cost Analysis Quick Guide](MATERIAL_COST_QUICK_START.md)

### 📤 Intelligent Data Import System
- **Three Type Support**: Goods receipt records, price history, supplier master
- **AI Auto Mapping**: Intelligent field identification and suggestions
- **Multi-Sheet Support**: Import multiple Excel sheets at once
- **Frontend Deduplication**: Automatically detect duplicate records before upload
- **Smart Merge**: Provides merge options including update, skip, and add
- **Data Validation**: 15+ validation rules to ensure data quality
- **Import History Tracking**: Complete record of each import operation and results
- 📖 See details: [Complete Data Upload Guide](DATA_UPLOAD_COMPLETE_GUIDE.md)

### 🤖 AI Decision Assistant
- **Contextual Conversations**: Intelligent Q&A based on current data
- **Multi-Conversation Management**: Create, switch, and manage multiple conversation threads
- **History Records**: Save conversation history for future reference
- **Action Recommendations**: Provide specific improvement solutions for cost anomalies

### 🔐 Account & Cloud Sync
- **Supabase Authentication**: Secure Email/Password login
- **Multi-Tenant Isolation**: Each user's data is completely independent
- **Cloud Sync**: Automatic data backup to cloud
- **File Management**: Support for cloud backup and restore

## 🛠️ Tech Stack

### Frontend Framework
- **React 19** - Modern user interface framework
- **Vite 7** - Fast build tool and development server
- **Tailwind CSS 4** - Utility-first CSS framework
- **Lucide Icons** - Beautiful open-source icon library

### Backend Services
- **Supabase** 
  - PostgreSQL database
  - Real-time data synchronization
  - Authentication and authorization
  - Cloud storage
  
### AI Integration
- **Google Gemini Pro + DeepSeek V3.2**
  - Prompt 1-3 (profiling/mapping/readiness): Gemini Pro
  - Prompt 4-5 (report/blocking questions): DeepSeek V3.2
  - Conversational decision assistant (DeepSeek-priority routing)
  - Anomaly detection and recommendations

### Data Processing
- **XLSX** - Excel file parsing and processing
- **Papa Parse** - CSV file parsing
- **Recharts** - Data visualization chart library

## 🚀 Quick Start

### 1. Environment Requirements
- **Node.js** 18+ 
- **npm** or **yarn**
- **Supabase Account** (free tier is sufficient)
- **Google AI Studio Account** (to obtain Gemini API Key)

### 2. Installation Steps

```bash
# Clone the project
git clone https://github.com/your-username/smartops-app.git
cd smartops-app

# Install dependencies
npm install

# Start development server
npm run dev
```

Default opens at http://localhost:5173

### 3. Database Setup

Execute the following SQL scripts to create the database structure:

```bash
# Quick setup (includes basic tables and sample data)
Execute QUICK_SETUP.sql

# Or complete setup (includes all tables, views, triggers)
Execute database/supplier_kpi_schema.sql
Execute database/import_batches_schema.sql
Execute database/upload_mappings_schema.sql
Execute database/cost_analysis_schema.sql
```

📖 For detailed instructions, refer to: [Database Schema Guide](DATABASE_SCHEMA_GUIDE.md)

### 4. Environment Variables Configuration

**Supabase Setup**:
- Configure your Supabase URL and Anon Key in `src/services/supabaseClient.js`
- For production environment, it's recommended to use `.env.local`:
  ```
  VITE_SUPABASE_URL=your-supabase-url
  VITE_SUPABASE_ANON_KEY=your-anon-key
  ```

**Gemini API Key**:
- Method 1: Enter in the application's "Settings" interface (stored in localStorage)
- Method 2: Set environment variable `VITE_GEMINI_API_KEY`
- Get API key: https://ai.google.dev/

### 5. First Login
- Create a user in Supabase dashboard's Authentication
- Or use the registration function on the login page
- After login, you can start using all features

## ⚙️ Environment Configuration

### Network Permissions
- Gemini AI requires internet connection
- Supabase needs to configure allowed domains (CORS)
- It's recommended to set domain whitelist in Supabase dashboard

### API Quota Management
- Gemini API free tier: 15 requests/min
- It's recommended to upgrade to paid plan for higher quota
- The application has built-in error handling and retry mechanisms
- 📖 See details: [Gemini API Quota Issue](GEMINI_API_QUOTA_ISSUE.md)

## 🗄️ Database Schema

### Core Tables
- **suppliers** - Supplier master
- **materials** - Material master
- **goods_receipts** - Goods receipt records
- **price_history** - Price history
- **import_batches** - Import batch records
- **upload_mappings** - Field mapping templates
- **material_cost_analysis** - Material cost analysis

### KPI Views
- **supplier_kpi_summary** - Supplier KPI summary
- **supplier_performance_stats** - Performance statistics
- **material_price_trends** - Price trends
- **cost_analysis_results** - Cost analysis results

### Database Management
- **Multi-Tenant Design**: All data is isolated by `user_id`
- **Automatic Timestamps**: created_at / updated_at automatically maintained
- **Index Optimization**: Composite indexes created for common queries
- **Data Cleanup Scripts**: [Reset All Data](HOW_TO_RESET_DATA.md)

📖 Complete documentation: [Database Schema Guide](DATABASE_SCHEMA_GUIDE.md)

## 📋 Data Import Field Requirements

### Goods Receipt
**Required Fields**:
- `supplier_name` - Supplier name
- `material_code` - Material code
- `actual_delivery_date` - Actual delivery date
- `received_qty` - Received quantity

**Optional Fields**:
- `supplier_code`, `material_name`, `po_number`, `receipt_number`
- `planned_delivery_date`, `receipt_date`, `rejected_qty`
- `category`, `uom` (unit of measure)

### Price History
**Required Fields**:
- `supplier_name` - Supplier name
- `material_code` - Material code
- `order_date` - Order date
- `unit_price` - Unit price

**Optional Fields**:
- `supplier_code`, `material_name`, `currency`
- `quantity`, `is_contract_price`

### Supplier Master
**Required Fields**:
- `supplier_name` - Supplier name

**Optional Fields**:
- `supplier_code` - Supplier code
- `contact_person` - Contact person
- `phone`, `email`, `address`
- `product_category` - Product category
- `payment_terms` - Payment terms
- `delivery_time` - Delivery time
- `status` - Status

### File Limitations
- Supported formats: Excel (.xlsx, .xls) or CSV
- File size: ≤ 10MB
- Encoding: UTF-8 (for CSV files)
- Multi-sheet: Support importing multiple sheets at once

📖 Detailed guides:
- [Complete Data Upload Guide](DATA_UPLOAD_COMPLETE_GUIDE.md)
- [Data Validation Guide](DATA_VALIDATION_GUIDE.md)
- [AI Mapping Guide](AI_MAPPING_GUIDE.md)

## 📁 Project Structure

```
smartops-app/
├── src/
│   ├── App.jsx                          # Main application, routing and layout
│   ├── main.jsx                         # Application entry point
│   │
│   ├── views/                           # Main view components
│   │   ├── SupplierManagementView.jsx   # Supplier management interface
│   │   ├── CostAnalysisView.jsx         # Cost analysis interface
│   │   ├── EnhancedExternalSystemsView.jsx # Data import interface
│   │   └── ImportHistoryView.jsx        # Import history interface
│   │
│   ├── services/                        # Service layer
│   │   ├── supabaseClient.js            # Supabase connection settings
│   │   ├── geminiAPI.js                 # Gemini AI integration
│   │   ├── supplierKpiService.js        # Supplier KPI service
│   │   ├── materialCostService.js       # Material cost service
│   │   └── importHistoryService.js      # Import history service
│   │
│   ├── utils/                           # Utility functions
│   │   ├── dataValidation.js            # Data validation rules
│   │   ├── dataProcessing.js            # Data processing and transformation
│   │   ├── dataCleaningUtils.js         # Data cleaning utilities
│   │   ├── aiMappingHelper.js           # AI mapping helper
│   │   └── uploadSchemas.js             # Upload schema definitions
│   │
│   └── components/                      # Reusable components
│       ├── ui/                          # UI base components
│       │   ├── Button.jsx
│       │   ├── Card.jsx
│       │   ├── Modal.jsx
│       │   └── Badge.jsx
│       └── charts/                      # Chart components
│           ├── SimpleBarChart.jsx
│           └── SimpleLineChart.jsx
│
├── database/                            # Database scripts
│   ├── supplier_kpi_schema.sql          # KPI tables and views
│   ├── import_batches_schema.sql        # Import batch schema
│   ├── upload_mappings_schema.sql       # Mapping template schema
│   ├── cost_analysis_schema.sql         # Cost analysis schema
│   ├── bom_forecast_schema.sql          # BOM & Forecast schema
│   └── reset_all_data.sql               # Data reset script
│
├── templates/                           # Upload templates
│   ├── bom_edge.xlsx / .csv             # BOM structure template
│   └── demand_fg.xlsx / .csv            # FG demand template
│
└── docs/                                # Documentation
    ├── BOM_EXPLOSION.md                 # BOM explosion feature doc
    ├── BOM_EXPLOSION_SPEC.md            # BOM technical spec
    ├── BOM_EXPLOSION_TEST_GUIDE.md      # BOM testing guide
    ├── SETUP.md                         # Environment setup guide
    ├── GLOSSARY.md                      # Terminology glossary
    ├── guides/                          # User guides
    │   ├── DATA_UPLOAD_COMPLETE_GUIDE.md
    │   ├── AI_MAPPING_GUIDE.md
    │   ├── SUPPLIER_VALIDATION_GUIDE.md
    │   ├── COST_ANALYSIS_GUIDE.md
    │   └── ... (9 guides total)
    └── archive/                         # Historical documents
        └── ... (development history)
```

## 💻 Common Commands

### Development
```bash
npm run dev          # Start development server (hot reload)
npm run lint         # Run ESLint check
```

### Build & Deploy
```bash
npm run build        # Build production version
npm run preview      # Preview production build
```

### Database Management
```bash
# Execute in Supabase SQL Editor:
# 1. Initial setup: QUICK_SETUP.sql
# 2. Clean data: database/reset_all_data.sql
# 3. Remove duplicates: database/cleanup_duplicate_suppliers.sql
```

## 📚 完整文件

### 核心技術文件
- **[docs/SETUP.md](docs/SETUP.md)** - 環境設定指南 (從零開始)
- **[docs/BOM_EXPLOSION.md](docs/BOM_EXPLOSION.md)** - BOM 展開功能文件
- **[docs/GLOSSARY.md](docs/GLOSSARY.md)** - 術語表 (統一專案用語)
- **[DATABASE_SCHEMA_GUIDE.md](DATABASE_SCHEMA_GUIDE.md)** - 資料庫結構說明
- **[ARCHITECTURE_DESIGN.md](ARCHITECTURE_DESIGN.md)** - 系統架構設計

### 使用者指南 (docs/guides/)
- **[資料上傳完整指南](docs/guides/DATA_UPLOAD_COMPLETE_GUIDE.md)** ⭐
- **[AI 自動映射指南](docs/guides/AI_MAPPING_GUIDE.md)** ⭐
- **[供應商驗證指南](docs/guides/SUPPLIER_VALIDATION_GUIDE.md)** ⭐
- **[成本分析指南](docs/guides/COST_ANALYSIS_GUIDE.md)** ⭐
- **[匯入歷史指南](docs/guides/IMPORT_HISTORY_GUIDE.md)** ⭐
- [物料成本快速入門](docs/guides/MATERIAL_COST_QUICK_START.md)
- [映射模板指南](docs/guides/MAPPING_TEMPLATE_GUIDE.md)
- [資料驗證指南](docs/guides/DATA_VALIDATION_GUIDE.md)
- [上傳工作流程](docs/guides/UPLOAD_WORKFLOW_GUIDE.md)

### 開發與歷史文件
- **[docs/archive/](docs/archive/)** - 開發歷程、已解決問題記錄

## ⚠️ Important Notes

### Security
- ⚠️ **Please replace demo API keys**
- It's recommended to move all sensitive information to environment variables
- Set Supabase CORS whitelist for production environment
- Regularly update dependencies to patch security vulnerabilities

### Data Management
- Ensure database tables are created before importing
- Large data imports should be processed in batches
- Regularly backup important data
- Use [data reset script](HOW_TO_RESET_DATA.md) to clean test data

### API Quota
- Gemini API free tier has request limits
- It's recommended to implement caching mechanisms to reduce API calls
- Monitor API usage to avoid exceeding limits
- Consider upgrading to paid plan

### Performance Optimization
- Large Excel files should be compressed or split first
- Use indexes to speed up database queries
- Frontend pagination and virtual scrolling for handling large datasets
- Properly use React.memo to avoid unnecessary re-renders

## 🤝 Contributing

Welcome to submit Issues or Pull Requests!

## 📄 License

This project is licensed under the MIT License.

---

**Decision Intelligence** - Making supply chain management smarter and more efficient 🚀
