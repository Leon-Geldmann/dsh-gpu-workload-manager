import { fstatSync } from 'node:fs';
import type { StdioOptions } from 'node:child_process';

export function credentialStdio(credentialFd: number): StdioOptions {
  if (!Number.isSafeInteger(credentialFd) || credentialFd < 0) throw new Error('invalid_credential_fd');
  fstatSync(credentialFd);
  const stdio: ['ignore', 'pipe', 'pipe', number] = ['ignore', 'pipe', 'pipe', credentialFd];
  if (stdio.length !== 4 || stdio[3] !== credentialFd) throw new Error('credential_fd_not_child_fd_3');
  return stdio;
}
