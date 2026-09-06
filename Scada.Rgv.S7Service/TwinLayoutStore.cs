using System.Text.Json;

namespace Scada.Rgv.S7Service;

public sealed class TwinLayoutStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _lock = new();
    private readonly string _filePath;
    private TwinLayoutState _state;

    public TwinLayoutStore(AppDataPaths paths, ILogger<TwinLayoutStore> logger)
    {
        _filePath = paths.TwinLayoutPath;
        _state = Load(logger);
    }

    public TwinLayoutState Read()
    {
        lock (_lock) return _state;
    }

    public bool TrySave(TwinLayoutState state, out TwinLayoutState saved, out string error)
    {
        saved = Normalize(state);
        try
        {
            lock (_lock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
                var temporaryPath = $"{_filePath}.tmp";
                File.WriteAllText(temporaryPath, JsonSerializer.Serialize(saved, JsonOptions));
                File.Move(temporaryPath, _filePath, true);
                _state = saved;
            }

            error = string.Empty;
            return true;
        }
        catch (IOException ex)
        {
            saved = _state;
            error = $"无法保存数字孪生布局：{ex.Message}";
            return false;
        }
    }

    private TwinLayoutState Load(ILogger logger)
    {
        try
        {
            if (File.Exists(_filePath))
            {
                var stored = JsonSerializer.Deserialize<TwinLayoutState>(File.ReadAllText(_filePath), JsonOptions);
                return Normalize(stored ?? TwinLayoutState.Default);
            }
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "Twin layout file is invalid; using defaults.");
        }

        return TwinLayoutState.Default;
    }

    private static TwinLayoutState Normalize(TwinLayoutState? state)
    {
        var source = state ?? TwinLayoutState.Default;
        var stations = source.StationRelativeX?
            .Where(entry => entry.Key.StartsWith("OP", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(entry => entry.Key.Trim().ToUpperInvariant(), entry => ClampRelativeX(entry.Value))
            ?? new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        return source with
        {
            SchemaVersion = 1,
            CarRelativeX = ClampRelativeX(source.CarRelativeX),
            StationRelativeX = stations,
        };
    }

    private static int ClampRelativeX(int value) => Math.Max(0, Math.Min(950, value));
}

public sealed record TwinLayoutState
{
    public static TwinLayoutState Default { get; } = new(1, 870, new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase));

    public TwinLayoutState(int schemaVersion, int carRelativeX, IReadOnlyDictionary<string, int>? stationRelativeX)
    {
        SchemaVersion = schemaVersion;
        CarRelativeX = carRelativeX;
        StationRelativeX = stationRelativeX;
    }

    public int SchemaVersion { get; init; }
    public int CarRelativeX { get; init; }
    public IReadOnlyDictionary<string, int>? StationRelativeX { get; init; }
}
