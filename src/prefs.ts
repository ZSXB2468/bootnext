import Gio from 'gi://Gio';
import Adw from 'gi://Adw';

import {
  ExtensionPreferences,
  gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { getBootEntries } from './efi.js';

export default class BootNextPreferences extends ExtensionPreferences {
  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();

    // ── General page ──
    const page = new Adw.PreferencesPage({
      title: _('General'),
      icon_name: 'system-restart-symbolic',
    });
    window.add(page);

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
      // efibootmgr not available — show a hint
      const row = new Adw.ActionRow({
        title: _('No EFI boot entries found'),
        subtitle: _('Make sure efibootmgr is installed.'),
      });
      group.add(row);
    }
  }
}
