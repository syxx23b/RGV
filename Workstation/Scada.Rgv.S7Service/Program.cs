using Scada.Rgv.S7Service;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseWindowsService(options => options.ServiceName = "Scada RGV S7 Communication");
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.SetIsOriginAllowed(origin => Uri.TryCreate(origin, UriKind.Absolute, out var uri)
        && uri.Scheme is "http" or "https"
        && uri.Port is 9102 or 9101)
        .AllowAnyHeader()
        .AllowAnyMethod()));
builder.Services.AddSingleton<AppDataPaths>();
builder.Services.AddSingleton<SystemConfigurationStore>();
builder.Services.AddSingleton<TwinLayoutStore>();
builder.Services.AddSingleton<S7TagSnapshotStore>();
builder.Services.AddSingleton<S7TagStore>();
builder.Services.AddHostedService<Worker>();

var app = builder.Build();
app.UseCors();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok", module = "S7" }));
app.MapGet("/api/s7/status", (S7TagStore store) => Results.Ok(store.GetStatus()));
app.MapGet("/api/s7/configuration", (S7TagStore store) => Results.Ok(store.GetConfiguration()));
app.MapGet("/api/system/configuration", (SystemConfigurationStore store, S7TagStore tagStore) =>
    Results.Ok(store.Read() with { MaxPos = tagStore.GetMaxPos() }));
app.MapPut("/api/system/configuration", (SystemConfiguration configuration, SystemConfigurationStore store, S7TagStore tagStore) =>
{
    // MaxPos is controlled by DB4.DBW104 and cannot be changed through HMI settings.
    var requestedConfiguration = configuration with { MaxPos = tagStore.GetMaxPos() };
    if (!store.TrySave(requestedConfiguration, out var saved, out var error))
    {
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["stations"] = [error] });
    }

    tagStore.ApplyConfiguration(saved);
    return Results.Ok(saved);
});
app.MapGet("/api/s7/tags", (S7TagStore store) => Results.Ok(store.ReadAll()));
app.MapGet("/api/twin/layout", (TwinLayoutStore store) => Results.Ok(store.Read()));
app.MapPut("/api/twin/layout", (TwinLayoutState layout, TwinLayoutStore store) =>
    store.TrySave(layout, out var saved, out var error)
        ? Results.Ok(saved)
        : Results.ValidationProblem(new Dictionary<string, string[]> { ["layout"] = [error] }));
app.MapPut("/api/s7/simulation/tags/{address}", (string address, SimulationTagWriteRequest request, S7TagStore store) =>
{
    var result = store.TrySetSimulationValue(address, request.Value);
    return result.Succeeded
        ? Results.Ok(result.Tag)
        : Results.Json(new { message = result.Error }, statusCode: result.StatusCode);
});
app.MapPost("/api/s7/commands", async (S7CommandRequest request, S7TagStore store, CancellationToken cancellationToken) =>
{
    var result = await store.TryCommandAsync(request.Command, request.StationIndex, request.Direction, request.Active, cancellationToken);
    return result.Succeeded
        ? Results.Ok(result.Tag)
        : Results.Json(new { message = result.Error }, statusCode: result.StatusCode);
});

app.Run();

public sealed record S7CommandRequest(string Command, int? StationIndex = null, string? Direction = null, bool Active = true);
public sealed record SimulationTagWriteRequest(string Value);
