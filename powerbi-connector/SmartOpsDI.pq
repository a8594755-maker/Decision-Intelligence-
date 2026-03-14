// ─────────────────────────────────────────────────────────────────────────────
// SmartOps Decision Intelligence — Power Query M Connector
//
// Power BI Data Source connecting to the report-api Edge Function.
// Import this file in Power BI Desktop → Get Data → Blank Query → Advanced Editor
// ─────────────────────────────────────────────────────────────────────────────

// ── Configuration ───────────────────────────────────────────────────────────
// Set these parameters in Power BI:
//   1. Go to Home → Manage Parameters
//   2. Create parameters: SupabaseUrl, SupabaseAccessToken

let
    // -- Connection Parameters --
    BaseUrl = #"SupabaseUrl" & "/functions/v1/report-api",
    Token = #"SupabaseAccessToken",

    // -- Helper: Call report-api --
    CallApi = (action as text, optional params as record) as any =>
        let
            Body = Record.Combine({[action = action], if params <> null then params else []),
            Response = Web.Contents(BaseUrl, [
                Headers = [
                    #"Content-Type" = "application/json",
                    #"Authorization" = "Bearer " & Token
                ],
                Content = Json.FromValue(Body),
                ManualStatusHandling = {400, 401, 403, 500}
            ]),
            JsonResponse = Json.Document(Response)
        in
            JsonResponse,

    // ── Data Source Functions ────────────────────────────────────────────────

    // 1. Report List
    GetReports = () =>
        let
            data = CallApi("list_reports", [limit = 50]),
            reports = data[reports],
            AsTable = Table.FromRecords(reports),
            Typed = Table.TransformColumnTypes(AsTable, {
                {"id", type text},
                {"title", type text},
                {"status", type text},
                {"created_at", type datetimezone},
                {"step_count", Int64.Type}
            })
        in
            Typed,

    // 2. Full Report (by task_id)
    GetReport = (taskId as text) =>
        let
            data = CallApi("get_report", [task_id = taskId])
        in
            data,

    // 3. Monthly Aggregate
    GetMonthly = (year as number, month as number) =>
        let
            data = CallApi("get_monthly", [year = year, month = month]),
            summary = Record.ToTable(Record.RemoveFields(data, {"tasks", "cost_breakdown"}, MissingField.Ignore)),
            tasks = if Record.HasFields(data, "tasks") then
                        Table.FromRecords(data[tasks])
                    else
                        #table({}, {})
        in
            [Summary = summary, Tasks = tasks],

    // 4. KPIs
    GetKPIs = () =>
        let
            data = CallApi("get_kpis"),
            kpis = data[kpis],
            AsTable = Record.ToTable(kpis),
            Renamed = Table.RenameColumns(AsTable, {{"Name", "KPI"}, {"Value", "Value"}})
        in
            Renamed,

    // 5. Forecast Data
    GetForecast = (optional taskId as text) =>
        let
            params = if taskId <> null then [task_id = taskId] else [],
            data = CallApi("get_forecast", params),
            series = data[forecast_series],
            AsTable = Table.FromRecords(series),
            Typed = Table.TransformColumnTypes(AsTable, {
                {"date", type date},
                {"value", type number}
            })
        in
            Typed,

    // 6. Plan Data
    GetPlan = (optional taskId as text) =>
        let
            params = if taskId <> null then [task_id = taskId] else [],
            data = CallApi("get_plan", params),
            planTable = data[plan_table],
            AsTable = Table.FromRecords(planTable)
        in
            AsTable,

    // 7. Risk Scores
    GetRisk = (optional taskId as text) =>
        let
            params = if taskId <> null then [task_id = taskId] else [],
            data = CallApi("get_risk", params),
            risks = data[risk_scores],
            AsTable = Table.FromRecords(risks),
            Typed = Table.TransformColumnTypes(AsTable, {
                {"risk_score", type number}
            })
        in
            AsTable,

    // 8. Review Results
    GetReviews = (optional taskId as text) =>
        let
            params = if taskId <> null then [task_id = taskId] else [],
            data = CallApi("get_review", params),
            reviews = data[reviews],
            AsTable = Table.FromRecords(reviews),
            Typed = Table.TransformColumnTypes(AsTable, {
                {"score", Int64.Type},
                {"passed", type logical},
                {"revision_round", Int64.Type}
            })
        in
            Typed,

    // ── Navigation Table ────────────────────────────────────────────────────

    NavTable = #table(
        {"Name", "Data", "ItemKind", "ItemName", "IsLeaf"},
        {
            {"Reports",      GetReports(),          "Table", "Table", true},
            {"KPIs",         GetKPIs(),              "Table", "Table", true},
            {"Forecast",     GetForecast(),          "Table", "Table", true},
            {"Plan",         GetPlan(),              "Table", "Table", true},
            {"Risk Scores",  GetRisk(),              "Table", "Table", true},
            {"Reviews",      GetReviews(),           "Table", "Table", true}
        }
    ),

    AsNavTable = Table.ToNavigationTable(NavTable, {"Name"}, "Name", "Data", "ItemKind", "ItemName", "IsLeaf")
in
    AsNavTable
