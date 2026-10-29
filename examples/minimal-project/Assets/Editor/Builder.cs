using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

/// <summary>
/// The example's build entry point, invoked by `unity build --execute-method
/// Builder.PerformBuild`. The CLI forwards `--output-path` as `-buildOutput`
/// and the caller-owned method is responsible for honouring it.
///
/// The class deliberately lives in the global namespace: Unity resolves
/// `-executeMethod` against the type name, and `Builder.PerformBuild` is what
/// the CLI's own documentation uses.
/// </summary>
public static class Builder
{
    /// <summary>Unity's own flag; the CLI forwards `--output-path` as this.</summary>
    private const string BuildOutputArgument = "-buildOutput";

    /// <summary>The CLI forwards `--target` as `-buildTarget`.</summary>
    private const string BuildTargetArgument = "-buildTarget";

    public static void PerformBuild()
    {
        string[] scenes = EditorBuildSettings.scenes
            .Where(scene => scene.enabled)
            .Select(scene => scene.path)
            .ToArray();

        if (scenes.Length == 0)
        {
            throw new BuildFailedException(
                "No enabled scenes in EditorBuildSettings; nothing to build. "
                + "Add a scene to Build Settings and try again.");
        }

        string outputPath = ResolveOutputPath();
        string outputDirectory = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(outputDirectory))
        {
            Directory.CreateDirectory(outputDirectory);
        }

        BuildTarget target = ResolveBuildTarget();
        Debug.Log(
            $"Building {target} with {scenes.Length} scene(s) to {outputPath}: "
            + string.Join(", ", scenes));

        BuildReport report = BuildPipeline.BuildPlayer(
            scenes, outputPath, target, BuildOptions.None);

        if (report.summary.result != BuildResult.Succeeded)
        {
            // Returning quietly here would turn a failed build green.
            throw new BuildFailedException(
                $"Build {report.summary.result} for {target}: "
                + $"{report.summary.totalErrors} error(s) and "
                + $"{report.summary.totalWarnings} warning(s). "
                + $"Scenes: {string.Join(", ", scenes)}. Output: {outputPath}");
        }

        Debug.Log($"Build succeeded: {outputPath}");
    }

    /// <summary>
    /// `-buildOutput &lt;path&gt;` (or `-buildOutput=&lt;path&gt;`) when the CLI
    /// supplies one, otherwise `Build/&lt;target&gt;/game` under the project root.
    /// </summary>
    private static string ResolveOutputPath()
    {
        string fromCommandLine = CommandLineValue(BuildOutputArgument);
        if (!string.IsNullOrEmpty(fromCommandLine))
        {
            return Path.GetFullPath(fromCommandLine);
        }

        string targetFolder = ResolveBuildTarget().ToString();
        return Path.Combine(ProjectRoot(), "Build", targetFolder, "game");
    }

    /// <summary>
    /// The build target the CLI asked for, falling back to the target selected
    /// in the Editor. A plain batch run has no `-buildTarget` argument.
    /// </summary>
    private static BuildTarget ResolveBuildTarget()
    {
        string requested = CommandLineValue(BuildTargetArgument);
        if (!string.IsNullOrEmpty(requested))
        {
            try
            {
                return (BuildTarget)Enum.Parse(typeof(BuildTarget), requested, true);
            }
            catch (ArgumentException)
            {
                throw new BuildFailedException(
                    $"Unrecognised {BuildTargetArgument} value '{requested}'.");
            }
        }

        return EditorUserBuildSettings.activeBuildTarget;
    }

    /// <summary>The project root: the parent of the Assets directory.</summary>
    private static string ProjectRoot()
    {
        return Directory.GetParent(Application.dataPath).FullName;
    }

    /// <summary>
    /// Reads a `-flag value` (or `-flag=value`) pair from the Editor's own
    /// command line. Returns null when the flag is absent or has no value.
    /// </summary>
    private static string CommandLineValue(string flag)
    {
        string[] arguments = Environment.GetCommandLineArgs();
        List<string> values = new List<string>();

        for (int index = 0; index < arguments.Length; index++)
        {
            string argument = arguments[index];
            if (string.Equals(argument, flag, StringComparison.OrdinalIgnoreCase))
            {
                if (index + 1 < arguments.Length)
                {
                    values.Add(arguments[index + 1]);
                }
            }
            else if (argument.StartsWith(flag + "=", StringComparison.OrdinalIgnoreCase))
            {
                values.Add(argument.Substring(flag.Length + 1));
            }
        }

        // The last occurrence wins, mirroring how Unity resolves repeated flags.
        return values.Count == 0 ? null : values[values.Count - 1];
    }
}
