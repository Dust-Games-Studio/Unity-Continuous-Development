/**
 * The host Unity is running on. `hostPlatform()` normalises
 * `process.platform`; the mapping functions take it explicitly so a cross-build
 * decision is testable and never depends on the machine that runs the test.
 */
export type HostPlatform = 'windows' | 'macos' | 'linux';

export function hostPlatform(): HostPlatform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      // Unity's CLI supports Linux; every other POSIX platform is treated as
      // Linux for module selection (the safest cross-build assumption).
      return 'linux';
  }
}

type HostModules = Readonly<Record<HostPlatform, readonly string[]>>;

/**
 * The Hub module ids a build target needs **on a given host**.
 *
 * A native standalone build needs no player module (`[]`); the same player
 * cross-built from another host needs the target's build-support module. The
 * ids are the lowercase `id` values from
 * `unity install <version> --list-modules --format json` — never the display
 * names from `unity editors --installed` (a different namespace).
 */
function freezeTable(
  table: Record<string, Record<HostPlatform, string[]>>,
): Readonly<Record<string, HostModules>> {
  for (const hosts of Object.values(table)) {
    for (const ids of Object.values(hosts)) Object.freeze(ids);
    Object.freeze(hosts);
  }
  return Object.freeze(table);
}

const BUILD_TARGET_MODULES: Readonly<Record<string, HostModules>> = freezeTable({
  // Native on Windows; cross-built with the Windows IL2CPP player on the
  // other hosts (the toolkit's default target is run on Linux CI).
  StandaloneWindows64: {
    windows: [],
    macos: ['windows-il2cpp'],
    linux: ['windows-il2cpp'],
  },
  StandaloneLinux64: {
    windows: ['linux-il2cpp'],
    macos: ['linux-il2cpp'],
    linux: [],
  },
  // A macOS player needs a macOS host; the Mac build support module is still
  // required there.
  StandaloneOSX: { windows: [], macos: ['mac-mono'], linux: [] },
  Android: {
    windows: ['android', 'android-sdk-ndk-tools'],
    macos: ['android', 'android-sdk-ndk-tools'],
    linux: ['android', 'android-sdk-ndk-tools'],
  },
  iOS: { windows: [], macos: ['ios'], linux: [] },
  WebGL: { windows: ['webgl'], macos: ['webgl'], linux: ['webgl'] },
  tvOS: { windows: [], macos: ['appletv'], linux: [] },
  visionOS: { windows: [], macos: ['visionos'], linux: [] },
  WindowsStoreApps: {
    windows: ['universal-windows-platform'],
    macos: ['universal-windows-platform'],
    linux: ['universal-windows-platform'],
  },
  LinuxServer: {
    windows: ['linux-server'],
    macos: ['linux-server'],
    linux: ['linux-server'],
  },
  MacServer: { windows: [], macos: ['mac-server'], linux: [] },
});

/** Targets whose player can only be built on macOS. */
const MAC_ONLY_TARGETS: ReadonlySet<string> = new Set([
  'StandaloneOSX',
  'iOS',
  'tvOS',
  'visionOS',
  'MacServer',
]);

/**
 * A copy, so a caller cannot mutate the table through the returned array. An
 * unknown target, or a host/target combination that cannot be built, returns
 * `[]`: the caller then checks only the Editor version, as the spec prescribes.
 */
export function modulesForBuildTarget(
  target: string,
  host: HostPlatform,
): string[] {
  return [...(BUILD_TARGET_MODULES[target]?.[host] ?? [])];
}

/**
 * No test mode needs a platform module today: the Editor's test runner ships
 * with the Editor itself, so `EditMode` and `PlayMode` both return `[]`. Add
 * ids here if a future mode ever needs one.
 */
export function modulesForTestMode(mode: string): string[] {
  return [];
}

/**
 * Whether a build target can be produced on this host at all.
 *
 * Windows, Linux, Android and WebGL players can be built from Windows, macOS
 * or Linux. A macOS player, and iOS/tvOS/visionOS (which also need Xcode), can
 * only be built on macOS. An unknown target is left to the Editor.
 */
export function isBuildTargetSupportedOnHost(
  target: string,
  host: HostPlatform,
): { supported: boolean; reason?: string } {
  if (!MAC_ONLY_TARGETS.has(target)) return { supported: true };
  if (host === 'macos') return { supported: true };
  return {
    supported: false,
    reason: `${target} requires a macOS host (this host is ${host})`,
  };
}
