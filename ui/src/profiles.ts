import type { ApiClient } from './api.ts';
import { button, el, message } from './dom.ts';

export interface Profiles { active: string; available: string[] }

export class ProfilePicker {
  readonly element = el('section', undefined, 'profiles');
  readonly select = el('select');
  private readonly name = el('input');
  private readonly copy = el('input');
  private readonly error = el('p', '', 'error');
  private profile: Profiles = { active: 'default', available: ['default'] };
  private connected = 0;
  private busy = false;
  private operating = false;
  private readonly remove: HTMLButtonElement;
  private readonly create: HTMLButtonElement;
  private readonly api: Pick<ApiClient, 'post' | 'del'>;
  private readonly changed: () => void;
  private readonly confirm: (text: string) => boolean;

  constructor(api: Pick<ApiClient, 'post' | 'del'>, changed: () => void,
    confirm: (text: string) => boolean = text => window.confirm(text), beforeSwitch: () => void | Promise<void> = () => {}) {
    this.api = api; this.changed = changed; this.confirm = confirm;
    const label = el('label', 'Profile '); label.append(this.select);
    this.select.addEventListener('change', () => {
      const name = this.select.value;
      if (name === this.profile.active) return;
      if (this.connected > 0 && !this.confirm('Switching profiles restarts the proxy and disconnects your game. Switch profile?')) {
        this.select.value = this.profile.active; return;
      }
      void this.run(async () => { await beforeSwitch(); await this.api.post('/api/profiles/select', { name }); this.changed(); });
    });
    const newLabel = el('label', 'New profile '); this.name.type = 'text'; this.name.maxLength = 40; newLabel.append(this.name);
    const copyLabel = el('label', 'Copy current settings'); this.copy.type = 'checkbox'; copyLabel.append(this.copy);
    this.create = button('Create profile', () => void this.run(async () => {
      const profiles = await this.api.post<Profiles>('/api/profiles', { name: this.name.value, ...(this.copy.checked ? { from: this.profile.active } : {}) });
      this.name.value = ''; this.update(profiles, this.connected); this.changed();
    }));
    // Active profiles cannot be deleted. Pick a separate inactive profile to remove.
    const deleteLabel = el('label', 'Delete inactive profile '); const deleteSelect = el('select');
    deleteSelect.className = 'delete-profile'; deleteLabel.append(deleteSelect);
    this.remove = button('Delete profile', () => {
      const name = deleteSelect.value;
      if (!name || !this.confirm(`Delete profile "${name}"?`)) return;
      void this.run(async () => { this.update(await this.api.del<Profiles>(`/api/profiles/${encodeURIComponent(name)}`), this.connected); this.changed(); });
    });
    const manage = el('details'); manage.append(el('summary', 'Manage profiles'), newLabel, copyLabel, this.create, deleteLabel, this.remove);
    this.error.setAttribute('role', 'alert'); this.element.append(label, manage, this.error);
  }

  update(profile: Profiles, connected: number, operating = false): void {
    this.profile = profile; this.connected = connected; this.operating = operating;
    this.select.replaceChildren();
    for (const name of profile.available) { const option = el('option', name); option.value = name; this.select.append(option); }
    this.select.value = profile.active;
    const inactive = this.element.querySelector<HTMLSelectElement>('.delete-profile')!;
    const selected = inactive.value; inactive.replaceChildren();
    for (const name of profile.available.filter(name => name !== 'default' && name !== profile.active)) {
      const option = el('option', name); option.value = name; inactive.append(option);
    }
    if ([...inactive.options].some(option => option.value === selected)) inactive.value = selected;
    this.controls();
  }

  private controls(): void {
    for (const control of this.element.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select')) control.disabled = this.busy || this.operating;
    this.remove.disabled ||= !this.element.querySelector<HTMLSelectElement>('.delete-profile')!.value;
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.operating) return;
    this.busy = true; this.controls(); this.error.textContent = '';
    try { await action(); }
    catch (error) { this.error.textContent = message(error); this.select.value = this.profile.active; this.changed(); }
    finally { this.busy = false; this.controls(); }
  }
}
