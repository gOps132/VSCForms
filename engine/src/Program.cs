using System.Text;
using Microsoft.CodeAnalysis.Text;

namespace VSCForms.Engine;

/// <summary>
/// Long-lived stdio process. One JSON request per line in, one JSON response per line out.
///
/// STDOUT IS A PROTOCOL CHANNEL. Nothing but responses may ever be written to it — all
/// diagnostics go to stderr. This is the classic way this kind of tool silently corrupts
/// its own stream, so it is called out explicitly.
/// </summary>
public static class Program
{
    public static int Main()
    {
        var stdout = Console.OpenStandardOutput();
        var stdin = Console.OpenStandardInput();
        var stderr = Console.Error;

        using var reader = new StreamReader(stdin, new UTF8Encoding(false));
        using var writer = new StreamWriter(stdout) { AutoFlush = true, NewLine = "\n" };

        Log(stderr, $"vscforms-engine ready ({typeof(Program).Assembly.GetName().Version})");

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            Request? req = null;
            Response res;
            try
            {
                req = Json.Deserialize<Request>(line)
                    ?? throw new DesignException("Malformed request", "bad-request");

                res = Handle(req, stderr);
            }
            catch (DesignException ex)
            {
                res = new Response { Id = req?.Id ?? -1, Ok = false, Error = ex.Message, ErrorKind = ex.Kind };
            }
            catch (Exception ex)
            {
                Log(stderr, $"ERROR {ex.GetType().Name}: {ex.Message}");
                res = new Response { Id = req?.Id ?? -1, Ok = false, Error = ex.Message, ErrorKind = "internal" };
            }

            writer.WriteLine(Json.Serialize(res));
        }

        return 0;
    }

    private static Response Handle(Request req, TextWriter stderr)
    {
        switch (req.Cmd)
        {
            case "ping":
                return new Response { Id = req.Id, Ok = true };

            case "parse":
            {
                if (string.IsNullOrEmpty(req.Path)) throw new DesignException("path is required", "bad-request");
                if (!File.Exists(req.Path)) throw new DesignException($"File not found: {req.Path}", "not-found");

                // Read as BYTES, not with File.ReadAllText: that overload strips a UTF-8 BOM, which
                // would silently change the first line of the file on every single edit and
                // break the "every other byte is identical" guarantee.
                var bytes = File.ReadAllBytes(req.Path);
                bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
                var source = SourceText.From(
                    bom ? System.Text.Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3)
                        : System.Text.Encoding.UTF8.GetString(bytes));
                var doc = DesignerDocument.Parse(source);
                Log(stderr, $"parsed {req.Path}: {doc.Schema.Analysis.ModelledCount} modelled, "
                          + $"{doc.Schema.Analysis.UnmodelledCount} unmodelled, "
                          + $"{doc.Schema.Analysis.CoveragePercent}% coverage");

                return new Response { Id = req.Id, Ok = true, Schema = doc.Schema };
            }

            case "generate":
            {
                if (string.IsNullOrEmpty(req.Path)) throw new DesignException("path is required", "bad-request");
                if (req.Schema is null) throw new DesignException("schema is required", "bad-request");
                if (!File.Exists(req.Path)) throw new DesignException($"File not found: {req.Path}", "not-found");

                var bytes = File.ReadAllBytes(req.Path);
                bool bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
                var source = SourceText.From(
                    bom ? System.Text.Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3)
                        : System.Text.Encoding.UTF8.GetString(bytes));
                var result = Patcher.Apply(source, req.Schema);

                if (result.Refusal is not null)
                {
                    Log(stderr, $"REFUSED {req.Path}: {result.Refusal}");
                    return new Response
                    {
                        Id = req.Id, Ok = false, Changed = false,
                        Error = result.Refusal, ErrorKind = "refused",
                    };
                }

                if (!result.Changed)
                {
                    Log(stderr, $"no-op for {req.Path}");
                    return new Response { Id = req.Id, Ok = true, Changed = false };
                }

                // Write only when something actually changed, so dirty-state accounting
                // stays honest and undo/redo does not accumulate empty steps.
                // Write bytes, re-adding the BOM if the original had one.
                //
                // NOTE: `new UTF8Encoding(false).GetPreamble()` is EMPTY — the preamble is only
                // produced when the encoder is constructed to emit it. Emitting the literal
                // bytes is clearer than toggling the flag and then having to remember which
                // constructor does what.
                var outText = result.Text!;
                var body = new UTF8Encoding(false).GetBytes(outText);
                File.WriteAllBytes(req.Path,
                    bom ? new byte[] { 0xEF, 0xBB, 0xBF }.Concat(body).ToArray() : body);
                Log(stderr, $"wrote {req.Path}: {result.Changes.Count} surgical change(s)");
                return new Response { Id = req.Id, Ok = true, Changed = true };
            }

            default:
                throw new DesignException($"Unknown command '{req.Cmd}'", "bad-request");
        }
    }

    private static void Log(TextWriter w, string msg)
    {
        w.WriteLine($"[vscforms-engine] {msg}");
        w.Flush();
    }
}