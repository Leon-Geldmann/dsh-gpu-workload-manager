import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repository = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const verifier = join(repository, 'deploy/scripts/verify-live.sh');

describe('read-only live verifier', () => {
  it('documents its two host roles and rejects an unknown role', async () => {
    const help = spawnSync(verifier, ['--help'], { encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--role ubuntu|mac');
    expect(help.stdout).toContain('--dsh-only');
    expect(help.stdout).toContain('--system-only');
    expect(help.stdout).toContain('read-only');

    const invalid = spawnSync(verifier, ['--role', 'other'], { encoding: 'utf8' });
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).toContain('role_must_be_ubuntu_or_mac');
  });

  it('contains no service mutation, secret transport, or broad deletion path', async () => {
    const source = await readFile(verifier, 'utf8');
    expect(source).not.toMatch(/systemctl[^\n]*(?:start|stop|restart|enable|disable|daemon-reload)/);
    expect(source).not.toMatch(/^\s*(?:sudo\s+)?(?:rm|mv|cp|install|chmod|chown)\b/m);
    expect(source).not.toMatch(/(?:curl|wget)[^\n]*(?:management\.key|inference\.key|Authorization|Bearer)/i);
    expect(source).not.toMatch(/(?:echo|printf)[^\n]*(?:KEY|TOKEN|SECRET|CREDENTIALS_DIRECTORY)/i);
    expect(source).toContain('management.key');
    expect(source).toContain("const raw = readFileSync(file, 'utf8')");
    expect(source).toContain("systemctl_bin=\"$system_root/usr/bin/systemctl\"");
    expect(source).toContain("ss_bin=\"$system_root/usr/bin/ss\"");
    expect(source).toContain("ufw_bin=\"$system_root/usr/sbin/ufw\"");
    expect(source).toContain("PATH='/usr/sbin:/usr/bin:/sbin:/bin'");
  });
});
