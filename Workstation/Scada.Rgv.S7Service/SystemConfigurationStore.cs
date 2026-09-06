using System.Text.Json;
using System.Net;

namespace Scada.Rgv.S7Service;

public sealed class SystemConfigurationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _lock = new();
    private readonly string _filePath;
    private SystemConfiguration _configuration;

    public SystemConfigurationStore(AppDataPaths paths, IConfiguration configuration, ILogger<SystemConfigurationStore> logger)
    {
        _filePath = paths.SystemConfigurationPath;
        _configuration = Load(configuration, logger);
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
        if (!IPAddress.TryParse(configuration.ServerIp, out _))
        {
            saved = _configuration;
            error = "服务器 IP 地址格式不正确。";
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
            return TrySave(_configuration with { MaxPos = maxPos }, out _, out _);
        }
    }

    private SystemConfiguration Load(IConfiguration configuration, ILogger logger)
    {
        var stationOverride = int.TryParse(configuration["SCADA_STATION_NUMBER"], out var configuredStation)
            && configuredStation is >= 1 and <= 40
            ? configuredStation
            : (int?)null;
        var serverIpOverride = IPAddress.TryParse(configuration["MES_SERVER_IP"], out _)
            ? configuration["MES_SERVER_IP"]
            : null;
        try
        {
            if (File.Exists(_filePath))
            {
                var stored = JsonSerializer.Deserialize<StoredSystemConfiguration>(File.ReadAllText(_filePath), JsonOptions);
                var stationNumber = stationOverride ?? (stored?.StationNumber is >= 1 and <= 40
                    ? stored.StationNumber.Value
                    : stored?.StationNumbers?.FirstOrDefault() is >= 1 and <= 40
                        ? stored.StationNumbers.First()
                        : 1);
                var maxPos = stored?.MaxPos is >= 1 and <= 48 ? stored.MaxPos.Value : 18;
                return Normalize(new SystemConfiguration(stationNumber, serverIpOverride ?? stored?.ServerIp ?? "127.0.0.1", stored?.IsInterfaceFlipped ?? false, maxPos, stored?.OpRows));
            }
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "System configuration file is invalid; using defaults.");
        }

        return Normalize(new SystemConfiguration(stationOverride ?? 1, serverIpOverride ?? "127.0.0.1", false, 18, null));
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
}

public sealed record SystemConfiguration(int StationNumber, string ServerIp = "127.0.0.1", bool IsInterfaceFlipped = false, int MaxPos = 20, IReadOnlyDictionary<int, bool>? OpRows = null);
public sealed record StoredSystemConfiguration(int? StationNumber, IReadOnlyList<int>? StationNumbers, string? ServerIp, bool IsInterfaceFlipped, int? MaxPos, IReadOnlyDictionary<int, bool>? OpRows);
