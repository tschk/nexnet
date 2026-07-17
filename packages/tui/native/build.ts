const result = Bun.spawnSync([
  "swiftc",
  "-parse-as-library",
  "-framework",
  "AppKit",
  "-framework",
  "AuthenticationServices",
  "passkey.swift",
  "-o",
  "nexnet-passkey",
], { cwd: import.meta.dir });

if (!result.success) {
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
