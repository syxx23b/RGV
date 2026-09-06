using System.Text.Json;

namespace Scada.Rgv.S7Service;

public sealed class SystemConfigurationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _lock = new();
    private readonly string _filePath;
    private SystemConfiguration _configuration;

    public SystemConfigurationStore(AppDataPaths paths, ILogger<SystemConfigurationStore> logger)
    {
        _filePath = paths.SystemConfigurationPath;
        _configuration = ApplyEnvironmentOverrides(Load(logger));
    }

    public SystemConfiguration Read()
    {
        lock (_lock) return _configuration;
    }

    public bool TrySave(SystemConfiguration configuration, out SystemConfiguration saved, out string error)
    {
        if (configuration.StationNumber is < 1 or > 40)
        {
            saved = _configuration;
            error = "工位编号必须为 1 至 40 之间的数字。";
            return false;
        }

        saved = Normalize(configuration with { OpRows = configuration.OpRows ?? _configuration.OpRows });
        try
        {
            lock (_lock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
                var temporaryPath = $"{_filePath}.tmp";
                File.WriteAllText(temporaryPath, JsonSerializer.Serialize(saved, JsonOptions));
                File.Move(temporaryPath, _filePath, true);
                _configuration = saved;
            }
            error = string.Empty;
            return true;
        }
        catch (IOException ex)
        {
            saved = _configuration;
            error = $"无法保存系统配置：{ex.Message}";
            return false;
        }
    }

    public bool TrySaveMaxPos(int maxPos)
    {
        if (maxPos is < 1 or > 48) return false;
        lock (_lock)
        {
            return TrySave(new SystemConfiguration(_configuration.StationNumber, _configuration.IsInterfaceFlipped, maxPos, _configuration.OpRows), out _, out _);
        }
    }

    private SystemConfiguration Load(ILogger logger)
    {
        try
        {
            if (File.Exists(_filePath))
            {
                var stored = JsonSerializer.Deserialize<StoredSystemConfiguration>(File.ReadAllText(_filePath), JsonOptions);
                var stationNumber = stored?.StationNumber is >= 1 and <= 40
                    ? stored.StationNumber.Value
                    : stored?.StationNumbers?.FirstOrDefault() is >= 1 and <= 40
                        ? stored.StationNumbers.First()
                        : 1;
                var maxPos = stored?.MaxPos is >= 1 and <= 48 ? stored.MaxPos.Value : 18;
                return Normalize(new SystemConfiguration(stationNumber, stored?.IsInterfaceFlipped ?? false, maxPos, stored?.OpRows));
            }
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "System configuration file is invalid; using defaults.");
        }

        return Normalize(new SystemConfiguration(1, false, 18, null));
    }

    private static SystemConfiguration Normalize(SystemConfiguration configuration)
    {
        var maxPos = Math.Clamp(configuration.MaxPos, 1, 48);
        var rows = configuration.OpRows?
            .Where(entry => entry.Key >= 1 && entry.Key <= maxPos)
            .ToDictionary(entry => entry.Key, entry => entry.Value)
            ?? new Dictionary<int, bool>();
        return configuration with { MaxPos = maxPos, OpRows = rows };
    }

    private static SystemConfiguration ApplyEnvironmentOverrides(SystemConfiguration configuration)
    {
        var stationNumber = int.TryParse(Environment.GetEnvironmentVariable("SCADA_STATION_NUMBER"), out var station)
            ? station
            : configuration.StationNumber;
        var maxPos = int.TryParse(Environment.GetEnvironmentVariable("SCADA_MAX_POS"), out var max)
            ? max
            : configuration.MaxPos;
        return Normalize(configuration with { StationNumber = stationNumber, MaxPos = maxPos });
    }
}

public sealed record SystemConfiguration(int StationNumber, bool IsInterfaceFlipped, int MaxPos = 18, IReadOnlyDictionary<int, bool>? OpRows = null);
public sealed record StoredSystemConfiguration(int? StationNumber, IReadOnlyList<int>? StationNumbers, bool IsInterfaceFlipped, int? MaxPos, IReadOnlyDictionary<int, bool>? OpRows);
