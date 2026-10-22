import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

// Support portable Git installations as well as the standard Windows installer.
export function testBash() {
  const candidates = [process.env.SHELLPILOT_TEST_BASH,
    ...(process.env.PATH ?? '').split(delimiter).flatMap(directory => [resolve(directory, '../bin/bash.exe'), resolve(directory, 'bash.exe')]),
    'C:/Program Files/Git/bin/bash.exe'];
  const executable = candidates.find(path => path && existsSync(path) && !/windows[\\/]system32/i.test(path));
  if (!executable) throw new Error('Git Bash is required for shell integration tests; set SHELLPILOT_TEST_BASH.');
  return executable;
}
