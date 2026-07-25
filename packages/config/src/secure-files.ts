import { randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ConfigError } from "./errors.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export function assertPathInside(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const offset = relative(resolvedRoot, resolvedCandidate);
  if (!isContainedOffset(offset)) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path escapes configuration root: ${resolvedCandidate}`,
    );
  }
  validateManagedAncestors(resolvedRoot, offset);
}

function validateManagedAncestors(root: string, offset: string): void {
  let currentPath = root;
  let canonicalRoot: string | undefined;
  const components = offset === "" ? [] : offset.split(sep);

  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) {
      currentPath = join(currentPath, components[index]!);
    }

    let stats;
    try {
      stats = lstatSync(currentPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw normalizeFileError("validate managed path", currentPath, error);
    }

    if (stats.isSymbolicLink()) {
      throw new ConfigError(
        "CONFIG_UNSAFE_PATH",
        `Managed path must not contain a symbolic link: ${currentPath}`,
      );
    }

    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(currentPath);
    } catch (error) {
      throw normalizeFileError("canonicalize managed path", currentPath, error);
    }

    if (canonicalRoot === undefined) {
      canonicalRoot = canonicalPath;
    } else if (
      !isContainedOffset(relative(canonicalRoot, canonicalPath))
    ) {
      throw new ConfigError(
        "CONFIG_UNSAFE_PATH",
        `Managed path escapes configuration root: ${canonicalPath}`,
      );
    }
  }
}

function isContainedOffset(offset: string): boolean {
  return (
    offset === "" ||
    (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
}

async function validateManagedPath(
  path: string,
  expected: "directory" | "file",
): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path must not be a symbolic link: ${path}`,
    );
  }
  const matchesType =
    expected === "directory" ? stats.isDirectory() : stats.isFile();
  if (!matchesType) {
    throw new ConfigError(
      "CONFIG_UNSAFE_PATH",
      `Managed path has an unexpected type: ${path}`,
    );
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stats.uid !== process.getuid()
  ) {
    throw new ConfigError(
      "CONFIG_PERMISSION_ERROR",
      `Managed path is not owned by the current user: ${path}`,
    );
  }
}

export async function ensureSensitiveDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    await validateManagedPath(path, "directory");
    if (process.platform !== "win32") {
      await chmod(path, DIRECTORY_MODE);
    }
  } catch (error) {
    throw normalizeFileError("prepare sensitive directory", path, error);
  }
}

export async function readSensitiveJson(path: string): Promise<unknown> {
  try {
    await validateManagedPath(path, "file");
    if (process.platform !== "win32") {
      await chmod(path, FILE_MODE);
    }
    const handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new ConfigError(
        "CONFIG_CORRUPT_STORE",
        `Configuration JSON is invalid: ${path}`,
      );
    }
    throw normalizeFileError("read sensitive JSON", path, error);
  }
}

export async function writeSensitiveJson(
  path: string,
  value: unknown,
): Promise<void> {
  let serializedValue: string;
  try {
    serializedValue = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    throw new ConfigError(
      "CONFIG_IO_ERROR",
      "Failed to serialize sensitive JSON",
    );
  }

  const directory = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await ensureSensitiveDirectory(directory);
    try {
      await validateManagedPath(path, "file");
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    handle = await open(temporaryPath, "wx", FILE_MODE);
    await handle.writeFile(serializedValue, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    if (process.platform !== "win32") {
      await chmod(path, FILE_MODE);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof ConfigError) {
      throw error;
    }
    throw normalizeFileError("write sensitive JSON", path, error);
  }
}

export async function removeSensitiveFile(path: string): Promise<void> {
  try {
    await validateManagedPath(path, "file");
    await unlink(path);
  } catch (error) {
    throw normalizeFileError("remove sensitive file", path, error);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function normalizeFileError(
  action: string,
  path: string,
  error: unknown,
): ConfigError {
  if (error instanceof ConfigError) {
    return error;
  }
  const permissionDenied =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM");
  return new ConfigError(
    permissionDenied ? "CONFIG_PERMISSION_ERROR" : "CONFIG_IO_ERROR",
    `Failed to ${action}: ${path}`,
    { cause: error },
  );
}
