namespace Scada.Rgv.S7Service;

public sealed class AppDataPaths
{
    public AppDataPaths(IConfiguration configuration, IHostEnvironment environment)
    {
        var configuredRoot = configuration["Scada:DataRoot"] ?? configuration["Data:Root"];
        if (!string.IsNullOrWhiteSpace(configuredRoot))
        {
            DataRoot = Path.GetFullPath(configuredRoot, environment.ContentRootPath);
        }
        else if (environment.IsDevelopment())
        {
            DataRoot = Path.Combine(environment.ContentRootPath, "data");
        }
        else
        {
            DataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Scada RGV");
        }
    }

    public string DataRoot { get; }

    public string SystemConfigurationPath => Path.Combine(DataRoot, "system-configuration.json");

    public string TwinLayoutPath => Path.Combine(DataRoot, "digital-twin-layout.json");

    public string S7TagSnapshotPath => Path.Combine(DataRoot, "s7-tag-snapshot.json");
}
