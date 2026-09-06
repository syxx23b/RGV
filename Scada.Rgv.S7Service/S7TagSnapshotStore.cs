using System.Text.Json;

namespace Scada.Rgv.S7Service;

public sealed class S7TagSnapshotStore(AppDataPaths paths, ILogger<S7TagSnapshotStore> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object _lock = new();
    private readonly string _filePath = paths.S7TagSnapshotPath;

    public IReadOnlyDictionary<string, S7TagSnapshot> Read()
    {
        try
        {
            if (!File.Exists(_filePath)) return new Dictionary<string, S7TagSnapshot>(StringComparer.OrdinalIgnoreCase);
            return (JsonSerializer.Deserialize<S7SnapshotDocument>(File.ReadAllText(_filePath), JsonOptions)?.Tags ?? [])
                .ToDictionary(tag => tag.Name, StringComparer.OrdinalIgnoreCase);
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "S7 tag snapshot is invalid; ignoring it.");
            return new Dictionary<string, S7TagSnapshot>(StringComparer.OrdinalIgnoreCase);
        }
        catch (IOException ex)
        {
            logger.LogWarning(ex, "Unable to read S7 tag snapshot.");
            return new Dictionary<string, S7TagSnapshot>(StringComparer.OrdinalIgnoreCase);
        }
    }

    public void Save(IEnumerable<S7Tag> tags)
    {
        var document = new S7SnapshotDocument(DateTimeOffset.UtcNow, tags.Select(tag => new S7TagSnapshot(tag.Name, tag.Value, tag.SourceTimestamp, tag.ServerTimestamp, tag.IsManual)).ToArray());
        try
        {
            lock (_lock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
                var temporaryPath = $"{_filePath}.tmp";
                File.WriteAllText(temporaryPath, JsonSerializer.Serialize(document, JsonOptions));
                File.Move(temporaryPath, _filePath, true);
            }
        }
        catch (IOException ex)
        {
            logger.LogWarning(ex, "Unable to save S7 tag snapshot.");
        }
    }
}

public sealed record S7SnapshotDocument(DateTimeOffset CapturedAt, IReadOnlyList<S7TagSnapshot> Tags);
public sealed record S7TagSnapshot(string Name, string Value, DateTimeOffset? SourceTimestamp, DateTimeOffset? ServerTimestamp, bool IsManual);
