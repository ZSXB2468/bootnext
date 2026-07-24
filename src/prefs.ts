import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';

import {
  ExtensionPreferences,
  gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { getBootEntries, checkEfibootmgr } from './efi.js';

const RULES_CONTENT = `// Allow efibootmgr --bootnext without authentication.
// Managed by BootNext GNOME Shell extension.
// Keep in sync with: scripts/99-bootnext.rules
polkit.addRule(function (action, subject) {
    if (action.id !== "org.freedesktop.policykit.exec") {
        return polkit.Result.NOT_HANDLED;
    }
    if (!subject.local || !subject.active) {
        return polkit.Result.NOT_HANDLED;
    }
    const cmdline = action.lookup("command_line");
    if (cmdline && /^(\\/usr\\/(s?bin\\/)?)?efibootmgr +--bootnext +[0-9A-Fa-f]{4}$/.test(cmdline)) {
        return polkit.Result.YES;
    }
    return polkit.Result.NOT_HANDLED;
});
`;

async function installPolkitRule(): Promise<void> {
  const proc = Gio.Subprocess.new(
    ['pkexec', 'tee', '/etc/polkit-1/rules.d/99-bootnext.rules'],
    Gio.SubprocessFlags.STDIN_PIPE,
  );
  await new Promise<void>((resolve, reject) => {
    proc.communicate_utf8_async(RULES_CONTENT, null, (_p, result) => {
      try {
        if (!_p) { reject(new Error('null')); return; }
        _p.communicate_utf8_finish(result);
        resolve();
      } catch (e) { reject(e); }
    });
  });
  if (!proc.get_successful()) throw new Error('Failed to install polkit rule');
}

async function removePolkitRule(): Promise<void> {
  const proc = Gio.Subprocess.new(
    ['pkexec', 'rm', '-f', '/etc/polkit-1/rules.d/99-bootnext.rules'],
    Gio.SubprocessFlags.NONE,
  );
  await new Promise<void>((resolve, reject) => {
    proc.wait_async(null, (_p, r) => {
      try { if (!_p) { reject(new Error('null')); return; } _p.wait_finish(r); resolve(); } catch (e) { reject(e); }
    });
  });
}

export default class BootNextPreferences extends ExtensionPreferences {
  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();

    // ── General page ──
    const page = new Adw.PreferencesPage({
      title: _('General'),
      icon_name: 'system-restart-symbolic',
    });
    window.add(page);

    // ── Password-less Reboot group ──
    const authGroup = new Adw.PreferencesGroup({
      title: _('Password-less Reboot'),
      description: _(
        'Skip the password prompt when switching OS. Installs a polkit rule that allows efibootmgr --bootnext without authentication.',
      ),
    });
    page.add(authGroup);

    const authRow = new Adw.SwitchRow({
      title: _('Enable Password-less Reboot'),
      active: settings.get_boolean('polkit-rule-installed'),
    });
    let toggling = false;
    authRow.connect('notify::active', () => {
      if (toggling) return;
      const want = authRow.active;
      toggling = true;
      (want ? installPolkitRule() : removePolkitRule())
        .then(() => {
          settings.set_boolean('polkit-rule-installed', want);
          authRow.active = want;
        })
        .catch((e: any) => {
          logError(e, 'BootNext: polkit rule toggle failed');
          authRow.active = settings.get_boolean('polkit-rule-installed');
        })
        .finally(() => {
          toggling = false;
        });
    });
    authGroup.add(authRow);

    // ── Blacklist group ──
    const group = new Adw.PreferencesGroup({
      title: _('Blacklist'),
      description: _('Hide boot entries from the menu'),
    });
    page.add(group);

    // UEFI Firmware entry — controlled by show-uefi boolean key
    const uefiRow = new Adw.SwitchRow({
      title: _('UEFI Firmware Setup'),
      active: settings.get_boolean('show-uefi'),
    });
    uefiRow.connect('notify::active', () => {
      settings.set_boolean('show-uefi', uefiRow.active);
    });
    group.add(uefiRow);

    // EFI boot entries — blacklist via string array
    if (!checkEfibootmgr()) {
      const row = new Adw.ActionRow({
        title: _('efibootmgr not found'),
        subtitle: _('Make sure efibootmgr is installed.'),
      });
      group.add(row);
      return;
    }

    try {
      const bootEntries = await getBootEntries();
      const blacklist: string[] = settings.get_strv('blacklist');

      for (const [, entry] of bootEntries.entries()) {
        // Show full path in settings page for identification,
        // but use short name for the blacklist key (matching the menu).
        const row = new Adw.SwitchRow({
          title: entry.full,
          active: !blacklist.includes(entry.name),
        });
        // When ON, remove from blacklist (i.e. show). When OFF, add to blacklist.
        row.connect('notify::active', () => {
          const updated = new Set(settings.get_strv('blacklist'));
          if (row.active) {
            updated.delete(entry.name);
          } else {
            updated.add(entry.name);
          }
          settings.set_strv('blacklist', Array.from(updated));
        });
        group.add(row);
      }
    } catch (e: any) {
      // efibootmgr exists but failed (e.g. permission denied, parse error)
      const row = new Adw.ActionRow({
        title: _('Failed to list boot entries'),
        subtitle: _('Could not read EFI boot entries. Check permissions or run efibootmgr manually.'),
      });
      group.add(row);
    }
  }
}
