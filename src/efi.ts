import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export interface BootEntry {
  /** Short display name (before the first tab in efibootmgr output). */
  name: string;
  /** Full description including device path, suitable for settings page. */
  full: string;
}

/**
 * Check whether the efibootmgr binary is available on this system.
 */
export function checkEfibootmgr(): boolean {
  return GLib.find_program_in_path('efibootmgr') !== null;
}

/**
 * Parse the output of `efibootmgr` to extract boot entries.
 * Returns a Map of BootNNNN → { name, full }.
 *
 * efibootmgr output example:
 *   Boot0001* Linux Boot Manager\tHD(1,GPT,...)/File(\EFI\systemd\systemd-bootx64.efi)
 *   Boot0002* Windows Boot Manager\tHD(1,GPT,...)/File(\EFI\Microsoft\Boot\bootmgfw.efi)
 *
 * `name` is the short label (before the tab) — used in the power menu.
 * `full` is the complete line — shown in the settings page for identification.
 */
export async function getBootEntries(): Promise<Map<string, BootEntry>> {
  const proc = Gio.Subprocess.new(
    ['efibootmgr'],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  );

  const [, stdout, stderr] = await new Promise<
    [Gio.Subprocess, string, string]
  >((resolve, reject) => {
    proc.communicate_utf8_async(null, null, (_proc, result) => {
      try {
        if (!_proc) {
          reject(new Error('Subprocess is null'));
          return;
        }
        const [ok, outStr, errStr] = _proc.communicate_utf8_finish(result);
        resolve([_proc, outStr, errStr]);
      } catch (e) {
        reject(e);
      }
    });
  });

  if (!proc.get_successful()) {
    throw new Error(`efibootmgr failed: ${stderr}`);
  }

  const entries = new Map<string, BootEntry>();
  const regex = /Boot([0-9A-Fa-f]{4})\*?\s+(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stdout)) !== null) {
    const id = match[1];
    const raw = match[2].trim();
    // Split at first tab — everything before = short name, everything after = device path
    const tabIdx = raw.indexOf('\t');
    const name = tabIdx >= 0 ? raw.substring(0, tabIdx).trim() : raw;
    const full = raw.replace(/\t/g, ' ').trim();
    entries.set(id, { name, full });
  }
  return entries;
}
