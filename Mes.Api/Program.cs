using System.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Data.SqlClient;
using System.Net.Http.Json;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseWindowsService(options => options.ServiceName = "MES API Service");

builder.Services.AddCors(options =>
{
    options.AddPolicy("MesCors", policy =>
    {
        var origins = builder.Configuration.GetSection("Mes:CorsOrigins").Get<string[]>() ?? [];
        policy.SetIsOriginAllowed(origin =>
        {
            if (origins.Contains(origin, StringComparer.OrdinalIgnoreCase)) return true;
            return Uri.TryCreate(origin, UriKind.Absolute, out var uri)
                && uri.Scheme is "http" or "https"
                && uri.Port is 4001 or 4101;
        }).AllowAnyHeader().AllowAnyMethod();
    });
});
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddSingleton<MesDatabase>();
builder.Services.AddHttpClient();
builder.Services.AddHostedService<RgvRunTracker>();

var app = builder.Build();

app.UseCors("MesCors");
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseSwagger();
app.UseSwaggerUI();


var db = app.Services.GetRequiredService<MesDatabase>();
await db.InitializeAsync();

app.MapGet("/api/health", async (MesDatabase database) =>
{
    var info = await database.QuerySingleAsync<SystemInfo>(
        "SELECT @@SERVICENAME AS ServiceName, DB_NAME() AS DatabaseName, SYSDATETIME() AS ServerTime");
    return Results.Ok(new { status = "ok", info });
});

app.MapPost("/api/auth/admin", (LoginRequest request, IConfiguration config) =>
{
    var user = config["Mes:AdminUser"] ?? "ZXC";
    var password = config["Mes:AdminPassword"] ?? "1826";
    if (string.Equals(request.Username, user, StringComparison.OrdinalIgnoreCase) && request.Password == password)
    {
        return Results.Ok(Session.Admin());
    }

    return Results.Unauthorized();
});

app.MapPost("/api/auth/employee", async Task<Results<Ok<Session>, UnauthorizedHttpResult>> (EmployeeLoginRequest request, MesDatabase database) =>
{
    var employee = await database.QuerySingleOrDefaultAsync<EmployeeSession>(
        """
        SELECT TOP 1 e.EmployeeNo, e.Name, e.RoleCode, r.Name AS RoleName
        FROM MesEmployees e
        JOIN MesRoles r ON r.Code = e.RoleCode
        WHERE e.EmployeeNo = @EmployeeNo AND e.IsActive = 1
        """,
        new Dictionary<string, object?> { ["EmployeeNo"] = request.EmployeeNo.Trim() });

    return employee is null ? TypedResults.Unauthorized() : TypedResults.Ok(Session.Employee(employee));
});

app.MapGet("/api/navigation", async (string? role, MesDatabase database) =>
{
    var roleCode = string.IsNullOrWhiteSpace(role) ? "operator" : role;
    var permissions = await database.QueryAsync<PermissionRow>(
        """
        SELECT ModuleKey, CanRead, CanWrite
        FROM MesRolePermissions
        WHERE RoleCode = @RoleCode
        """,
        new Dictionary<string, object?> { ["RoleCode"] = roleCode });

    var allowed = permissions.Where(p => p.CanRead).Select(p => p.ModuleKey).ToHashSet(StringComparer.OrdinalIgnoreCase);
    return Results.Ok(ModuleCatalog.All.Where(m => roleCode == "admin" || allowed.Contains(m.Key)));
});

app.MapGet("/api/overview", async (MesDatabase database) =>
{
    var metrics = new
    {
        products = await database.ScalarAsync<int>("SELECT COUNT(*) FROM MesProducts"),
        workOrders = await database.ScalarAsync<int>("SELECT COUNT(*) FROM MesWorkOrders WHERE Status IN (N'待执行', N'执行中')"),
        runningTasks = await database.ScalarAsync<int>("SELECT ISNULL(SUM(CompletedQty), 0) FROM MesWorkOrders WHERE Status = N'执行中'"),
        runningPlanQty = await database.ScalarAsync<int>("SELECT ISNULL(SUM(PlanQty), 0) FROM MesWorkOrders WHERE Status = N'执行中'"),
        alarms = await database.ScalarAsync<int>("SELECT COUNT(*) FROM MesAlarms WHERE Status <> N'已关闭'")
    };
    var stations = await database.QueryAsync<StationStatus>(
        """
        SELECT *
        FROM MesStations
        WHERE Code LIKE N'OP[0-9]%' AND TRY_CONVERT(int, SUBSTRING(Code, 3, 10)) BETWEEN 1 AND 18
        ORDER BY
            CASE
                WHEN Code LIKE N'OP%' AND TRY_CONVERT(int, SUBSTRING(Code, 3, 20)) IS NOT NULL
                    THEN 0
                ELSE 1
            END,
            CASE
                WHEN Code LIKE N'OP%' AND TRY_CONVERT(int, SUBSTRING(Code, 3, 20)) IS NOT NULL
                    THEN TRY_CONVERT(int, SUBSTRING(Code, 3, 20))
                ELSE NULL
            END,
            Code
        """);
    var workOrders = await database.QueryAsync<WorkOrderRow>("SELECT TOP 8 wo.Id, wo.WorkOrderNo, wo.ProductName, wo.PlanQty, CASE WHEN wo.Status=N'完工归档' THEN wo.CompletedQty ELSE (SELECT COUNT(*) FROM MesRgvRunRecords r WHERE r.WorkOrderNo=wo.WorkOrderNo AND r.ToPosition=4 AND r.EndTime IS NOT NULL AND r.MissionStateEnd=0 AND r.EndTime>=DATEADD(QUARTER,-1,SYSDATETIME())) END AS CompletedQty, wo.Priority, wo.Status, wo.DueDate, wo.ArchivedAt FROM MesWorkOrders wo ORDER BY wo.Id DESC");
    var alarms = await database.QueryAsync<AlarmRow>("SELECT TOP 8 * FROM MesAlarms ORDER BY Id DESC");
    return Results.Ok(new { metrics, stations, workOrders, alarms });
});

app.MapGet("/api/products", async (MesDatabase database) =>
    Results.Ok(await database.QueryAsync<ProductRow>("SELECT * FROM MesProducts ORDER BY Id DESC")));

app.MapPost("/api/products", async (ProductWrite request, MesDatabase database) =>
{
    const string sql =
        """
        IF COL_LENGTH('MesProducts', 'StandardHours') IS NOT NULL
           AND COL_LENGTH('MesProducts', 'Status') IS NOT NULL
        BEGIN
            EXEC sp_executesql
                N'INSERT INTO MesProducts (Name, Barcode, Category, ProcessRoute, StandardHours, Status)
                  OUTPUT INSERTED.Id
                  VALUES (@Name, @Barcode, @Category, @ProcessRoute, 0, N''启用'')',
                N'@Name nvarchar(120), @Barcode nvarchar(80), @Category nvarchar(80), @ProcessRoute nvarchar(120)',
                @Name=@Name, @Barcode=@Barcode, @Category=@Category, @ProcessRoute=@ProcessRoute
        END
        ELSE
        BEGIN
            INSERT INTO MesProducts (Name, Barcode, Category, ProcessRoute)
            OUTPUT INSERTED.Id
            VALUES (@Name, @Barcode, @Category, @ProcessRoute)
        END
        """;
    var id = await database.ScalarAsync<int>(sql, request.ToParameters());
    return Results.Ok(new { id });
});

app.MapPut("/api/products/{id:int}", async (int id, ProductWrite request, MesDatabase database) =>
{
    var parameters = request.ToParameters();
    parameters["Id"] = id;
    await database.ExecuteAsync(
        """
        UPDATE MesProducts
        SET Name=@Name, Barcode=@Barcode, Category=@Category, ProcessRoute=@ProcessRoute
        WHERE Id=@Id
        """,
        parameters);
    return Results.NoContent();
});

app.MapDelete("/api/products/{id:int}", async (int id, MesDatabase database) =>
{
    var productName = await database.ScalarAsync<string?>("SELECT Name FROM MesProducts WHERE Id=@Id", new Dictionary<string, object?> { ["Id"] = id });
    if (productName is null) return Results.NotFound();

    await database.ExecuteAsync("DELETE FROM MesAcceptanceSpecs WHERE ProductName=@ProductName", new Dictionary<string, object?> { ["ProductName"] = productName });
    await database.ExecuteAsync("DELETE FROM MesProducts WHERE Id=@Id", new Dictionary<string, object?> { ["Id"] = id });
    return Results.NoContent();
});

app.MapGet("/api/process/routes", async (MesDatabase database) =>
    Results.Ok(await database.QueryAsync<ProcessRouteRow>("SELECT * FROM MesProcessRoutes ORDER BY Id DESC")));

app.MapPost("/api/process/routes", async (ProcessRouteWrite request, MesDatabase database) =>
{
    var id = await database.ScalarAsync<int>(
        """
        INSERT INTO MesProcessRoutes (Name, ProductName, Steps, Version, Status)
        OUTPUT INSERTED.Id
        VALUES (@Name, @ProductName, @Steps, @Version, @Status)
        """,
        request.ToParameters());
    return Results.Ok(new { id });
});

app.MapPut("/api/process/routes/{id:int}", async (int id, ProcessRouteWrite request, MesDatabase database) =>
{
    var parameters = request.ToParameters();
    parameters["Id"] = id;
    await database.ExecuteAsync(
        """
        UPDATE MesProcessRoutes
        SET Name=@Name, ProductName=@ProductName, Steps=@Steps, Version=@Version, Status=@Status
        WHERE Id=@Id
        """,
        parameters);
    return Results.NoContent();
});

app.MapDelete("/api/process/routes/{id:int}", async (int id, MesDatabase database) =>
{
    var parameters = new Dictionary<string, object?> { ["Id"] = id };
    await database.ExecuteAsync("DELETE FROM MesProcessStationBindings WHERE RouteId=@Id", parameters);
    await database.ExecuteAsync("DELETE FROM MesProcessRoutes WHERE Id=@Id", parameters);
    return Results.NoContent();
});

app.MapGet("/api/process/stations", async (MesDatabase database) =>
    Results.Ok(await database.QueryAsync<StationStatus>(
        """
        SELECT * FROM MesStations
        WHERE Code LIKE N'OP[0-9]%' AND TRY_CONVERT(int, SUBSTRING(Code, 3, 10)) BETWEEN 1 AND 18
        ORDER BY CASE WHEN Code LIKE N'OP[0-9]%' THEN TRY_CONVERT(int, SUBSTRING(Code, 3, 10)) ELSE 9999 END, Code
        """)));

app.MapGet("/api/process/routes/{routeId:int}/bindings", async (int routeId, MesDatabase database) =>
    Results.Ok(await database.QueryAsync<ProcessStationBindingRow>(
        """
        SELECT Id, RouteId, StationCode, OperationName, SequenceNo, IsRequired
        FROM MesProcessStationBindings
        WHERE RouteId = @RouteId
        ORDER BY SequenceNo, StationCode
        """,
        new Dictionary<string, object?> { ["RouteId"] = routeId })));

app.MapPost("/api/process/routes/{routeId:int}/bindings", async (int routeId, ProcessBindingSave request, MesDatabase database) =>
{
    await database.ExecuteAsync("DELETE FROM MesProcessStationBindings WHERE RouteId=@RouteId", new Dictionary<string, object?> { ["RouteId"] = routeId });
    foreach (var binding in request.Bindings.Where(b => !string.IsNullOrWhiteSpace(b.OperationName)))
    {
        await database.ExecuteAsync(
            """
            INSERT INTO MesProcessStationBindings (RouteId, StationCode, OperationName, SequenceNo, IsRequired)
            VALUES (@RouteId, @StationCode, @OperationName, @SequenceNo, @IsRequired)
            """,
            new Dictionary<string, object?>
            {
                ["RouteId"] = routeId,
                ["StationCode"] = binding.StationCode,
                ["OperationName"] = binding.OperationName.Trim(),
                ["SequenceNo"] = binding.SequenceNo,
                ["IsRequired"] = binding.IsRequired
            });
    }

    return Results.Ok(new { status = "saved" });
});

app.MapGet("/api/process/routes/{routeId:int}/sops", async (int routeId, MesDatabase database) =>
    Results.Ok(await database.QueryAsync<SopFileRow>(
        """
        SELECT Id, RouteId, SequenceNo, Title, ProductName, StationCode, FileType, FilePath, Version
        FROM MesSopFiles
        WHERE RouteId = @RouteId
        ORDER BY SequenceNo, Id DESC
        """,
        new Dictionary<string, object?> { ["RouteId"] = routeId })));

app.MapPost("/api/process/routes/{routeId:int}/sops", async (int routeId, SopFileWrite request, MesDatabase database) =>
{
    var parameters = request.ToParameters();
    parameters["RouteId"] = routeId;
    var existing = await database.QuerySingleOrDefaultAsync<SopIdRow>(
        """
        SELECT TOP 1 Id
        FROM MesSopFiles
        WHERE RouteId=@RouteId AND SequenceNo=@SequenceNo
        ORDER BY Id DESC
        """,
        parameters);

    if (existing is null)
    {
        await database.ExecuteAsync(
            """
            INSERT INTO MesSopFiles (RouteId, SequenceNo, Title, ProductName, StationCode, FileType, FilePath, Version)
            VALUES (@RouteId, @SequenceNo, @Title, @ProductName, @StationCode, @FileType, @FilePath, @Version)
            """,
            parameters);
    }
    else
    {
        parameters["Id"] = existing.Id;
        await database.ExecuteAsync(
            """
            UPDATE MesSopFiles
            SET Title=@Title, ProductName=@ProductName, StationCode=@StationCode, FileType=@FileType, FilePath=@FilePath, Version=@Version
            WHERE Id=@Id
            """,
            parameters);
    }

    return Results.Ok(new { status = "saved" });
});

app.MapGet("/api/production/work-orders", async (MesDatabase database) =>
    Results.Ok(await database.QueryAsync<WorkOrderRow>("SELECT wo.Id, wo.WorkOrderNo, wo.ProductName, wo.PlanQty, CASE WHEN wo.Status=N'完工归档' THEN wo.CompletedQty ELSE (SELECT COUNT(*) FROM MesRgvRunRecords r WHERE r.WorkOrderNo=wo.WorkOrderNo AND r.ToPosition=4 AND r.EndTime IS NOT NULL AND r.MissionStateEnd=0 AND r.EndTime>=DATEADD(QUARTER,-1,SYSDATETIME())) END AS CompletedQty, wo.Priority, wo.Status, wo.DueDate, wo.ArchivedAt FROM MesWorkOrders wo ORDER BY wo.Id DESC")));

app.MapPost("/api/production/work-orders/{id:int}/label-prints", async (int id, LabelPrintRequest request, MesDatabase database) =>
{
    var workOrder = await database.QuerySingleOrDefaultAsync<WorkOrderRow>(
        "SELECT * FROM MesWorkOrders WHERE Id=@Id",
        new Dictionary<string, object?> { ["Id"] = id });
    if (workOrder is null) return Results.NotFound();
    if (request.StartCode < 1 || request.EndCode < request.StartCode || request.EndCode > workOrder.PlanQty)
    {
        return Results.BadRequest($"起始码必须不小于 1，结束码必须不小于起始码且不超过计划数量 {workOrder.PlanQty}。");
    }

    var parameters = new Dictionary<string, object?>
    {
        ["WorkOrderNo"] = workOrder.WorkOrderNo,
        ["ProductName"] = workOrder.ProductName,
        ["StartCode"] = request.StartCode,
        ["EndCode"] = request.EndCode,
    };
    var existingCount = await database.ScalarAsync<int>(
        "SELECT COUNT(*) FROM LabelPrint WHERE WorkOrderNo=@WorkOrderNo AND LabelCode BETWEEN @StartCode AND @EndCode",
        parameters);
    if (existingCount > 0) return Results.BadRequest("所选范围中已有已打印的流通码，请重新选择未使用的范围。");

    await database.InsertLabelPrintsAsync(workOrder.WorkOrderNo, workOrder.ProductName, request.StartCode, request.EndCode);
    return Results.Ok(new { count = request.EndCode - request.StartCode + 1 });
});

app.MapPost("/api/label-prints/parse", (LabelQrCodeParseRequest request) =>
{
    return LabelQrCode.TryParse(request.QrCode, out var label)
        ? Results.Ok(label)
        : Results.BadRequest("无法识别二维码内容。");
});

app.MapPost("/api/production/work-orders", async (WorkOrderWrite request, MesDatabase database) =>
{
    var workOrderNo = string.IsNullOrWhiteSpace(request.WorkOrderNo)
        ? $"WO-{DateTime.Now:yyyyMMdd-HHmmss}"
        : request.WorkOrderNo.Trim();

    var parameters = request.ToParameters();
    parameters["WorkOrderNo"] = workOrderNo;

    var id = await database.ScalarAsync<int>(
        """
        INSERT INTO MesWorkOrders (WorkOrderNo, ProductName, PlanQty, CompletedQty, Priority, Status, DueDate)
        OUTPUT INSERTED.Id
        VALUES (@WorkOrderNo, @ProductName, @PlanQty, 0, @Priority, N'待执行', @DueDate)
        """,
        parameters);

    var product = await database.QuerySingleOrDefaultAsync<ProductRow>(
        "SELECT TOP 1 * FROM MesProducts WHERE Name=@Name",
        new Dictionary<string, object?> { ["Name"] = request.ProductName });

    var route = product is null || string.IsNullOrWhiteSpace(product.ProcessRoute)
        ? null
        : await database.QuerySingleOrDefaultAsync<ProcessRouteRow>(
            "SELECT TOP 1 * FROM MesProcessRoutes WHERE Name=@Name ORDER BY Id DESC",
            new Dictionary<string, object?> { ["Name"] = product.ProcessRoute.Trim() });

    var bindings = route is null
        ? []
        : await database.QueryAsync<ProcessStationBindingRow>(
            """
            SELECT Id, RouteId, StationCode, OperationName, SequenceNo, IsRequired
            FROM MesProcessStationBindings
            WHERE RouteId=@RouteId
            ORDER BY SequenceNo, StationCode
            """,
            new Dictionary<string, object?> { ["RouteId"] = route.Id });
    var tasks = bindings.Count > 0
        ? bindings
            .Where(b => b.SequenceNo < 98)
            .Select(b => (b.StationCode, b.OperationName))
            .ToArray()
        : [("OP1", "扫码上线"), ("OP2", "装配"), ("OP3", "功能测试"), ("OP4", "终检")];

    foreach (var task in tasks)
    {
        await database.ExecuteAsync(
            """
            INSERT INTO MesTasks (WorkOrderNo, StationCode, OperationName, Assignee, Status)
            VALUES (@WorkOrderNo, @StationCode, @OperationName, NULL, N'待执行')
            """,
            new Dictionary<string, object?>
            {
                ["WorkOrderNo"] = workOrderNo,
                ["StationCode"] = task.StationCode,
                ["OperationName"] = task.OperationName
            });
    }

    return Results.Ok(new { id, workOrderNo });
});

app.MapPut("/api/production/work-orders/{id:int}/status", async (int id, WorkOrderStatusWrite request, MesDatabase database) =>
{
    var nextStatus = request.Status.Trim();
    if (nextStatus is not ("待执行" or "执行中" or "完工归档"))
    {
        return Results.BadRequest("不支持的工单状态。");
    }

    var exists = await database.ScalarAsync<int>(
        "SELECT COUNT(*) FROM MesWorkOrders WHERE Id=@Id",
        new Dictionary<string, object?> { ["Id"] = id });
    if (exists == 0) return Results.NotFound();

    // A work order is the single execution slot. Starting one releases any other running order.
    await database.ExecuteAsync(
        "UPDATE MesWorkOrders SET Status=CASE WHEN Id=@Id THEN @Status ELSE N'待执行' END WHERE Status=N'执行中' OR Id=@Id",
        new Dictionary<string, object?> { ["Id"] = id, ["Status"] = nextStatus });
    return Results.NoContent();
});

app.MapGet("/api/sop-documents/{routeId:int}/{sequenceNo:int}", async (int routeId, int sequenceNo, MesDatabase database) =>
{
    var sop = await database.QuerySingleOrDefaultAsync<SopFileRow>(
        "SELECT TOP 1 * FROM MesSopFiles WHERE RouteId=@RouteId AND SequenceNo=@SequenceNo ORDER BY Id DESC",
        new Dictionary<string, object?> { ["RouteId"] = routeId, ["SequenceNo"] = sequenceNo });
    if (sop is null || !string.Equals(sop.FileType, "PDF", StringComparison.OrdinalIgnoreCase)) return Results.NotFound();

    var sopDirectory = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "SOP"));
    if (!Directory.Exists(sopDirectory)) return Results.NotFound();

    var fileName = Path.GetFileName(sop.FilePath);
    var filePath = Path.Combine(sopDirectory, fileName);
    return File.Exists(filePath) ? Results.File(filePath, "application/pdf", enableRangeProcessing: true) : Results.NotFound();
});

app.MapGet("/api/workstations/{stationCode}/active-work-order", async (string stationCode, MesDatabase database) =>
{
    var context = await database.QuerySingleOrDefaultAsync<WorkstationWorkOrderRow>(
        """
        SELECT TOP 1 wo.WorkOrderNo, wo.ProductName, r.Id AS RouteId, r.Name AS RouteName,
               b.SequenceNo, b.OperationName, b.StationCode
        FROM MesWorkOrders wo
        JOIN MesProducts p ON p.Name=wo.ProductName
        JOIN MesProcessRoutes r ON r.Name=p.ProcessRoute
        JOIN MesProcessStationBindings b ON b.RouteId=r.Id
        WHERE wo.Status=N'执行中' AND b.StationCode=@StationCode AND b.IsRequired=1
        ORDER BY wo.Priority, wo.Id
        """,
        new Dictionary<string, object?> { ["StationCode"] = stationCode.Trim().ToUpperInvariant() });
    return Results.Ok(context);
});

app.MapPost("/api/workstations/{stationCode}/qr-context", async (string stationCode, LabelQrCodeParseRequest request, MesDatabase database) =>
{
    if (!LabelQrCode.TryParse(request.QrCode, out var label))
    {
        return Results.BadRequest("无法识别二维码内容。");
    }

    var context = await database.QuerySingleOrDefaultAsync<WorkstationQrContextRow>(
        """
        SELECT TOP 1 wo.WorkOrderNo, wo.ProductName, r.Id AS RouteId, r.Name AS RouteName,
               b.SequenceNo, b.OperationName, b.StationCode, @LabelCode AS LabelCode
        FROM MesWorkOrders wo
        JOIN MesProducts p ON p.Name=wo.ProductName
        JOIN MesProcessRoutes r ON r.Name=p.ProcessRoute
        JOIN MesProcessStationBindings b ON b.RouteId=r.Id
        WHERE wo.WorkOrderNo=@WorkOrderNo
          AND wo.ProductName=@ProductName
          AND b.StationCode=@StationCode
          AND b.IsRequired=1
        ORDER BY b.SequenceNo
        """,
        new Dictionary<string, object?>
        {
            ["WorkOrderNo"] = label!.WorkOrderNo,
            ["ProductName"] = label.ProductName,
            ["StationCode"] = stationCode.Trim().ToUpperInvariant(),
            ["LabelCode"] = label.LabelCode,
        });

    return context is null
        ? Results.NotFound($"工单 {label.WorkOrderNo} 的工艺路线未配置工位 {stationCode.Trim().ToUpperInvariant()}。")
        : Results.Ok(context);
});

app.MapDelete("/api/production/work-orders/{id:int}", async (int id, MesDatabase database) =>
{
    var workOrderNo = await database.ScalarAsync<string?>(
        "SELECT TOP 1 WorkOrderNo FROM MesWorkOrders WHERE Id=@Id",
        new Dictionary<string, object?> { ["Id"] = id });

    if (!string.IsNullOrWhiteSpace(workOrderNo))
    {
        await database.ExecuteAsync(
            "DELETE FROM MesTasks WHERE WorkOrderNo=@WorkOrderNo",
            new Dictionary<string, object?> { ["WorkOrderNo"] = workOrderNo });
    }

    await database.ExecuteAsync(
        "DELETE FROM MesWorkOrders WHERE Id=@Id",
        new Dictionary<string, object?> { ["Id"] = id });
    return Results.NoContent();
});

app.MapPut("/api/production/work-orders/{id:int}", async (int id, WorkOrderUpdateWrite request, MesDatabase database) =>
{
    var nextStatus = request.Status.Trim() == "完工归档"
        ? "完工归档"
        : request.Status.Trim() == "执行中" ? "执行中" : "待执行";

    if (nextStatus == "执行中")
    {
        await database.ExecuteAsync(
            "UPDATE MesWorkOrders SET Status=N'待执行' WHERE Status=N'执行中' AND Id<>@Id",
            new Dictionary<string, object?> { ["Id"] = id });
    }

    await database.ExecuteAsync(
        """
        UPDATE MesWorkOrders
        SET CompletedQty=@CompletedQty,
            Priority=@Priority,
            DueDate=@DueDate,
            Status=@Status,
            ArchivedAt=CASE WHEN @Status=N'完工归档' THEN SYSDATETIME() ELSE NULL END
        WHERE Id=@Id
        """,
        new Dictionary<string, object?>
        {
            ["Id"] = id,
            ["CompletedQty"] = request.CompletedQty,
            ["Priority"] = request.Priority,
            ["DueDate"] = request.DueDate.Date,
            ["Status"] = nextStatus
        });
    return Results.NoContent();
});

app.MapGet("/api/settings/employees", async (MesDatabase database) =>
    Results.Ok(await database.QueryAsync<EmployeeRow>(
        """
        SELECT e.Id, e.EmployeeNo, e.Name, e.Department, e.RoleCode, r.Name AS RoleName, e.IsActive
        FROM MesEmployees e
        JOIN MesRoles r ON r.Code = e.RoleCode
        ORDER BY e.EmployeeNo
        """)));

app.MapGet("/api/settings/roles", async (MesDatabase database) =>
    Results.Ok(await database.QueryAsync<RoleRow>("SELECT Code, Name, Description FROM MesRoles ORDER BY Code")));

app.MapPost("/api/settings/employees", async (EmployeeWrite request, MesDatabase database) =>
{
    var id = await database.ScalarAsync<int>(
        """
        INSERT INTO MesEmployees (EmployeeNo, Name, Department, RoleCode, IsActive)
        OUTPUT INSERTED.Id
        VALUES (@EmployeeNo, @Name, @Department, @RoleCode, @IsActive)
        """,
        request.ToParameters());
    return Results.Ok(new { id });
});

app.MapPut("/api/settings/employees/{id:int}", async (int id, EmployeeWrite request, MesDatabase database) =>
{
    var parameters = request.ToParameters();
    parameters["Id"] = id;
    await database.ExecuteAsync(
        """
        UPDATE MesEmployees
        SET EmployeeNo=@EmployeeNo, Name=@Name, Department=@Department, RoleCode=@RoleCode, IsActive=@IsActive
        WHERE Id=@Id
        """,
        parameters);
    return Results.NoContent();
});

app.MapDelete("/api/settings/employees/{id:int}", async (int id, MesDatabase database) =>
{
    await database.ExecuteAsync("DELETE FROM MesEmployees WHERE Id=@Id", new Dictionary<string, object?> { ["Id"] = id });
    return Results.NoContent();
});

app.MapGet("/api/personnel/permissions/{employeeId:int}", async (int employeeId, MesDatabase database) =>
    Results.Ok(await database.QueryAsync<EmployeeProcessPermissionRow>(
        """
        SELECT p.Id, p.EmployeeId, e.EmployeeNo, e.Name AS EmployeeName, p.RouteId, r.Name AS RouteName,
               p.SequenceNo, p.OperationName, p.CanView, p.CanOperate, p.CanMaintainSop
        FROM MesEmployeeProcessPermissions p
        JOIN MesEmployees e ON e.Id = p.EmployeeId
        JOIN MesProcessRoutes r ON r.Id = p.RouteId
        WHERE p.EmployeeId = @EmployeeId
        ORDER BY r.Id DESC, p.SequenceNo
        """,
        new Dictionary<string, object?> { ["EmployeeId"] = employeeId })));

app.MapPost("/api/personnel/permissions/{employeeId:int}", async (int employeeId, EmployeeProcessPermissionSave request, MesDatabase database) =>
{
    await database.ExecuteAsync(
        "DELETE FROM MesEmployeeProcessPermissions WHERE EmployeeId=@EmployeeId",
        new Dictionary<string, object?> { ["EmployeeId"] = employeeId });

    foreach (var permission in request.Permissions)
    {
        await database.ExecuteAsync(
            """
            INSERT INTO MesEmployeeProcessPermissions (EmployeeId, RouteId, SequenceNo, OperationName, CanView, CanOperate, CanMaintainSop)
            VALUES (@EmployeeId, @RouteId, @SequenceNo, @OperationName, @CanView, @CanOperate, @CanMaintainSop)
            """,
            new Dictionary<string, object?>
            {
                ["EmployeeId"] = employeeId,
                ["RouteId"] = permission.RouteId,
                ["SequenceNo"] = permission.SequenceNo,
                ["OperationName"] = permission.OperationName.Trim(),
                ["CanView"] = permission.CanView,
                ["CanOperate"] = permission.CanOperate,
                ["CanMaintainSop"] = permission.CanMaintainSop
            });
    }

    return Results.Ok(new { status = "saved" });
});

app.MapGet("/api/modules/{moduleKey}/records", async (string moduleKey, MesDatabase database) =>
{
    var table = ModuleCatalog.TableFor(moduleKey);
    if (table is null)
    {
        return Results.NotFound(new { message = "Unknown module" });
    }

    var query = string.Equals(moduleKey, "production", StringComparison.OrdinalIgnoreCase)
        ? """
            SELECT TOP 50 wo.Id, wo.WorkOrderNo, wo.ProductName, wo.PlanQty,
                   CASE WHEN wo.Status=N'完工归档' THEN wo.CompletedQty
                        ELSE (SELECT COUNT(*) FROM MesRgvRunRecords r
                              WHERE r.WorkOrderNo=wo.WorkOrderNo
                                AND r.ToPosition=4
                                AND r.EndTime IS NOT NULL
                                AND r.MissionStateEnd=0
                                AND r.EndTime>=DATEADD(QUARTER,-1,SYSDATETIME())) END AS CompletedQty,
                   wo.Priority, wo.Status, wo.DueDate, wo.ArchivedAt
            FROM MesWorkOrders wo
            ORDER BY CASE WHEN wo.Status=N'执行中' THEN 0 ELSE 1 END, wo.Priority ASC, wo.Id ASC
            """
        : $"SELECT TOP 50 * FROM {table} ORDER BY Id DESC";

    return Results.Ok(await database.QueryDictionaryAsync(query));
});

app.MapPost("/api/production/report-work", async (ReportWorkRequest request, MesDatabase database) =>
{
    if (request.TaskId <= 0 || request.GoodQty < 0 || request.BadQty < 0 || request.GoodQty + request.BadQty <= 0)
    {
        return Results.BadRequest("报工数量或任务编号无效。");
    }

    if (string.IsNullOrWhiteSpace(request.ProductBarcode) || string.IsNullOrWhiteSpace(request.StationCode) || string.IsNullOrWhiteSpace(request.OperatorNo))
    {
        return Results.BadRequest("产品条码、工位和操作员工号不能为空。");
    }

    var result = await database.ReportWorkAsync(request);
    return result.StatusCode == 200
        ? Results.Ok(new { status = "reported" })
        : Results.Json(new { message = result.Error }, statusCode: result.StatusCode);
});

app.MapPost("/api/traceability/scan", async (TraceScanRequest request, MesDatabase database) =>
{
    await database.ExecuteAsync(
        """
        INSERT INTO MesTraceEvents (ProductBarcode, StationCode, EventType, OperatorNo, Result, Detail)
        VALUES (@ProductBarcode, @StationCode, @EventType, @OperatorNo, @Result, @Detail)
        """,
        request.ToParameters());
    return Results.Ok(new { status = "recorded" });
});

app.MapGet("/api/traceability/rgv-runs", async (MesDatabase database) =>
    Results.Ok(await database.QueryDictionaryAsync(
        "SELECT Id, TaskId, WorkOrderNo, StartTime, EndTime, FromPosition, ToPosition, DurationSeconds, MissionStateEnd FROM MesRgvRunRecords ORDER BY StartTime DESC")));

app.MapPost("/api/alarms", async (AlarmWrite request, MesDatabase database) =>
{
    var id = await database.ScalarAsync<int>(
        """
        INSERT INTO MesAlarms (StationCode, Level, Message, Status, Owner)
        OUTPUT INSERTED.Id
        VALUES (@StationCode, @Level, @Message, N'未处理', @Owner)
        """,
        request.ToParameters());
    return Results.Ok(new { id });
});

app.MapGet("/api/s7/points", async (MesDatabase database) =>
    Results.Ok(await database.QueryAsync<S7PointRow>("SELECT * FROM MesS7Points ORDER BY StationCode, Address")));

app.MapFallbackToFile("index.html");

app.Run();

sealed class RgvRunTracker(IHttpClientFactory httpClientFactory, MesDatabase database, IConfiguration configuration, ILogger<RgvRunTracker> logger) : BackgroundService
{
    private readonly string _s7Api = (configuration["S7:ApiBase"] ?? "http://127.0.0.1:4003").TrimEnd('/');
    private int? _activeId;
    private bool _seenMissionSeven;
    private DateTime _startTime;
    private int _fromPosition;
    private int _toPosition;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await PollAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogDebug(ex, "RGV run tracking poll failed."); }
            await Task.Delay(100, stoppingToken);
        }
    }

    private async Task PollAsync(CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient();
        using var response = await client.GetAsync($"{_s7Api}/api/s7/tags", cancellationToken);
        if (!response.IsSuccessStatusCode) return;
        var tags = await response.Content.ReadFromJsonAsync<List<S7RuntimeTag>>(cancellationToken: cancellationToken) ?? [];
        var mission = ReadInt(tags, "MissionState");
        var from = ReadInt(tags, "RGVFrom");
        var to = ReadInt(tags, "RGVTo");
        if (_activeId is null && mission > 0)
        {
            _startTime = DateTime.Now;
            _seenMissionSeven = mission == 7;
            _fromPosition = from;
            _toPosition = to;
            var taskId = $"RGV_{_startTime:yyyyMMddHHmmss}";
            _activeId = await database.ScalarAsync<int>(
                "INSERT INTO MesRgvRunRecords (TaskId, StartTime, FromPosition, ToPosition) OUTPUT INSERTED.Id VALUES (@TaskId, @StartTime, @FromPosition, @ToPosition)",
                new Dictionary<string, object?> { ["TaskId"] = taskId, ["StartTime"] = _startTime, ["FromPosition"] = from, ["ToPosition"] = to });
            return;
        }
        if (_activeId is null) return;
        // PLC may publish RGVFrom and RGVTo on different scans. Persist each
        // valid side independently so the run record does not retain the
        // zero/old snapshot captured when the mission was first created.
        var updatedFrom = mission > 0 && from > 0 && from != _fromPosition;
        var updatedTo = mission > 0 && to > 0 && to != _toPosition;
        if (updatedFrom || updatedTo)
        {
            if (updatedFrom) _fromPosition = from;
            if (updatedTo) _toPosition = to;
            await database.ExecuteAsync(
                "UPDATE MesRgvRunRecords SET FromPosition=@FromPosition, ToPosition=@ToPosition WHERE Id=@Id",
                new Dictionary<string, object?> { ["FromPosition"] = _fromPosition, ["ToPosition"] = _toPosition, ["Id"] = _activeId.Value });
        }
        if (mission == 7) _seenMissionSeven = true;
        if (_seenMissionSeven && mission == 0)
        {
            var endTime = DateTime.Now;
            await database.ExecuteAsync(
                """
                UPDATE MesRgvRunRecords
                SET EndTime=@EndTime,
                    DurationSeconds=DATEDIFF_BIG(MILLISECOND, StartTime, @EndTime) / 1000.0,
                    MissionStateEnd=@MissionStateEnd,
                    WorkOrderNo=(SELECT TOP 1 WorkOrderNo FROM MesWorkOrders WHERE Status=N'执行中' ORDER BY Priority, Id)
                WHERE Id=@Id AND EndTime IS NULL
                """,
                new Dictionary<string, object?> { ["EndTime"] = endTime, ["MissionStateEnd"] = mission, ["Id"] = _activeId.Value });
            _activeId = null;
            _seenMissionSeven = false;
        }
    }

    private static int ReadInt(IEnumerable<S7RuntimeTag> tags, string name)
    {
        var value = tags.FirstOrDefault(tag => string.Equals(tag.Name, name, StringComparison.OrdinalIgnoreCase))?.Value;
        return int.TryParse(value, out var parsed) ? parsed : 0;
    }
}

sealed record S7RuntimeTag(string Name, string Value, string? Quality);

sealed class MesDatabase(IConfiguration configuration)
{
    private readonly string _connectionString = configuration.GetConnectionString("Mes")
        ?? "Server=localhost\\MES;Database=MES;User Id=ZXC;Password=1826;TrustServerCertificate=True;Encrypt=False";

    public async Task InitializeAsync()
    {
        await ExecuteAsync(SchemaSql);
        await ExecuteAsync(SeedSql);
    }

    public async Task<int> ExecuteAsync(string sql, IReadOnlyDictionary<string, object?>? parameters = null)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var command = CreateCommand(connection, sql, parameters);
        return await command.ExecuteNonQueryAsync();
    }

    public async Task InsertLabelPrintsAsync(string workOrderNo, string productName, int startCode, int endCode)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();
        try
        {
            for (var labelCode = startCode; labelCode <= endCode; labelCode++)
            {
                await using var command = new SqlCommand(
                    "INSERT INTO LabelPrint (WorkOrderNo, ProductName, LabelCode, QrCode) VALUES (@WorkOrderNo, @ProductName, @LabelCode, @QrCode)",
                    connection,
                    transaction);
                command.Parameters.AddWithValue("@WorkOrderNo", workOrderNo);
                command.Parameters.AddWithValue("@ProductName", productName);
                command.Parameters.AddWithValue("@LabelCode", labelCode);
                command.Parameters.AddWithValue("@QrCode", LabelQrCode.Build(workOrderNo, productName, labelCode));
                await command.ExecuteNonQueryAsync();
            }
            await transaction.CommitAsync();
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
    }

    public async Task<ReportWorkResult> ReportWorkAsync(ReportWorkRequest request)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var transaction = (SqlTransaction)await connection.BeginTransactionAsync();

        try
        {
            await using var taskCommand = new SqlCommand(
                """
                SELECT TOP 1 t.Status, t.WorkOrderNo, wo.PlanQty, wo.CompletedQty
                FROM MesTasks t
                JOIN MesWorkOrders wo ON wo.WorkOrderNo = t.WorkOrderNo
                WHERE t.Id = @TaskId
                """,
                connection,
                transaction);
            taskCommand.Parameters.AddWithValue("@TaskId", request.TaskId);
            await using var reader = await taskCommand.ExecuteReaderAsync();
            if (!await reader.ReadAsync())
            {
                await reader.CloseAsync();
                await transaction.RollbackAsync();
                return new ReportWorkResult(404, "报工任务不存在或关联工单不存在。");
            }

            var taskStatus = reader.GetString(0);
            var workOrderNo = reader.GetString(1);
            var planQty = reader.GetInt32(2);
            var completedQty = reader.GetInt32(3);
            await reader.CloseAsync();

            if (string.Equals(taskStatus, "已完成", StringComparison.Ordinal))
            {
                await transaction.RollbackAsync();
                return new ReportWorkResult(409, "该任务已经报工完成。");
            }

            if (completedQty + request.GoodQty > planQty)
            {
                await transaction.RollbackAsync();
                return new ReportWorkResult(400, "良品数量不能超过工单计划数量。");
            }

            await using var taskUpdate = new SqlCommand(
                """
                UPDATE MesTasks
                SET Status=N'已完成', GoodQty=@GoodQty, BadQty=@BadQty, CompletedAt=SYSDATETIME()
                WHERE Id=@TaskId AND Status<>N'已完成'
                """,
                connection,
                transaction);
            taskUpdate.Parameters.AddWithValue("@TaskId", request.TaskId);
            taskUpdate.Parameters.AddWithValue("@GoodQty", request.GoodQty);
            taskUpdate.Parameters.AddWithValue("@BadQty", request.BadQty);
            if (await taskUpdate.ExecuteNonQueryAsync() != 1)
            {
                await transaction.RollbackAsync();
                return new ReportWorkResult(409, "任务状态已发生变化，请刷新后重试。");
            }

            await using var orderUpdate = new SqlCommand(
                "UPDATE MesWorkOrders SET CompletedQty=CompletedQty+@GoodQty WHERE WorkOrderNo=@WorkOrderNo AND CompletedQty+@GoodQty<=PlanQty",
                connection,
                transaction);
            orderUpdate.Parameters.AddWithValue("@GoodQty", request.GoodQty);
            orderUpdate.Parameters.AddWithValue("@WorkOrderNo", workOrderNo);
            if (await orderUpdate.ExecuteNonQueryAsync() != 1)
            {
                await transaction.RollbackAsync();
                return new ReportWorkResult(400, "良品数量不能超过工单计划数量。");
            }

            await using var traceInsert = new SqlCommand(
                """
                INSERT INTO MesTraceEvents (ProductBarcode, StationCode, EventType, OperatorNo, Result, Detail)
                VALUES (@ProductBarcode, @StationCode, N'报工', @OperatorNo, N'完成', @Detail)
                """,
                connection,
                transaction);
            traceInsert.Parameters.AddWithValue("@ProductBarcode", request.ProductBarcode.Trim());
            traceInsert.Parameters.AddWithValue("@StationCode", request.StationCode.Trim());
            traceInsert.Parameters.AddWithValue("@OperatorNo", request.OperatorNo.Trim());
            traceInsert.Parameters.AddWithValue("@Detail", $"良品 {request.GoodQty}, 不良 {request.BadQty}");
            await traceInsert.ExecuteNonQueryAsync();

            await transaction.CommitAsync();
            return new ReportWorkResult(200, null);
        }
        catch
        {
            await transaction.RollbackAsync();
            throw;
        }
    }

    public async Task<T> ScalarAsync<T>(string sql, IReadOnlyDictionary<string, object?>? parameters = null)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var command = CreateCommand(connection, sql, parameters);
        var value = await command.ExecuteScalarAsync();
        return (T)Convert.ChangeType(value!, typeof(T));
    }

    public async Task<T> QuerySingleAsync<T>(string sql, IReadOnlyDictionary<string, object?>? parameters = null) where T : new()
    {
        return (await QueryAsync<T>(sql, parameters)).First();
    }

    public async Task<T?> QuerySingleOrDefaultAsync<T>(string sql, IReadOnlyDictionary<string, object?>? parameters = null) where T : new()
    {
        return (await QueryAsync<T>(sql, parameters)).FirstOrDefault();
    }

    public async Task<List<T>> QueryAsync<T>(string sql, IReadOnlyDictionary<string, object?>? parameters = null) where T : new()
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var command = CreateCommand(connection, sql, parameters);
        await using var reader = await command.ExecuteReaderAsync();
        var rows = new List<T>();
        var props = typeof(T).GetProperties().ToDictionary(p => p.Name, StringComparer.OrdinalIgnoreCase);
        while (await reader.ReadAsync())
        {
            var row = new T();
            for (var i = 0; i < reader.FieldCount; i++)
            {
                if (!props.TryGetValue(reader.GetName(i), out var prop) || reader.IsDBNull(i))
                {
                    continue;
                }

                var target = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
                prop.SetValue(row, Convert.ChangeType(reader.GetValue(i), target));
            }
            rows.Add(row);
        }
        return rows;
    }

    public async Task<List<Dictionary<string, object?>>> QueryDictionaryAsync(string sql)
    {
        await using var connection = new SqlConnection(_connectionString);
        await connection.OpenAsync();
        await using var command = CreateCommand(connection, sql);
        await using var reader = await command.ExecuteReaderAsync();
        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < reader.FieldCount; i++)
            {
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            }
            rows.Add(row);
        }
        return rows;
    }

    private static SqlCommand CreateCommand(SqlConnection connection, string sql, IReadOnlyDictionary<string, object?>? parameters = null)
    {
        var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandType = CommandType.Text;
        if (parameters is null)
        {
            return command;
        }

        foreach (var (key, value) in parameters)
        {
            command.Parameters.AddWithValue("@" + key, value ?? DBNull.Value);
        }
        return command;
    }

    private const string SchemaSql =
        """
        IF OBJECT_ID('MesRoles') IS NULL CREATE TABLE MesRoles (Code nvarchar(40) NOT NULL PRIMARY KEY, Name nvarchar(80) NOT NULL, Description nvarchar(200) NULL);
        IF OBJECT_ID('MesRolePermissions') IS NULL CREATE TABLE MesRolePermissions (Id int IDENTITY PRIMARY KEY, RoleCode nvarchar(40) NOT NULL, ModuleKey nvarchar(60) NOT NULL, CanRead bit NOT NULL, CanWrite bit NOT NULL);
        IF OBJECT_ID('MesEmployees') IS NULL CREATE TABLE MesEmployees (Id int IDENTITY PRIMARY KEY, EmployeeNo nvarchar(40) NOT NULL UNIQUE, Name nvarchar(80) NOT NULL, Department nvarchar(80) NOT NULL, RoleCode nvarchar(40) NOT NULL, IsActive bit NOT NULL DEFAULT 1);
        IF OBJECT_ID('MesEmployeeProcessPermissions') IS NULL CREATE TABLE MesEmployeeProcessPermissions (Id int IDENTITY PRIMARY KEY, EmployeeId int NOT NULL, RouteId int NOT NULL, SequenceNo int NOT NULL, OperationName nvarchar(120) NOT NULL, CanView bit NOT NULL DEFAULT 1, CanOperate bit NOT NULL DEFAULT 0, CanMaintainSop bit NOT NULL DEFAULT 0);
        IF OBJECT_ID('MesProducts') IS NULL CREATE TABLE MesProducts (Id int IDENTITY PRIMARY KEY, Name nvarchar(120) NOT NULL, Barcode nvarchar(80) NOT NULL, Category nvarchar(80) NOT NULL, ProcessRoute nvarchar(120) NOT NULL, CreatedAt datetime2 NOT NULL DEFAULT SYSDATETIME());
        IF OBJECT_ID('MesAcceptanceSpecs') IS NULL CREATE TABLE MesAcceptanceSpecs (Id int IDENTITY PRIMARY KEY, ProductName nvarchar(120) NOT NULL, Item nvarchar(120) NOT NULL, Standard nvarchar(200) NOT NULL, RejectThreshold nvarchar(120) NOT NULL, Method nvarchar(120) NOT NULL);
        IF OBJECT_ID('MesProcessRoutes') IS NULL CREATE TABLE MesProcessRoutes (Id int IDENTITY PRIMARY KEY, Name nvarchar(120) NOT NULL, ProductName nvarchar(120) NOT NULL, Steps nvarchar(400) NOT NULL, Version nvarchar(40) NOT NULL, Status nvarchar(40) NOT NULL);
        IF OBJECT_ID('MesProcessStationBindings') IS NULL CREATE TABLE MesProcessStationBindings (Id int IDENTITY PRIMARY KEY, RouteId int NOT NULL, StationCode nvarchar(40) NOT NULL, OperationName nvarchar(120) NOT NULL, SequenceNo int NOT NULL, IsRequired bit NOT NULL DEFAULT 1);
        IF OBJECT_ID('MesSopFiles') IS NULL CREATE TABLE MesSopFiles (Id int IDENTITY PRIMARY KEY, Title nvarchar(120) NOT NULL, ProductName nvarchar(120) NOT NULL, StationCode nvarchar(40) NOT NULL, FileType nvarchar(20) NOT NULL, FilePath nvarchar(300) NOT NULL, Version nvarchar(40) NOT NULL);
        IF COL_LENGTH('MesSopFiles','RouteId') IS NULL ALTER TABLE MesSopFiles ADD RouteId int NULL;
        IF COL_LENGTH('MesSopFiles','SequenceNo') IS NULL ALTER TABLE MesSopFiles ADD SequenceNo int NULL;
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'UX_MesSopFiles_Route_Sequence')
           AND NOT EXISTS (SELECT RouteId, SequenceNo FROM MesSopFiles WHERE RouteId IS NOT NULL AND SequenceNo IS NOT NULL GROUP BY RouteId, SequenceNo HAVING COUNT(*) > 1)
          CREATE UNIQUE INDEX UX_MesSopFiles_Route_Sequence ON MesSopFiles(RouteId, SequenceNo) WHERE RouteId IS NOT NULL AND SequenceNo IS NOT NULL;
        IF OBJECT_ID('MesWorkOrders') IS NULL CREATE TABLE MesWorkOrders (Id int IDENTITY PRIMARY KEY, WorkOrderNo nvarchar(80) NOT NULL, ProductName nvarchar(120) NOT NULL, PlanQty int NOT NULL, CompletedQty int NOT NULL, Priority int NOT NULL, Status nvarchar(40) NOT NULL, DueDate date NOT NULL);
        IF COL_LENGTH('MesWorkOrders','ArchivedAt') IS NULL ALTER TABLE MesWorkOrders ADD ArchivedAt datetime2 NULL;
        IF OBJECT_ID('LabelPrint') IS NULL CREATE TABLE LabelPrint (Id int IDENTITY PRIMARY KEY, WorkOrderNo nvarchar(80) NOT NULL, ProductName nvarchar(120) NOT NULL, LabelCode int NOT NULL, QrCode nvarchar(500) NOT NULL, TimeStamp datetime2 NOT NULL DEFAULT SYSDATETIME());
        IF COL_LENGTH('LabelPrint','PrintedAt') IS NOT NULL AND COL_LENGTH('LabelPrint','TimeStamp') IS NULL EXEC sp_rename N'LabelPrint.PrintedAt', N'TimeStamp', N'COLUMN';
        IF COL_LENGTH('LabelPrint','QrCode') IS NULL ALTER TABLE LabelPrint ADD QrCode nvarchar(500) NULL;
        EXEC sp_executesql N'UPDATE LabelPrint SET QrCode=CONCAT(N''WO='', WorkOrderNo, N''|PN='', ProductName, N''|SN='', LabelCode) WHERE QrCode IS NULL';
        IF COL_LENGTH('LabelPrint','QrCode') IS NOT NULL ALTER TABLE LabelPrint ALTER COLUMN QrCode nvarchar(500) NOT NULL;
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'UX_LabelPrint_WorkOrder_Code') CREATE UNIQUE INDEX UX_LabelPrint_WorkOrder_Code ON LabelPrint(WorkOrderNo, LabelCode);
        IF OBJECT_ID('MesTasks') IS NULL CREATE TABLE MesTasks (Id int IDENTITY PRIMARY KEY, WorkOrderNo nvarchar(80) NOT NULL, StationCode nvarchar(40) NOT NULL, OperationName nvarchar(120) NOT NULL, Assignee nvarchar(80) NULL, Status nvarchar(40) NOT NULL, GoodQty int NOT NULL DEFAULT 0, BadQty int NOT NULL DEFAULT 0, CompletedAt datetime2 NULL);
        IF OBJECT_ID('MesStations') IS NULL CREATE TABLE MesStations (Id int IDENTITY PRIMARY KEY, Code nvarchar(40) NOT NULL, Name nvarchar(120) NOT NULL, Status nvarchar(40) NOT NULL, OperatorName nvarchar(80) NOT NULL, OutputQty int NOT NULL, AlarmText nvarchar(200) NULL);
        IF OBJECT_ID('MesTraceEvents') IS NULL CREATE TABLE MesTraceEvents (Id int IDENTITY PRIMARY KEY, ProductBarcode nvarchar(80) NOT NULL, StationCode nvarchar(40) NOT NULL, EventType nvarchar(40) NOT NULL, OperatorNo nvarchar(40) NOT NULL, Result nvarchar(40) NOT NULL, Detail nvarchar(300) NULL, CreatedAt datetime2 NOT NULL DEFAULT SYSDATETIME());
        IF OBJECT_ID('MesRgvRunRecords') IS NULL CREATE TABLE MesRgvRunRecords (Id int IDENTITY PRIMARY KEY, TaskId nvarchar(64) NOT NULL, WorkOrderNo nvarchar(80) NULL, StartTime datetime2 NOT NULL, EndTime datetime2 NULL, FromPosition int NOT NULL, ToPosition int NOT NULL, DurationSeconds decimal(18,3) NULL, MissionStateEnd int NULL);
        IF COL_LENGTH('MesRgvRunRecords','WorkOrderNo') IS NULL ALTER TABLE MesRgvRunRecords ADD WorkOrderNo nvarchar(80) NULL;
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name=N'UX_MesRgvRunRecords_TaskId') CREATE UNIQUE INDEX UX_MesRgvRunRecords_TaskId ON MesRgvRunRecords(TaskId);
        IF OBJECT_ID('MesAlarms') IS NULL CREATE TABLE MesAlarms (Id int IDENTITY PRIMARY KEY, StationCode nvarchar(40) NOT NULL, Level nvarchar(40) NOT NULL, Message nvarchar(200) NOT NULL, Status nvarchar(40) NOT NULL, Owner nvarchar(80) NULL, CreatedAt datetime2 NOT NULL DEFAULT SYSDATETIME());
        IF OBJECT_ID('MesDeviceReadings') IS NULL CREATE TABLE MesDeviceReadings (Id int IDENTITY PRIMARY KEY, StationCode nvarchar(40) NOT NULL, PointAddress nvarchar(80) NOT NULL, Value nvarchar(80) NOT NULL, Quality nvarchar(40) NOT NULL, CreatedAt datetime2 NOT NULL DEFAULT SYSDATETIME());
        IF OBJECT_ID('MesS7Points') IS NULL CREATE TABLE MesS7Points (Id int IDENTITY PRIMARY KEY, StationCode nvarchar(40) NOT NULL, PlcAddress nvarchar(80) NOT NULL, Rack int NOT NULL, Slot int NOT NULL, Address nvarchar(80) NOT NULL, DataType nvarchar(40) NOT NULL, ScanMs int NOT NULL, IsEnabled bit NOT NULL);
        IF OBJECT_ID('MesIntegrationEndpoints') IS NULL CREATE TABLE MesIntegrationEndpoints (Id int IDENTITY PRIMARY KEY, SystemName nvarchar(80) NOT NULL, Direction nvarchar(40) NOT NULL, ApiName nvarchar(120) NOT NULL, Status nvarchar(40) NOT NULL, LastSyncAt datetime2 NULL);
        IF OBJECT_ID('MesSystemSettings') IS NULL CREATE TABLE MesSystemSettings (Id int IDENTITY PRIMARY KEY, SettingKey nvarchar(80) NOT NULL, SettingValue nvarchar(300) NOT NULL, Description nvarchar(200) NULL);
        """;

    private const string SeedSql =
        """
        IF NOT EXISTS (SELECT 1 FROM MesRoles)
        BEGIN
          INSERT INTO MesRoles VALUES (N'admin', N'系统管理员', N'维护人员、角色、权限、工厂参数和全部业务数据');
          INSERT INTO MesRoles VALUES (N'planner', N'计划员', N'维护产品、工艺、计划、工单和调度');
          INSERT INTO MesRoles VALUES (N'operator', N'工位员工', N'查看工位任务，扫码报工，提交异常报警');
          INSERT INTO MesRoles VALUES (N'quality', N'质量员', N'维护验收规范、质量报表和追溯记录');
        END
        IF NOT EXISTS (SELECT 1 FROM MesRolePermissions)
        BEGIN
          DECLARE @m TABLE(ModuleKey nvarchar(60));
          INSERT INTO @m VALUES (N'product'),(N'process'),(N'production'),(N'report'),(N'dashboard'),(N'traceability'),(N'interface'),(N'settings'),(N'workstation');
          INSERT INTO MesRolePermissions SELECT N'admin', ModuleKey, 1, 1 FROM @m;
          INSERT INTO MesRolePermissions SELECT N'planner', ModuleKey, 1, CASE WHEN ModuleKey IN (N'product',N'process',N'production') THEN 1 ELSE 0 END FROM @m;
          INSERT INTO MesRolePermissions SELECT N'operator', ModuleKey, 1, CASE WHEN ModuleKey IN (N'workstation',N'traceability') THEN 1 ELSE 0 END FROM @m WHERE ModuleKey IN (N'dashboard',N'workstation',N'traceability');
          INSERT INTO MesRolePermissions SELECT N'quality', ModuleKey, 1, CASE WHEN ModuleKey IN (N'product',N'report',N'traceability') THEN 1 ELSE 0 END FROM @m WHERE ModuleKey IN (N'product',N'report',N'dashboard',N'traceability');
        END
        IF NOT EXISTS (SELECT 1 FROM MesEmployees)
        BEGIN
          INSERT INTO MesEmployees (EmployeeNo,Name,Department,RoleCode) VALUES
          (N'1001',N'张工',N'装配一线',N'operator'),
          (N'1002',N'李工',N'质量部',N'quality'),
          (N'2001',N'王计划',N'生产计划',N'planner');
        END
        IF NOT EXISTS (SELECT 1 FROM MesProducts)
        BEGIN
          IF COL_LENGTH('MesProducts', 'StandardHours') IS NOT NULL
             AND COL_LENGTH('MesProducts', 'Status') IS NOT NULL
          BEGIN
            EXEC sp_executesql N'
              INSERT INTO MesProducts (Name,Barcode,Category,ProcessRoute,StandardHours,Status) VALUES
              (N''电机控制器 A 型'',N''MES-P-A-001'',N''控制器'',N''控制器总装路线'',0,N''启用''),
              (N''伺服驱动器 B 型'',N''MES-P-B-001'',N''驱动器'',N''驱动器检测路线'',0,N''启用'');';
          END
          ELSE
          BEGIN
            INSERT INTO MesProducts (Name,Barcode,Category,ProcessRoute) VALUES
            (N'电机控制器 A 型',N'MES-P-A-001',N'控制器',N'控制器总装路线'),
            (N'伺服驱动器 B 型',N'MES-P-B-001',N'驱动器',N'驱动器检测路线');
          END
        END
        IF NOT EXISTS (SELECT 1 FROM MesAcceptanceSpecs)
        BEGIN
          INSERT INTO MesAcceptanceSpecs (ProductName,Item,Standard,RejectThreshold,Method) VALUES
          (N'电机控制器 A 型',N'外观缺陷',N'无划伤、无变形、标签完整',N'任意严重外观缺陷',N'目检'),
          (N'电机控制器 A 型',N'绝缘电阻',N'>= 100MΩ',N'< 80MΩ',N'检测设备采集');
        END
        IF NOT EXISTS (SELECT 1 FROM MesProcessRoutes)
        BEGIN
          INSERT INTO MesProcessRoutes (Name,ProductName,Steps,Version,Status) VALUES
          (N'控制器总装路线',N'电机控制器 A 型',N'扫码上线 > 装配 > 功能测试 > 终检 > 入库',N'V1.0',N'在线'),
          (N'驱动器检测路线',N'伺服驱动器 B 型',N'扫码上线 > 老化 > 参数检测 > 包装',N'V1.0',N'在线');
        END
        IF NOT EXISTS (SELECT 1 FROM MesStations WHERE Code=N'OP1')
        BEGIN
          DECLARE @i int = 1;
          WHILE @i <= 18
          BEGIN
            INSERT INTO MesStations (Code,Name,Status,OperatorName,OutputQty,AlarmText)
            SELECT CONCAT(N'OP', @i), CONCAT(N'工位机 OP', @i), N'待机', N'未签入', 0, NULL
            WHERE NOT EXISTS (SELECT 1 FROM MesStations WHERE Code=CONCAT(N'OP', @i));
            SET @i += 1;
          END
        END
        IF NOT EXISTS (SELECT 1 FROM MesProcessStationBindings)
        BEGIN
          DECLARE @routeId int = (SELECT TOP 1 Id FROM MesProcessRoutes WHERE Name=N'控制器总装路线');
          INSERT INTO MesProcessStationBindings (RouteId,StationCode,OperationName,SequenceNo,IsRequired) VALUES
            (@routeId,N'OP1',N'扫码上线',1,1),
            (@routeId,N'OP2',N'装配',2,1),
            (@routeId,N'OP3',N'功能测试',3,1),
            (@routeId,N'OP4',N'终检',4,1);
        END
        IF NOT EXISTS (SELECT 1 FROM MesSopFiles)
        BEGIN
          INSERT INTO MesSopFiles (Title,ProductName,StationCode,FileType,FilePath,Version) VALUES
          (N'控制器装配 SOP',N'电机控制器 A 型',N'OP10',N'PDF',N'D:\MES\SOP\controller-op10.pdf',N'V1.0'),
          (N'功能测试 SOP',N'电机控制器 A 型',N'TEST20',N'PDF',N'D:\MES\SOP\controller-test20.pdf',N'V1.0');
        END
        IF NOT EXISTS (SELECT 1 FROM MesWorkOrders)
        BEGIN
          INSERT INTO MesWorkOrders (WorkOrderNo,ProductName,PlanQty,CompletedQty,Priority,Status,DueDate) VALUES
          (N'WO-20260526-001',N'电机控制器 A 型',120,48,1,N'执行中',DATEADD(day,2,CAST(GETDATE() AS date))),
          (N'WO-20260526-002',N'伺服驱动器 B 型',80,12,2,N'待执行',DATEADD(day,3,CAST(GETDATE() AS date)));
        END
        IF NOT EXISTS (SELECT 1 FROM MesTasks)
        BEGIN
          INSERT INTO MesTasks (WorkOrderNo,StationCode,OperationName,Assignee,Status) VALUES
          (N'WO-20260526-001',N'OP10',N'扫码上线',N'1001',N'执行中'),
          (N'WO-20260526-001',N'TEST20',N'功能测试',N'1001',N'待执行');
        END
        IF NOT EXISTS (SELECT 1 FROM MesAlarms)
        BEGIN
          INSERT INTO MesAlarms (StationCode,Level,Message,Status,Owner) VALUES
          (N'QC30',N'中',N'检测设备数据采集超时',N'未处理',N'李工');
        END
        IF NOT EXISTS (SELECT 1 FROM MesS7Points)
        BEGIN
          INSERT INTO MesS7Points (StationCode,PlcAddress,Rack,Slot,Address,DataType,ScanMs,IsEnabled) VALUES
          (N'OP10',N'192.168.1.10',0,1,N'DB1.DBX0.0',N'Bool',1000,1),
          (N'TEST20',N'192.168.1.11',0,1,N'DB1.DBW2',N'Int16',1000,1),
          (N'QC30',N'192.168.1.12',0,1,N'DB1.DBD4',N'Real',1000,1);
        END
        IF NOT EXISTS (SELECT 1 FROM MesIntegrationEndpoints)
        BEGIN
          INSERT INTO MesIntegrationEndpoints (SystemName,Direction,ApiName,Status,LastSyncAt) VALUES
          (N'ERP',N'接收',N'接收工单',N'启用',SYSDATETIME()),
          (N'SCADA',N'写入',N'设备数据写入',N'启用',SYSDATETIME());
        END
        IF NOT EXISTS (SELECT 1 FROM MesSystemSettings)
        BEGIN
          INSERT INTO MesSystemSettings (SettingKey,SettingValue,Description) VALUES
          (N'FactoryName',N'ZXC 智能制造工厂',N'工厂名称'),
          (N'LogPath',N'D:\MES\Logs',N'系统日志存储位置'),
          (N'MaintenanceCycleDays',N'30',N'维护周期');
        END
        """;
}

static class ModuleCatalog
{
    public static readonly ModuleInfo[] All =
    [
        new("product", "产品管理", "产品信息、验收规范、条码和工艺绑定", "MesProducts"),
        new("process", "工艺管理", "工艺路线、工序、SOP 文件和产线工序分配", "MesProcessRoutes"),
        new("production", "生产管理", "生产计划、工单、任务派发、调度和报工", "MesWorkOrders"),
        new("report", "统计报表", "产品日报、质量日报、效率和不良统计", "MesAlarms"),
        new("dashboard", "产线可视化", "工位状态、生产进度和预计完工时间", "MesStations"),
        new("traceability", "生产追溯", "扫码进出、异常、报警和检测设备数据", "MesTraceEvents"),
        new("interface", "接口模块", "ERP、MES、MOM、SCADA 和标准 API 对接", "MesIntegrationEndpoints"),
        new("settings", "系统管理", "工厂、人员、角色、权限和系统参数", "MesSystemSettings"),
        new("workstation", "工位机", "任务签收、SOP 推送、扫码报工和异常报警", "MesTasks")
    ];

    public static string? TableFor(string moduleKey) => All.FirstOrDefault(m => m.Key == moduleKey)?.TableName;
}

record ModuleInfo(string Key, string Label, string Description, string TableName);
record LoginRequest(string Username, string Password);
record EmployeeLoginRequest(string EmployeeNo);
record Session(string UserType, string DisplayName, string RoleCode, string RoleName, string? EmployeeNo)
{
    public static Session Admin() => new("admin", "系统管理员", "admin", "系统管理员", null);
    public static Session Employee(EmployeeSession employee) => new("employee", employee.Name, employee.RoleCode, employee.RoleName, employee.EmployeeNo);
}
record ProductWrite(string Name, string Barcode, string Category, string ProcessRoute)
{
    public Dictionary<string, object?> ToParameters() => new()
    {
        ["Name"] = Name,
        ["Barcode"] = Barcode,
        ["Category"] = Category,
        ["ProcessRoute"] = ProcessRoute
    };
}
record ProcessRouteWrite(string Name, string ProductName, string Steps, string Version, string Status)
{
    public Dictionary<string, object?> ToParameters() => new()
    {
        ["Name"] = Name.Trim(),
        ["ProductName"] = ProductName.Trim(),
        ["Steps"] = Steps.Trim(),
        ["Version"] = Version.Trim(),
        ["Status"] = Status.Trim()
    };
}
record ProcessBindingSave(List<ProcessStationBindingWrite> Bindings);
record ProcessStationBindingWrite(string StationCode, string OperationName, int SequenceNo, bool IsRequired);
record EmployeeProcessPermissionSave(List<EmployeeProcessPermissionWrite> Permissions);
record EmployeeProcessPermissionWrite(int RouteId, int SequenceNo, string OperationName, bool CanView, bool CanOperate, bool CanMaintainSop);
record SopFileWrite(int SequenceNo, string? Title, string? ProductName, string? StationCode, string? FileType, string FilePath, string? Version)
{
    public Dictionary<string, object?> ToParameters() => new()
    {
        ["SequenceNo"] = SequenceNo,
        ["Title"] = string.IsNullOrWhiteSpace(Title) ? $"工序 {SequenceNo} SOP" : Title.Trim(),
        ["ProductName"] = string.IsNullOrWhiteSpace(ProductName) ? "MES工艺路线" : ProductName.Trim(),
        ["StationCode"] = string.IsNullOrWhiteSpace(StationCode) ? "" : StationCode.Trim(),
        ["FileType"] = string.IsNullOrWhiteSpace(FileType) ? "PDF" : FileType.Trim().ToUpperInvariant(),
        ["FilePath"] = FilePath.Trim(),
        ["Version"] = string.IsNullOrWhiteSpace(Version) ? "V1.0" : Version.Trim()
    };
}
record WorkOrderWrite(string? WorkOrderNo, string ProductName, int PlanQty, int Priority, DateTime DueDate)
{
    public Dictionary<string, object?> ToParameters() => new()
    {
        ["ProductName"] = ProductName,
        ["PlanQty"] = PlanQty,
        ["Priority"] = Priority,
        ["DueDate"] = DueDate.Date
    };
}
record LabelPrintRequest(int StartCode, int EndCode);
record LabelQrCodeParseRequest(string QrCode);
record LabelQrCodeParsed(string WorkOrderNo, string ProductName, int LabelCode);

static class LabelQrCode
{
    public static string Build(string workOrderNo, string productName, int labelCode) =>
        $"WO={Uri.EscapeDataString(workOrderNo)}|PN={Uri.EscapeDataString(productName)}|SN={labelCode}";

    public static bool TryParse(string? qrCode, out LabelQrCodeParsed? label)
    {
        label = null;
        if (string.IsNullOrWhiteSpace(qrCode)) return false;

        var parts = qrCode.Trim().Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 4 && string.Equals(parts[0], "MES1", StringComparison.Ordinal)) parts = parts[1..];
        if (parts.Length != 3) return false;

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in parts)
        {
            var separator = part.IndexOf('=');
            if (separator <= 0 || separator == part.Length - 1) return false;
            if (!values.TryAdd(part[..separator], part[(separator + 1)..])) return false;
        }

        if (!values.TryGetValue("WO", out var workOrderNo) ||
            !values.TryGetValue("PN", out var productName) ||
            !values.TryGetValue("SN", out var serialText) ||
            !int.TryParse(serialText, out var labelCode) || labelCode < 1)
        {
            return false;
        }

        try
        {
            workOrderNo = Uri.UnescapeDataString(workOrderNo);
            productName = Uri.UnescapeDataString(productName);
        }
        catch (UriFormatException)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(workOrderNo) || string.IsNullOrWhiteSpace(productName)) return false;
        label = new LabelQrCodeParsed(workOrderNo, productName, labelCode);
        return true;
    }
}
record WorkOrderStatusWrite(string Status);
record WorkOrderUpdateWrite(int CompletedQty, int Priority, DateTime DueDate, string Status);
record EmployeeWrite(string EmployeeNo, string Name, string Department, string RoleCode, bool IsActive)
{
    public Dictionary<string, object?> ToParameters() => new()
    {
        ["EmployeeNo"] = EmployeeNo.Trim(),
        ["Name"] = Name.Trim(),
        ["Department"] = Department.Trim(),
        ["RoleCode"] = RoleCode.Trim(),
        ["IsActive"] = IsActive
    };
}
record ReportWorkRequest(int TaskId, string ProductBarcode, string StationCode, string OperatorNo, int GoodQty, int BadQty);
record ReportWorkResult(int StatusCode, string? Error);
record TraceScanRequest(string ProductBarcode, string StationCode, string EventType, string OperatorNo, string Result, string? Detail)
{
    public Dictionary<string, object?> ToParameters() => new()
    {
        ["ProductBarcode"] = ProductBarcode,
        ["StationCode"] = StationCode,
        ["EventType"] = EventType,
        ["OperatorNo"] = OperatorNo,
        ["Result"] = Result,
        ["Detail"] = Detail
    };
}
record AlarmWrite(string StationCode, string Level, string Message, string? Owner)
{
    public Dictionary<string, object?> ToParameters() => new()
    {
        ["StationCode"] = StationCode,
        ["Level"] = Level,
        ["Message"] = Message,
        ["Owner"] = Owner
    };
}

sealed class SystemInfo { public string ServiceName { get; set; } = ""; public string DatabaseName { get; set; } = ""; public DateTime ServerTime { get; set; } }
sealed class EmployeeSession { public string EmployeeNo { get; set; } = ""; public string Name { get; set; } = ""; public string RoleCode { get; set; } = ""; public string RoleName { get; set; } = ""; }
sealed class EmployeeRow { public int Id { get; set; } public string EmployeeNo { get; set; } = ""; public string Name { get; set; } = ""; public string Department { get; set; } = ""; public string RoleCode { get; set; } = ""; public string RoleName { get; set; } = ""; public bool IsActive { get; set; } }
sealed class EmployeeProcessPermissionRow { public int Id { get; set; } public int EmployeeId { get; set; } public string EmployeeNo { get; set; } = ""; public string EmployeeName { get; set; } = ""; public int RouteId { get; set; } public string RouteName { get; set; } = ""; public int SequenceNo { get; set; } public string OperationName { get; set; } = ""; public bool CanView { get; set; } public bool CanOperate { get; set; } public bool CanMaintainSop { get; set; } }
sealed class RoleRow { public string Code { get; set; } = ""; public string Name { get; set; } = ""; public string? Description { get; set; } }
sealed class PermissionRow { public string ModuleKey { get; set; } = ""; public bool CanRead { get; set; } public bool CanWrite { get; set; } }
sealed class ProductRow { public int Id { get; set; } public string Name { get; set; } = ""; public string Barcode { get; set; } = ""; public string Category { get; set; } = ""; public string ProcessRoute { get; set; } = ""; public DateTime CreatedAt { get; set; } }
sealed class ProcessRouteRow { public int Id { get; set; } public string Name { get; set; } = ""; public string ProductName { get; set; } = ""; public string Steps { get; set; } = ""; public string Version { get; set; } = ""; public string Status { get; set; } = ""; }
sealed class ProcessStationBindingRow { public int Id { get; set; } public int RouteId { get; set; } public string StationCode { get; set; } = ""; public string OperationName { get; set; } = ""; public int SequenceNo { get; set; } public bool IsRequired { get; set; } }
sealed class SopIdRow { public int Id { get; set; } }
sealed class SopFileRow { public int Id { get; set; } public int? RouteId { get; set; } public int? SequenceNo { get; set; } public string Title { get; set; } = ""; public string ProductName { get; set; } = ""; public string StationCode { get; set; } = ""; public string FileType { get; set; } = ""; public string FilePath { get; set; } = ""; public string Version { get; set; } = ""; }
sealed class WorkstationWorkOrderRow { public string WorkOrderNo { get; set; } = ""; public string ProductName { get; set; } = ""; public int RouteId { get; set; } public string RouteName { get; set; } = ""; public int SequenceNo { get; set; } public string OperationName { get; set; } = ""; public string StationCode { get; set; } = ""; }
sealed class WorkstationQrContextRow { public string WorkOrderNo { get; set; } = ""; public string ProductName { get; set; } = ""; public int RouteId { get; set; } public string RouteName { get; set; } = ""; public int SequenceNo { get; set; } public string OperationName { get; set; } = ""; public string StationCode { get; set; } = ""; public int LabelCode { get; set; } }
sealed class StationStatus { public int Id { get; set; } public string Code { get; set; } = ""; public string Name { get; set; } = ""; public string Status { get; set; } = ""; public string OperatorName { get; set; } = ""; public int OutputQty { get; set; } public string? AlarmText { get; set; } }
sealed class WorkOrderRow { public int Id { get; set; } public string WorkOrderNo { get; set; } = ""; public string ProductName { get; set; } = ""; public int PlanQty { get; set; } public int CompletedQty { get; set; } public int Priority { get; set; } public string Status { get; set; } = ""; public DateTime DueDate { get; set; } }
sealed class AlarmRow { public int Id { get; set; } public string StationCode { get; set; } = ""; public string Level { get; set; } = ""; public string Message { get; set; } = ""; public string Status { get; set; } = ""; public string? Owner { get; set; } public DateTime CreatedAt { get; set; } }
sealed class S7PointRow { public int Id { get; set; } public string StationCode { get; set; } = ""; public string PlcAddress { get; set; } = ""; public int Rack { get; set; } public int Slot { get; set; } public string Address { get; set; } = ""; public string DataType { get; set; } = ""; public int ScanMs { get; set; } public bool IsEnabled { get; set; } }
