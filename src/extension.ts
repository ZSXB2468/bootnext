/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/* exported init */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import { panel } from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {
  Extension,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { getBootEntries, checkEfibootmgr } from './efi.js';

// ── Tunables ──
const SHELL_TIMEOUT_SECONDS = 120;
const MENU_INSERT_POSITION = 2;

/**
 * DBus proxy wrapper for logind's Manager interface.
 * Provides SetRebootToFirmwareSetup and Reboot methods.
 */
const ManagerInterface: string = `<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="SetRebootToFirmwareSetup">
      <arg type="b" direction="in"/>
    </method>
    <method name="Reboot">
      <arg type="b" direction="in"/>
    </method>
  </interface>
</node>`;
const Manager = Gio.DBusProxy.makeProxyWrapper(ManagerInterface);

/**
 * Spawn a pkexec-wrapped shell that signals readiness via stdout,
 * then waits on stdin for a boot ID before running efibootmgr.
 *
 * Shell writes "READY\n" to stdout once pkexec auth succeeds.
 * Extension reads stdout → knows auth passed → shows countdown.
 * On confirm → write boot ID to stdin → efibootmgr runs → reboot.
 * On cancel → write empty line → shell exits without efibootmgr.
 *
 * Returns null if pkexec auth was cancelled.
 */
function spawnDeferredShell(): Promise<Gio.Subprocess | null> {
  return new Promise((resolve) => {
    const shellScript = `
      echo READY;
      if read -r -t ${SHELL_TIMEOUT_SECONDS} id && [ -n "$id" ]; then
        case "$id" in
          [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f])
            exec efibootmgr --bootnext "$id"
            ;;
          *)
            exit 1
            ;;
        esac
      fi
    `;

    const proc = Gio.Subprocess.new(
      ['pkexec', 'sh', '-c', shellScript],
      Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
    );

    let resolved = false;

    const safeResolve = (result: Gio.Subprocess | null) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    // If shell exits quickly → auth cancelled
    proc.wait_async(null, () => {
      safeResolve(null);
    });

    // Read stdout line — blocks until shell writes "READY" (auth passed)
    const outPipe = proc.get_stdout_pipe();
    if (!outPipe) {
      safeResolve(null);
      return;
    }
    const stdout = new Gio.DataInputStream({
      base_stream: outPipe,
      close_base_stream: true,
    });
    stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, result) => {
      try {
        const [line] = stdout.read_line_finish_utf8(result);

        stdout.close(null);

        if (line && line.trim() === 'READY') {
          safeResolve(proc);
        } else {
          safeResolve(null);
        }
      } catch (_) {
        try { stdout.close(null); } catch (_) {}
        safeResolve(null);
      }
    });
  });
}

// ── polkit rule installed path (simple, no password) ──

async function runBootNextSimple(bootId: string): Promise<void> {
  const proc = Gio.Subprocess.new(
    ['/usr/bin/env', 'pkexec', 'efibootmgr', '--bootnext', bootId],
    Gio.SubprocessFlags.NONE,
  );
  await new Promise<void>((resolve, reject) => {
    proc.wait_async(null, (_p, r) => {
      try { if (!_p) { reject(new Error('null')); return; } _p.wait_finish(r); resolve(); } catch (e) { reject(e); }
    });
  });
  if (!proc.get_successful()) throw new Error(`BootNext ${bootId} failed`);
  try {
    const proxy = Manager(Gio.DBus.system, 'org.freedesktop.login1', '/org/freedesktop/login1');
    proxy.RebootRemote(false);
  } catch (e: any) {
    logError(e, 'BootNext: Reboot DBus call failed');
  }
}

/**
 * Reboot to UEFI firmware setup via logind.
 * Uses fire-and-forget DBus calls (matching reboottouefi pattern).
 */
function rebootToUefi(): void {
  const proxy = Manager(
    Gio.DBus.system,
    'org.freedesktop.login1',
    '/org/freedesktop/login1',
  );
  try {
    proxy.SetRebootToFirmwareSetupRemote(true);
    proxy.RebootRemote(false);
  } catch (e: any) {
    logError(e, 'BootNext: UEFI reboot DBus call failed');
  }
}

/**
 * Build a countdown confirmation dialog before rebooting.
 * Uses GJS globals setInterval/clearInterval (matching reboottouefi).
 */
function buildConfirmDialog(
  targetLabel: string,
  onConfirm: () => void,
  onCancel?: () => void,
): ModalDialog.ModalDialog {
  let counter = 60;
  let seconds = counter;

  const dialog = new ModalDialog.ModalDialog({ styleClass: 'modal-dialog' });

  let counterIntervalId: GLib.Source | null = null;
  let messageIntervalId: GLib.Source | null = null;

  const clearIntervals = () => {
    if (counterIntervalId) clearInterval(counterIntervalId);
    if (messageIntervalId) clearInterval(messageIntervalId);
    counterIntervalId = null;
    messageIntervalId = null;
  };

  dialog.setButtons([
    {
      label: _('Cancel'),
      action: () => {
        clearIntervals();
        dialog.close();
        onCancel?.();
      },
      key: Clutter.KEY_Escape,
      default: false,
    },
    {
      label: _('Restart Now'),
      action: () => {
        clearIntervals();
        dialog.close();
        onConfirm();
      },
      default: false,
    },
  ]);

  const dialogTitle = new St.Label({
    text: _('Restart to %s').replace('%s', targetLabel),
    style: 'font-weight: bold; font-size: 18px;',
  });

  let dialogMessage = new St.Label({
    text: _('The system will restart automatically in %d seconds.').replace(
      '%d',
      String(seconds),
    ),
  });
  dialogMessage.clutterText.ellipsize = Pango.EllipsizeMode.NONE;
  dialogMessage.clutterText.lineWrap = true;

  const titleBox = new St.BoxLayout({
    xAlign: Clutter.ActorAlign.CENTER,
  });
  titleBox.add_child(new St.Label({ text: '  ' }));
  titleBox.add_child(dialogTitle);

  const box = new St.BoxLayout({ yExpand: true, vertical: true });
  box.add_child(titleBox);
  box.add_child(new St.Label({ text: '  ' }));
  box.add_child(dialogMessage);

  counterIntervalId = setInterval(() => {
    if (counter > 0) {
      counter--;
      if (counter % 10 === 0) {
        seconds = counter;
      }
    } else {
      clearIntervals();
      dialog.close();
      onConfirm();
    }
  }, 1000);

  messageIntervalId = setInterval(() => {
    dialogMessage?.set_text(
      _('The system will restart automatically in %d seconds.').replace(
        '%d',
        String(seconds),
      ),
    );
  }, 500);

  dialog.contentLayout.add_child(box);
  return dialog;
}

export default class BootNextExtension extends Extension {
  private menuItem: PopupMenu.PopupSubMenuMenuItem | null = null;
  private sourceId: number | null = null;
  private settings: Gio.Settings | null = null;
  private signalBlacklistId: number | null = null;
  private signalUefiId: number | null = null;

  constructor(metadata: any) {
    super(metadata);
  }

  /**
   * Rebuild the submenu with current EFI boot entries.
   */
  private async updateMenuEntries(): Promise<void> {
    if (!this.menuItem || !this.settings) return;

    const blacklist: string[] = this.settings.get_strv('blacklist');
    const showUefi: boolean = this.settings.get_boolean('show-uefi');
    const hasEfibootmgr = checkEfibootmgr();

    this.menuItem.menu.removeAll();

    // Add UEFI Firmware entry if not blacklisted
    if (showUefi && !blacklist.includes('UEFI Firmware Setup')) {
      this.menuItem.menu.addAction(_('UEFI Firmware Setup'), () => {
        const dialog = buildConfirmDialog('UEFI Firmware Setup', () => {
          rebootToUefi();
        });
        dialog.open();
      });
    }

    // efibootmgr not found — show a hint
    if (!hasEfibootmgr) {
      const hintItem = new PopupMenu.PopupMenuItem(
        _('efibootmgr not found'),
      );
      hintItem.setSensitive(false);
      this.menuItem.menu.addMenuItem(hintItem);
      return;
    }

    // Add EFI boot entries
    try {
      const bootEntries = await getBootEntries();

      if (bootEntries.size === 0) {
        const emptyItem = new PopupMenu.PopupMenuItem(
          _('No boot entries'),
        );
        emptyItem.setSensitive(false);
        this.menuItem.menu.addMenuItem(emptyItem);
        return;
      }

      for (const [id, entry] of bootEntries.entries()) {
        // Use short name for menu display and blacklist matching
        if (!blacklist.includes(entry.name)) {
          this.menuItem.menu.addAction(entry.name, () => {
            this.handleBootEntry(id, entry.name);
          });
        }
      }
    } catch (e: any) {
      logError(e, 'BootNext: failed to get boot entries');
      const errorItem = new PopupMenu.PopupMenuItem(
        _('efibootmgr error'),
      );
      errorItem.setSensitive(false);
      this.menuItem.menu.addMenuItem(errorItem);
    }
  }

  /**
   * Handle a boot entry click.
   *
   * Two paths depending on whether the polkit rule is installed:
   * - Rule installed   → pkexec efibootmgr (no password), direct
   * - Rule not installed → deferred shell: password FIRST, then countdown
   */
  private async handleBootEntry(id: string, name: string): Promise<void> {
    if (this.settings?.get_boolean('polkit-rule-installed')) {
      // Rule installed — simple path, no password needed
      const dialog = buildConfirmDialog(name, () => {
        runBootNextSimple(id).catch((e: any) =>
          logError(e, `BootNext: ${id} failed`),
        );
      });
      dialog.open();
      return;
    }

    // No rule — deferred shell: password NOW, countdown LATER
    const shell = await spawnDeferredShell();
    if (!shell) return;

    const doReboot = () => {
      shell.communicate_utf8_async(
        `${id}\n`,
        null,
        (_p, result) => {
          try { if (_p) _p.communicate_utf8_finish(result); } catch (e: any) {
            logError(e, 'BootNext: deferred efibootmgr failed');
          }
          try {
            const proxy = Manager(
              Gio.DBus.system,
              'org.freedesktop.login1',
              '/org/freedesktop/login1',
            );
            proxy.RebootRemote(false);
          } catch (e: any) {
            logError(e, 'BootNext: deferred Reboot DBus call failed');
          }
        },
      );
    };

    const dialog = buildConfirmDialog(name, doReboot, () => {
      // Cancel: write empty line → shell reads empty → exits without efibootmgr
      shell.communicate_utf8_async('\n', null, (_p, result) => {
        try { if (_p) _p.communicate_utf8_finish(result); } catch (_) { /* ignore */ }
      });
    });
    dialog.open();
  }

  /**
   * Insert the "Restart to..." submenu into the system power menu.
   */
  private addMenuItem(): void {
    this.menuItem = new PopupMenu.PopupSubMenuMenuItem(
      _('Restart to…'),
      false,
    );
    this.updateMenuEntries();

    // Cast to any — GJS runtime guarantees quickSettings exists by the time
    // this is called, but TypeScript types from @girs may mark it optional.
    const qs: any = panel.statusArea;
    const systemMenu = qs.quickSettings._system?.quickSettingsItems[0]?.menu;
    if (systemMenu) {
      systemMenu.addMenuItem(this.menuItem, MENU_INSERT_POSITION);
    }
  }

  /**
   * Poll for the system menu to appear, then add our menu item.
   */
  private queueAddMenuItem(): void {
    this.sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      const qs: any = panel.statusArea;
      if (!qs.quickSettings._system) return GLib.SOURCE_CONTINUE;
      this.addMenuItem();
      return GLib.SOURCE_REMOVE;
    });
  }

  enable(): void {
    this.settings = this.getSettings();

    const qs: any = panel.statusArea;
    if (!qs.quickSettings._system) {
      this.queueAddMenuItem();
    } else {
      this.addMenuItem();
    }

    // Listen for settings changes
    this.signalBlacklistId = this.settings.connect(
      'changed::blacklist',
      () => {
        this.updateMenuEntries();
      },
    );
    this.signalUefiId = this.settings.connect(
      'changed::show-uefi',
      () => {
        this.updateMenuEntries();
      },
    );
  }

  disable(): void {
    this.menuItem?.destroy();
    this.menuItem = null;

    if (this.signalBlacklistId !== null && this.settings) {
      this.settings.disconnect(this.signalBlacklistId);
      this.signalBlacklistId = null;
    }
    if (this.signalUefiId !== null && this.settings) {
      this.settings.disconnect(this.signalUefiId);
      this.signalUefiId = null;
    }
    this.settings = null;

    if (this.sourceId) {
      GLib.Source.remove(this.sourceId);
      this.sourceId = null;
    }
  }
}
