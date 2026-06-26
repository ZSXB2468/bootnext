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
 * Parse the output of `efibootmgr` to extract boot entries.
 * Returns a Map of BootNNNN → label.
 */
async function getBootEntries(): Promise<Map<string, string>> {
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

  const entries = new Map<string, string>();
  const regex = /Boot([0-9A-Fa-f]{4})\*?\s+(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stdout)) !== null) {
    const id = match[1];
    const label = match[2].trim();
    entries.set(id, label);
  }
  return entries;
}

/**
 * Set the BootNext EFI variable and reboot the system.
 * Uses pkexec for privilege escalation (efibootmgr requires root).
 */
async function setBootNextAndReboot(bootId: string): Promise<void> {
  // Set BootNext
  const proc = Gio.Subprocess.new(
    ['/usr/bin/env', 'pkexec', 'efibootmgr', '--bootnext', bootId],
    Gio.SubprocessFlags.NONE,
  );

  await new Promise<void>((resolve, reject) => {
    proc.wait_async(null, (_proc, result) => {
      try {
        if (!_proc) {
          reject(new Error('Subprocess is null'));
          return;
        }
        _proc.wait_finish(result);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  if (!proc.get_successful()) {
    throw new Error(`Failed to set BootNext to ${bootId}`);
  }

  // Reboot via logind (fire-and-forget, no callback needed)
  const proxy = Manager(
    Gio.DBus.system,
    'org.freedesktop.login1',
    '/org/freedesktop/login1',
  );
  proxy.RebootRemote(false);
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
  proxy.SetRebootToFirmwareSetupRemote(true);
  proxy.RebootRemote(false);
}

/**
 * Build a countdown confirmation dialog before rebooting.
 * Uses GJS globals setInterval/clearInterval (matching reboottouefi).
 */
function buildConfirmDialog(
  targetLabel: string,
  onConfirm: () => void,
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

    // Add EFI boot entries
    try {
      const bootEntries = await getBootEntries();
      for (const [id, name] of bootEntries.entries()) {
        if (!blacklist.includes(name)) {
          this.menuItem.menu.addAction(name, () => {
            const dialog = buildConfirmDialog(name, () => {
              setBootNextAndReboot(id).catch((e: any) => {
                logError(e, `BootNext: setBootNextAndReboot(${id}) failed`);
              });
            });
            dialog.open();
          });
        }
      }
    } catch (e: any) {
      logError(e, 'BootNext: failed to get boot entries');
      // Add a disabled placeholder to indicate the error
      const errorItem = new PopupMenu.PopupMenuItem(
        _('(No EFI boot entries found)'),
      );
      errorItem.setSensitive(false);
      this.menuItem.menu.addMenuItem(errorItem);
    }
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
      systemMenu.addMenuItem(this.menuItem, 2);
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
    this.settings.connect('changed::blacklist', () => {
      this.updateMenuEntries();
    });
    this.settings.connect('changed::show-uefi', () => {
      this.updateMenuEntries();
    });
  }

  disable(): void {
    this.menuItem?.destroy();
    this.menuItem = null;
    this.settings = null;

    if (this.sourceId) {
      GLib.Source.remove(this.sourceId);
      this.sourceId = null;
    }
  }
}
