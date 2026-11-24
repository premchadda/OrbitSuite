/** Match ESM CLI entrypoints on Windows and POSIX, including paths with spaces. */
import {fileURLToPath} from 'node:url';
import {posix, win32} from 'node:path';

export function isDirectEntrypoint(moduleUrl, argument = process.argv[1], platform = process.platform) {
  if (typeof argument !== 'string' || argument.length === 0) return false;
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;
  const file = paths.resolve(fileURLToPath(moduleUrl, {windows}));
  const entry = paths.resolve(argument);
  return windows ? file.toLowerCase() === entry.toLowerCase() : file === entry;
}
