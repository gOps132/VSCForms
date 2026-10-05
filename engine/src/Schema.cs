using System.Text.Json;
using System.Text.Json.Serialization;

namespace VSCForms.Engine;

/// <summary>Data transfer objects for the Form Schema. See SCHEMA.md — this file implements it.</summary>
public sealed class FormSchema
{
    [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; set; } = 1;
    [JsonPropertyName("form")] public required FormInfo Form { get; set; }
    [JsonPropertyName("controls")] public required List<ControlNode> Controls { get; set; }
    [JsonPropertyName("analysis")] public required Analysis Analysis { get; set; }
}

public sealed class FormInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("text")] public string Text { get; set; } = "";
    [JsonPropertyName("clientSize")] public required SizeDto ClientSize { get; set; }
    [JsonPropertyName("className")] public string ClassName { get; set; } = "";
}

public sealed class SizeDto
{
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
}

public sealed class PointDto
{
    [JsonPropertyName("x")] public int X { get; set; }
    [JsonPropertyName("y")] public int Y { get; set; }
}

public sealed class ControlNode
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("children")] public List<ControlNode> Children { get; set; } = new();
    [JsonPropertyName("properties")] public required ControlProperties Properties { get; set; } = new();
    [JsonPropertyName("locked")] public bool Locked { get; set; }
    [JsonPropertyName("lockedReason")] public string? LockedReason { get; set; }
}

public sealed class ControlProperties
{
    // geometry — always present, always modelled
    [JsonPropertyName("x")] public int X { get; set; }
    [JsonPropertyName("y")] public int Y { get; set; }
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }

    // appearance — present only for un-locked controls
    [JsonPropertyName("text")] public string? Text { get; set; }
    [JsonPropertyName("tabIndex")] public int? TabIndex { get; set; }
    [JsonPropertyName("backColor")] public string? BackColor { get; set; }
    [JsonPropertyName("visible")] public bool? Visible { get; set; }
    [JsonPropertyName("enabled")] public bool? Enabled { get; set; }
    [JsonPropertyName("font")] public FontDto? Font { get; set; }
}

public sealed class FontDto
{
    [JsonPropertyName("size")] public float Size { get; set; }
    [JsonPropertyName("bold")] public bool Bold { get; set; }
    [JsonPropertyName("italic")] public bool Italic { get; set; }
    [JsonPropertyName("family")] public string? Family { get; set; }
}

public sealed class Analysis
{
    [JsonPropertyName("modelledCount")] public int ModelledCount { get; set; }
    [JsonPropertyName("unmodelledCount")] public int UnmodelledCount { get; set; }
    [JsonPropertyName("coveragePercent")] public double CoveragePercent { get; set; }
    [JsonPropertyName("refuses")] public List<string> Refuses { get; set; } = new();
    [JsonPropertyName("warnings")] public List<string> Warnings { get; set; } = new();
}

/// <summary>One engine request/response envelope over stdio. Newline-delimited JSON.</summary>
public sealed class Request
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("cmd")] public string Cmd { get; set; } = "";
    [JsonPropertyName("path")] public string? Path { get; set; }
    [JsonPropertyName("schema")] public FormSchema? Schema { get; set; }

    // `new` only. `name` is a C# identifier; `parent` is an existing or creatable directory.
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("parent")] public string? Parent { get; set; }
    [JsonPropertyName("template")] public string? Template { get; set; }
    [JsonPropertyName("language")] public string? Language { get; set; }
}

public sealed class Response
{
    [JsonPropertyName("id")] public int Id { get; set; }
    [JsonPropertyName("ok")] public bool Ok { get; set; }
    [JsonPropertyName("schema")] public FormSchema? Schema { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("errorKind")] public string? ErrorKind { get; set; }
    [JsonPropertyName("changed")] public bool? Changed { get; set; }

    // `new` only. `designer` is "" for templates with no Designer file (e.g. winformslib).
    [JsonPropertyName("projectDir")] public string? ProjectDir { get; set; }
    [JsonPropertyName("solution")] public string? Solution { get; set; }
    [JsonPropertyName("designer")] public string? Designer { get; set; }
    [JsonPropertyName("windowsTargetingAdded")] public bool? WindowsTargetingAdded { get; set; }
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = null, // attributes are explicit
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
}