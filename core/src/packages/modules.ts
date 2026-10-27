/**
 * The Hub module ids a given build target needs.
 *
 * The ids are the lowercase `id` values from
 * `unity install <version> --list-modules --format json` — never the display
 * names from `unity editors --installed` (a different namespace). A target
 * that needs no extra module maps to an empty list, and an unknown target also
 * maps to an empty list: the caller then checks only the Editor version, which
 * is what the spec prescribes.
 */
export const BUILD_TARGET_MODULES: Record<string, string[]> = {
  StandaloneWindows64: [],
  // IL2CPP is the modern default backend for standalone Linux.
  StandaloneLinux64: ['linux-il2cpp'],
  StandaloneOSX: ['mac-mono'],
  Android: ['android', 'android-sdk-ndk-tools'],
  iOS: ['ios'],
  WebGL: ['webgl'],
  tvOS: ['appletv'],
  visionOS: ['visionos'],
  WindowsStoreApps: ['universal-windows-platform'],
  LinuxServer: ['linux-server'],
  MacServer: ['mac-server'],
};

/** A copy, so a caller cannot mutate the table through the returned array. */
export function modulesForBuildTarget(target: string): string[] {
  return [...(BUILD_TARGET_MODULES[target] ?? [])];
}

/**
 * A test run needs no platform module: the Editor's test runner is part of the
 * Editor itself. Both supported modes return an empty list, and so does an
 * unknown mode.
 */
export function modulesForTestMode(mode: string): string[] {
  return [];
}
