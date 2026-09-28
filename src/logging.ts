import { appendFile, rename, stat } from "node:fs/promises";

import {
  EXTENSION_ID,
  ensurePermissionSystemLogsDirectory,
  getPermissionSystemDebugPath,
  type PermissionSystemExtensionConfig,
} from "./extension-config.js";

export function safeJsonStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue: unknown) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      const obj = currentValue as object;
      if (seen.has(obj)) {
        return "[Circular]";
      }
      seen.add(obj);
    }

    return currentValue;
  });
}

export interface PermissionSystemLogger {
  debug: (event: string, details?: Record<string, unknown>) => string | undefined;
  review: (event: string, details?: Record<string, unknown>) => string | undefined;
  flush: () => Promise<void>;
}

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;

interface PermissionSystemLoggerOptions {
  getConfig: () => PermissionSystemExtensionConfig;
  debugPath?: string;
  ensureLogsDirectory?: () => string | undefined;
  maxLogBytes?: number;
}

export function createPermissionSystemLogger(options: PermissionSystemLoggerOptions): PermissionSystemLogger {
  const getDebugPath = (): string => options.debugPath ?? getPermissionSystemDebugPath();
  const ensureLogsDirectory = options.ensureLogsDirectory ?? (() => ensurePermissionSystemLogsDirectory());
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_LOG_MAX_BYTES;
  let writeQueue: Promise<void> = Promise.resolve();

  const rotateIfOversized = async (path: string): Promise<void> => {
    try {
      const { size } = await stat(path);
      if (size >= maxLogBytes) {
        await rename(path, `${path}.1`);
      }
    } catch {
      // Missing file or a failed rotation must never block logging.
    }
  };

  const enqueueAppend = (path: string, line: string): void => {
    const append = async (): Promise<void> => {
      await rotateIfOversized(path);
      await appendFile(path, `${line}\n`, "utf-8");
    };
    writeQueue = writeQueue.then(append, append);
    void writeQueue.catch(() => {
      // Permission-system logging must never write to stdout/stderr or interrupt permission handling.
    });
  };

  const writeLine = (stream: "debug" | "review", event: string, details: Record<string, unknown>): string | undefined => {
    const path = getDebugPath();
    const directoryError = ensureLogsDirectory();
    if (directoryError) {
      return directoryError;
    }

    try {
      const line = safeJsonStringify({
        timestamp: new Date().toISOString(),
        extension: EXTENSION_ID,
        stream,
        event,
        ...details,
      });
      if (!line) {
        return `Failed to write permission-system ${stream} entry '${path}': event could not be serialized.`;
      }
      enqueueAppend(path, line);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write permission-system ${stream} entry '${path}': ${message}`;
    }
  };

  const debug = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    if (!options.getConfig().debug) {
      return undefined;
    }

    return writeLine("debug", event, details);
  };

  const review = (event: string, details: Record<string, unknown> = {}): string | undefined => {
    return writeLine("review", event, details);
  };

  const flush = (): Promise<void> => writeQueue.catch(() => undefined);

  return { debug, review, flush };
}
