using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using S7.Net;

namespace Scada.Rgv.S7Service;

public sealed class Worker(S7TagStore store, ILogger<Worker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("S7 communication module started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await store.RefreshAsync(stoppingToken);
                await Task.Delay(TimeSpan.FromMilliseconds(50), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "S7 communication cycle failed.");
                store.SetDisconnected(ex.Message);
                await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
            }
        }

        await store.DisconnectAsync(CancellationToken.None);
    }
}

public sealed class S7TagStore
{
    private const int DefaultMaxPos = 18;
    private const int MaxPositionLimit = 48;
    private const int DefaultPort = 102;
    private const int DefaultOpenTimeoutMs = 1500;
    private const int DefaultReconnectInitialDelayMs = 250;
    private const int DefaultReconnectMaxDelayMs = 1500;
    private const int DefaultReconnectFaultThreshold = 8;

    private readonly object _lock = new();
    private readonly SemaphoreSlim _ioGate = new(1, 1);
    private readonly SystemConfigurationStore _configurationStore;
    private readonly S7TagSnapshotStore _snapshotStore;
    private readonly ILogger<S7TagStore> _logger;
    private readonly string _host;
    private readonly int _port;
    private readonly int _rack;
    private readonly int _slot;
    private readonly CpuType _cpuType;
    private readonly int _openTimeoutMs;
    private readonly int _reconnectInitialDelayMs;
    private readonly int _reconnectMaxDelayMs;
    private readonly int _reconnectFaultThreshold;
    private readonly bool _simulation;
    private readonly string _environmentName;
    private Dictionary<string, S7Tag> _tags = new();
    private Plc? _plc;
    private DateTimeOffset? _lastUpdatedAt;
    private DateTimeOffset _nextReconnectAt = DateTimeOffset.MinValue;
    private int _reconnectAttempts;
    private string? _lastError;
    private S7ConnectionState _state = S7ConnectionState.Disconnected;
    private int _stationNumber;
    private int _maxPos;

    public S7TagStore(IConfiguration configuration, IHostEnvironment environment, SystemConfigurationStore configurationStore, S7TagSnapshotStore snapshotStore, ILogger<S7TagStore> logger)
    {
        _configurationStore = configurationStore;
        _snapshotStore = snapshotStore;
        _logger = logger;
        _host = Required(configuration["S7:Host"], "S7:Host");
        _port = ReadInt(configuration, "S7:Port", DefaultPort, 1, 65535);
        _rack = ReadInt(configuration, "S7:Rack", 0, 0, 7);
        _slot = ReadInt(configuration, "S7:Slot", 1, 0, 31);
        _cpuType = ParseCpuType(configuration["S7:CpuType"] ?? "S71500");
        _openTimeoutMs = ReadInt(configuration, "S7:OpenTimeoutMs", DefaultOpenTimeoutMs, 200, 30000);
        _reconnectInitialDelayMs = ReadInt(configuration, "S7:ReconnectInitialDelayMs", DefaultReconnectInitialDelayMs, 100, 60000);
        _reconnectMaxDelayMs = ReadInt(configuration, "S7:ReconnectMaxDelayMs", DefaultReconnectMaxDelayMs, _reconnectInitialDelayMs, 300000);
        _reconnectFaultThreshold = ReadInt(configuration, "S7:ReconnectFaultThreshold", DefaultReconnectFaultThreshold, 1, 1000);
        _environmentName = environment.EnvironmentName;
        _simulation = configuration.GetValue("S7:Simulation", false) &&
            configuration.GetValue("S7:AllowDevelopmentSimulation", false) &&
            environment.IsDevelopment();

        var systemConfiguration = configurationStore.Read();
        if (_simulation)
        {
            _logger.LogWarning("S7 development simulation is enabled; PLC I/O is disabled and values are in-memory only.");
        }
        ApplyConfiguration(systemConfiguration);
        RestoreSnapshot();
    }

    private void SeedSimulationValues()
    {
        foreach (var tag in _tags.Values.ToArray())
        {
            var value = tag.DataType.Equals("Bool", StringComparison.OrdinalIgnoreCase)
                ? tag.Name is "HLG" or "InPos" ? "True" : "False"
                : tag.Name switch
                {
                    "MissionState" => "0",
                    "RGVFrom" => "1",
                    "RGVTo" => "4",
                    "RealTimePos" => "120",
                    "ShuttleState.State" => "2",
                    "ShuttleState.Position" => "120",
                    "MaxPos" => _maxPos.ToString(CultureInfo.InvariantCulture),
                    _ when tag.Name.EndsWith(".Position", StringComparison.OrdinalIgnoreCase) => tag.Name.Contains("[2]", StringComparison.Ordinal) ? "120" : "0",
                    _ => "0",
                };
            _tags[tag.Address] = tag with { Value = value };
        }
    }

    public bool IsConnected
    {
        get { lock (_lock) return _simulation || (_state == S7ConnectionState.Connected && _plc?.IsConnected == true); }
    }

    public void ApplyConfiguration(SystemConfiguration configuration)
    {
        lock (_lock)
        {
            _stationNumber = configuration.StationNumber;
            _maxPos = configuration.MaxPos;
            var previousByName = _tags.Values.ToDictionary(tag => tag.Name, StringComparer.OrdinalIgnoreCase);
            _tags = CreateTags(_stationNumber, _maxPos);
            foreach (var tag in _tags.Values.ToArray())
            {
                if (previousByName.TryGetValue(tag.Name, out var previous))
                {
                    _tags[tag.Address] = tag with
                    {
                        Value = previous.Value,
                        Quality = previous.Quality,
                        SourceTimestamp = previous.SourceTimestamp,
                        ServerTimestamp = previous.ServerTimestamp,
                        LastError = previous.LastError,
                        IsManual = previous.IsManual,
                    };
                }
            }
        }

        if (_simulation)
        {
            SeedSimulationValues();
        }
    }

    public S7Status GetStatus()
    {
        lock (_lock)
        {
            if (_simulation) return new S7Status(true, _state.ToString(), _lastUpdatedAt, null, "Good");
            return new S7Status(IsConnected, _state.ToString(), _lastUpdatedAt, _lastError, IsConnected ? "Good" : (_lastUpdatedAt is null ? "Unknown" : "Stale"));
        }
    }

    public IReadOnlyList<S7Tag> ReadAll()
    {
        lock (_lock) return _tags.Values.OrderBy(tag => tag.Address).ToArray();
    }

    private void RestoreSnapshot()
    {
        var snapshot = _snapshotStore.Read();
        lock (_lock)
        {
            foreach (var tag in _tags.Values.ToArray())
            {
                if (!snapshot.TryGetValue(tag.Name, out var saved)) continue;
                _tags[tag.Address] = tag with { Value = saved.Value, Quality = "Stale", SourceTimestamp = saved.SourceTimestamp, ServerTimestamp = saved.ServerTimestamp, LastError = "已恢复最后一次 S7 快照。", IsManual = saved.IsManual };
            }
        }
    }

    private void SaveSnapshot() => _snapshotStore.Save(ReadAll());

    private void SimulationRefresh()
    {
        lock (_lock)
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var tag in _tags.Values)
            {
                _tags[tag.Address] = tag with
                {
                    Quality = "Good",
                    SourceTimestamp = now,
                    ServerTimestamp = now,
                    LastError = null,
                };
            }
            _lastUpdatedAt = now;
            _lastError = null;
            _state = S7ConnectionState.Connected;
        }
    }

    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (_simulation)
        {
            SimulationRefresh();
            await Task.Delay(TimeSpan.FromMilliseconds(50), cancellationToken);
            return;
        }
        await EnsureConnectedAsync(cancellationToken);
        var tags = ReadAll();
        int? plcMaxPos = null;
        try
        {
            await _ioGate.WaitAsync(cancellationToken);
            try
            {
                var batchValues = await Task.Run(() => ReadBatchValues(tags), cancellationToken);
                foreach (var tag in tags)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!batchValues.TryGetValue(tag.Address, out var rawValue)) continue;
                    if (tag.Name == "MaxPos" && int.TryParse(Convert.ToString(rawValue, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out var maxPos) && maxPos is >= 1 and <= MaxPositionLimit)
                        plcMaxPos = maxPos;
                    var now = DateTimeOffset.UtcNow;
                    UpdateTag(tag.Address, tag with
                    {
                        Value = FormatValue(rawValue, tag.DataType),
                        Quality = "Good",
                        SourceTimestamp = now,
                        ServerTimestamp = now,
                        LastError = null,
                        IsManual = false,
                    });
                }
            }
            finally
            {
                _ioGate.Release();
            }

            if (plcMaxPos is int liveMaxPos && liveMaxPos != _maxPos)
                ApplyConfiguration(_configurationStore.Read() with { MaxPos = liveMaxPos });

            lock (_lock)
            {
                _state = S7ConnectionState.Connected;
                _lastUpdatedAt = DateTimeOffset.UtcNow;
                _lastError = null;
                _reconnectAttempts = 0;
            }
            SaveSnapshot();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            SetDisconnected(ex.Message);
            throw;
        }
    }

    public Task<S7WriteResult> TryCommandAsync(string command, int? stationIndex, string? direction, bool active, CancellationToken cancellationToken)
    {
        if (!IsConnected && !_simulation)
        {
            return Task.FromResult(new S7WriteResult(false, null, "S7 未连接，禁止执行控制命令。", 503));
        }

        var normalizedCommand = command.Trim().ToLowerInvariant();
        string? address = normalizedCommand switch
        {
            "station-select" when stationIndex is >= 1 && stationIndex <= _maxPos => FindAddress($"HMIPosSel[{_stationNumber},{stationIndex}]") ,
            "insure" => FindAddress("Insure"),
            "conveyor" when direction?.Trim().Equals("forward", StringComparison.OrdinalIgnoreCase) == true => FindAddress("ForceC"),
            "conveyor" when direction?.Trim().Equals("reverse", StringComparison.OrdinalIgnoreCase) == true => FindAddress("ForceR"),
            _ => null,
        };

        if (address is null)
        {
            return Task.FromResult(new S7WriteResult(false, null, "控制命令参数无效。", 400));
        }

        if (normalizedCommand == "conveyor" && IsTagEnabled("SBes"))
        {
            return Task.FromResult(new S7WriteResult(false, null, "急停已触发，禁止输送操作。", 409));
        }

        return TryWriteAsync(address, active ? "True" : "False", cancellationToken);
    }

    public S7RuntimeConfiguration GetConfiguration() => new(_host, _port, _rack, _slot, _cpuType.ToString(), _openTimeoutMs, _reconnectInitialDelayMs, _reconnectMaxDelayMs, _reconnectFaultThreshold, _simulation, _environmentName);

    private string? FindAddress(string name)
    {
        lock (_lock) return _tags.Values.FirstOrDefault(tag => tag.Name.Equals(name, StringComparison.OrdinalIgnoreCase))?.Address;
    }

    private bool IsTagEnabled(string name)
    {
        lock (_lock) return _tags.Values.FirstOrDefault(tag => tag.Name.Equals(name, StringComparison.OrdinalIgnoreCase))?.Value.Trim().Equals("true", StringComparison.OrdinalIgnoreCase) == true;
    }

    public async Task<S7WriteResult> TryWriteAsync(string address, string value, CancellationToken cancellationToken)
    {
        S7Tag tag;
        lock (_lock)
        {
            if (!_tags.TryGetValue(NormalizeAddress(address), out tag!))
            {
                return new S7WriteResult(false, null, "标签地址不存在。", 404);
            }

            if (!tag.Access.Equals("ReadWrite", StringComparison.OrdinalIgnoreCase))
            {
                return new S7WriteResult(false, tag, "标签为只读。", 403);
            }
        }

        try
        {
            if (!_simulation) await EnsureConnectedAsync(cancellationToken);
            var typedValue = ConvertValue(value, tag.DataType);
            if (_simulation)
            {
                var now = DateTimeOffset.UtcNow;
                var updated = tag with
                {
                    Value = FormatValue(typedValue, tag.DataType),
                    Quality = "Good",
                    SourceTimestamp = now,
                    ServerTimestamp = now,
                    LastError = null,
                    IsManual = true,
                };
                UpdateTag(tag.Address, updated);
                SaveSnapshot();
                return new S7WriteResult(true, updated, null, 200);
            }

            await _ioGate.WaitAsync(cancellationToken);
            try
            {
                await Task.Run(() => _plc!.Write(NormalizeAddress(tag.Address), typedValue), cancellationToken);
            }
            finally
            {
                _ioGate.Release();
            }

            var completedNow = DateTimeOffset.UtcNow;
            var completed = tag with
            {
                Value = FormatValue(typedValue, tag.DataType),
                Quality = "Good",
                SourceTimestamp = completedNow,
                ServerTimestamp = completedNow,
                LastError = null,
                IsManual = true,
            };
            UpdateTag(tag.Address, completed);
            SaveSnapshot();
            return new S7WriteResult(true, completed, null, 200);
        }
        catch (FormatException ex)
        {
            return new S7WriteResult(false, tag, ex.Message, 400);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            SetDisconnected(ex.Message);
            _logger.LogWarning(ex, "Failed to write Siemens S7 address {Address}.", tag.Address);
            return new S7WriteResult(false, tag with { Quality = "Bad", LastError = ex.Message }, ex.Message, 503);
        }
    }

    public S7WriteResult TrySetSimulationValue(string address, string value)
    {
        if (!_simulation)
        {
            return new S7WriteResult(false, null, "仅开发模拟模式支持手动输入标签值。", 403);
        }

        S7Tag tag;
        lock (_lock)
        {
            if (!_tags.TryGetValue(NormalizeAddress(address), out tag!))
            {
                return new S7WriteResult(false, null, "标签地址不存在。", 404);
            }
        }

        try
        {
            var typedValue = ConvertValue(value, tag.DataType);
            var now = DateTimeOffset.UtcNow;
            var updated = tag with
            {
                Value = FormatValue(typedValue, tag.DataType),
                Quality = "Good",
                SourceTimestamp = now,
                ServerTimestamp = now,
                LastError = null,
                IsManual = true,
            };
            UpdateTag(tag.Address, updated);
            SaveSnapshot();
            return new S7WriteResult(true, updated, null, 200);
        }
        catch (FormatException ex)
        {
            return new S7WriteResult(false, tag, ex.Message, 400);
        }
    }

    public void SetDisconnected(string? error = null)
    {
        lock (_lock)
        {
            _state = _reconnectAttempts >= _reconnectFaultThreshold ? S7ConnectionState.Faulted : S7ConnectionState.Reconnecting;
            _lastError = error;
            _reconnectAttempts++;
            _nextReconnectAt = DateTimeOffset.UtcNow.AddMilliseconds(Math.Min(_reconnectMaxDelayMs, _reconnectInitialDelayMs * Math.Pow(2, Math.Min(_reconnectAttempts - 1, 10))));
            foreach (var tag in _tags.Values)
            {
                _tags[tag.Address] = tag with { Quality = "Stale", LastError = error };
            }
        }

        try
        {
            if (_plc?.IsConnected == true) _plc.Close();
        }
        catch (Exception closeException)
        {
            _logger.LogDebug(closeException, "Ignoring S7 close error after communication failure.");
        }
    }

    public async Task DisconnectAsync(CancellationToken cancellationToken)
    {
        await _ioGate.WaitAsync(cancellationToken);
        try
        {
            if (_plc?.IsConnected == true)
            {
                await Task.Run(() => _plc.Close(), cancellationToken);
            }
        }
        finally
        {
            _ioGate.Release();
            lock (_lock) _state = S7ConnectionState.Disconnected;
        }
    }

    private async Task EnsureConnectedAsync(CancellationToken cancellationToken)
    {
        lock (_lock)
        {
            if (_state == S7ConnectionState.Connected && _plc?.IsConnected == true) return;
            if (DateTimeOffset.UtcNow < _nextReconnectAt)
            {
                throw new InvalidOperationException(_lastError ?? "S7 正在重连，请稍后再试。");
            }
            _state = S7ConnectionState.Connecting;
        }

        await _ioGate.WaitAsync(cancellationToken);
        try
        {
            if (_plc?.IsConnected == true)
            {
                lock (_lock) _state = S7ConnectionState.Connected;
                return;
            }

            _plc = new Plc(_cpuType, _host, _port, (short)_rack, (short)_slot);
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var openTask = Task.Run(() => _plc.Open(), CancellationToken.None);
            var timeoutTask = Task.Delay(_openTimeoutMs, timeoutCts.Token);
            if (await Task.WhenAny(openTask, timeoutTask) != openTask)
            {
                try { _plc.Close(); } catch { }
                throw new TimeoutException($"S7 连接超时（{_openTimeoutMs} ms）。");
            }

            timeoutCts.Cancel();
            await openTask;
            if (!_plc.IsConnected) throw new InvalidOperationException("S7 连接失败。");
            lock (_lock)
            {
                _state = S7ConnectionState.Connected;
                _lastError = null;
                _reconnectAttempts = 0;
                _nextReconnectAt = DateTimeOffset.MinValue;
            }
            _logger.LogInformation("Connected to Siemens S7 at {Host}:{Port}, CPU={Cpu}, rack={Rack}, slot={Slot}.", _host, _port, _cpuType, _rack, _slot);
        }
        catch
        {
            SetDisconnected("S7 连接失败或不可用。");
            throw;
        }
        finally
        {
            _ioGate.Release();
        }
    }

    private Dictionary<string, object> ReadBatchValues(IReadOnlyList<S7Tag> tags)
    {
        var result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        foreach (var group in tags.GroupBy(tag => BatchKey(tag.Address)))
        {
            var parsedTags = group.Select(tag => (tag, parsed: ParseAddress(tag.Address))).ToArray();
            var min = parsedTags.Min(item => item.parsed.offset);
            var max = parsedTags.Max(item => item.parsed.offset + (item.tag.DataType.Contains("16", StringComparison.OrdinalIgnoreCase) ? 2 : 1));
            var parsed = parsedTags[0].parsed;
            var bytes = _plc!.ReadBytes(parsed.type, parsed.db, min, Math.Max(1, max - min));
            foreach (var item in parsedTags)
                result[item.tag.Address] = DecodeValue(bytes, item.parsed.offset - min, item.parsed.bit, item.tag.DataType);
        }
        return result;
    }

    private static (DataType type, int db) BatchKey(string address)
    {
        var parsed = ParseAddress(address);
        return (parsed.type, parsed.db);
    }

    private static (DataType type, int db, int offset, int bit) ParseAddress(string address)
    {
        var normalized = NormalizeAddress(address).ToUpperInvariant();
        var match = Regex.Match(normalized, @"^DB(?<db>\d+)\.DB(?<kind>[XW])(?<offset>\d+)(?:\.(?<bit>\d+))?$|^Q(?<kind2>W)(?<offset2>\d+)$|^Q(?<offset3>\d+)\.(?<bit3>\d+)$");
        if (!match.Success) throw new FormatException($"无法解析 S7 地址：{address}");
        var isDb = match.Groups["db"].Success;
        var offset = int.Parse(isDb ? match.Groups["offset"].Value : (match.Groups["offset2"].Success ? match.Groups["offset2"].Value : match.Groups["offset3"].Value), CultureInfo.InvariantCulture);
        var bitText = isDb ? match.Groups["bit"].Value : match.Groups["bit3"].Value;
        var kind = isDb ? match.Groups["kind"].Value : (match.Groups["kind2"].Success ? "W" : "X");
        return (isDb ? DataType.DataBlock : DataType.Output, isDb ? int.Parse(match.Groups["db"].Value, CultureInfo.InvariantCulture) : 0, offset, kind == "X" ? int.Parse(string.IsNullOrEmpty(bitText) ? "0" : bitText, CultureInfo.InvariantCulture) : -1);
    }

    private static object DecodeValue(byte[] bytes, int offset, int bit, string dataType)
    {
        if (bit >= 0) return (bytes[offset] & (1 << bit)) != 0;
        var value = (ushort)((bytes[offset] << 8) | bytes[offset + 1]);
        return dataType.Contains("Int16", StringComparison.OrdinalIgnoreCase) ? (short)value : value;
    }

    private static Dictionary<string, S7Tag> CreateTags(int stationNumber, int maxPos)
    {
        var tags = new List<S7Tag>
        {
            new("HLR", "Q0.0", "Bool", "RGV", "ReadWrite"),
            new("HLG", "Q0.1", "Bool", "RGV", "ReadWrite"),
            new("HLO", "Q0.2", "Bool", "RGV", "ReadWrite"),
            new("MissionState", "QW124", "UInt16", "RGV", "ReadOnly"),
            new("RGVFrom", "DB3.DBW0", "UInt16", "RGV", "ReadOnly"),
            new("RGVTo", "DB3.DBW2", "UInt16", "RGV", "ReadOnly"),
            new("RealTimePos", "QW122", "UInt16", "RGV", "ReadOnly"),
            new("ShuttleState.State", "DB6.DBW6", "UInt16", "RGV", "ReadOnly"),
            new("ShuttleState.Position", "DB6.DBW8", "UInt16", "RGV", "ReadOnly"),
            new("Mode0EQAuto1EQManual", "DB4.DBX0.0", "Bool", "RGV", "ReadOnly"),
        };

        for (var station = 1; station <= maxPos; station++)
        {
            var offset = 10 + (station - 1) * 4;
            tags.Add(new S7Tag($"StationState[{station}].State", $"DB6.DBW{offset}", "UInt16", "Station", "ReadOnly"));
            tags.Add(new S7Tag($"StationState[{station}].Position", $"DB6.DBW{offset + 2}", "UInt16", "Station", "ReadOnly"));
        }

        for (var index = 1; index <= maxPos; index++)
        {
            tags.Add(new S7Tag($"PH[{index}]", $"DB4.DBX{302 + (index - 1) * 6}.7", "Bool", "RGV", "ReadOnly"));
        }

        return tags.ToDictionary(tag => tag.Address, StringComparer.OrdinalIgnoreCase);
    }

    private void UpdateTag(string address, S7Tag updated)
    {
        lock (_lock) _tags[address] = updated;
    }

    private static string NormalizeAddress(string address)
    {
        var normalized = address.Trim();
        if (normalized.StartsWith('%')) normalized = normalized[1..];
        return normalized;
    }

    private static object ConvertValue(string value, string dataType)
    {
        var normalized = dataType.Trim().ToLowerInvariant();
        if (normalized is "bool" or "boolean") return bool.Parse(value);
        if (normalized.Contains("uint16") || normalized == "word") return ushort.Parse(value, CultureInfo.InvariantCulture);
        if (normalized.Contains("int16") || normalized == "int") return short.Parse(value, CultureInfo.InvariantCulture);
        if (normalized.Contains("uint32") || normalized == "dword") return uint.Parse(value, CultureInfo.InvariantCulture);
        if (normalized.Contains("int32") || normalized == "dint") return int.Parse(value, CultureInfo.InvariantCulture);
        if (normalized.Contains("float") || normalized == "real") return float.Parse(value, CultureInfo.InvariantCulture);
        if (normalized.Contains("double") || normalized == "lreal") return double.Parse(value, CultureInfo.InvariantCulture);
        return value;
    }

    private static string FormatValue(object value, string dataType)
    {
        if (value is bool boolean) return boolean ? "True" : "False";
        return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
    }

    private static CpuType ParseCpuType(string value)
    {
        return value.Trim().ToLowerInvariant() switch
        {
            "1200" or "s7-1200" or "s71200" => CpuType.S71200,
            "1500" or "s7-1500" or "s71500" => CpuType.S71500,
            "300" or "s7-300" or "s7300" => CpuType.S7300,
            "400" or "s7-400" or "s7400" => CpuType.S7400,
            _ => throw new ArgumentException($"不支持的 S7 CPU 类型：{value}。")
        };
    }

    private static int ReadInt(IConfiguration configuration, string key, int fallback, int min, int max)
    {
        var value = configuration.GetValue(key, fallback);
        return Math.Clamp(value, min, max);
    }

    private static string Required(string? value, string key)
    {
        return string.IsNullOrWhiteSpace(value) ? throw new InvalidOperationException($"缺少配置项 {key}。") : value.Trim();
    }
}

public enum S7ConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Faulted,
}

public sealed record S7Status(bool Connected, string State, DateTimeOffset? LastUpdatedAt, string? LastError, string Quality);

public sealed record S7RuntimeConfiguration(string Host, int Port, int Rack, int Slot, string CpuType, int OpenTimeoutMs, int ReconnectInitialDelayMs, int ReconnectMaxDelayMs, int ReconnectFaultThreshold, bool Simulation, string Environment);

public sealed record S7WriteResult(bool Succeeded, S7Tag? Tag, string? Error, int StatusCode);

public sealed record S7Tag(
    string Name,
    string Address,
    string DataType,
    string Group = "RGV",
    string Access = "ReadOnly",
    string Value = "",
    DateTimeOffset? SourceTimestamp = null,
    DateTimeOffset? ServerTimestamp = null,
    string Quality = "Unknown",
    string? LastError = null,
    bool IsManual = false);
