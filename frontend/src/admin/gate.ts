/**
 * Login gate for /admin (shown whenever GET /admin/api/session is 401).
 *
 * States (docs/ux-flows.md "Admin auth"): idle (field focused) -> logging-in
 * (button disabled, "Signing in…") -> error ("Incorrect password", field
 * re-focused and selected) | success (the caller mounts the dashboard).
 */
import { adminLogin, ApiError, UnauthorizedError, type AppConfig } from '../shared/api';
import { brandMark, el, icon } from '../shared/dom';
import { bindThemeToggle } from '../shared/theme';

export interface GateOptions {
  /** Optional message shown on arrival (e.g. "Your session ended…" or a connection problem). */
  notice?: string | null;
  /** Called after a successful POST /admin/login. */
  onSuccess: () => void | Promise<void>;
}

export interface GateHandle {
  readonly element: HTMLElement;
  destroy(): void;
}

export function mountGate(root: HTMLElement, cfg: AppConfig, options: GateOptions): GateHandle {
  const password = el('input', {
    class: 'input gate-input',
    id: 'adminPassword',
    type: 'password',
    name: 'password',
    autocomplete: 'current-password',
    required: true,
    spellcheck: 'false',
    placeholder: 'Admin password',
    'aria-describedby': 'gateError',
  });
  const submitLabel = el('span', { class: 'gate-submit-label' }, 'Sign in');
  const submit = el('button', { class: 'btn btn--primary btn--lg gate-submit', type: 'submit' },
    submitLabel, icon('arrow-right', 'icon--sm'));
  const error = el('p', { class: 'gate-error', id: 'gateError', role: 'alert', 'aria-live': 'assertive' });

  const setError = (text: string | null): void => {
    error.textContent = text ?? '';
    error.hidden = !text;
    password.setAttribute('aria-invalid', text ? 'true' : 'false');
    form.classList.toggle('has-error', !!text);
  };

  const form = el('form', { class: 'gate-form', novalidate: true, 'aria-label': 'Sign in to the admin dashboard' },
    // Hidden username so password managers file the credential sensibly.
    el('input', {
      type: 'text', name: 'username', value: 'admin', autocomplete: 'username',
      class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true', readonly: true,
    }),
    el('label', { class: 'label gate-label', for: 'adminPassword' }, 'Password'),
    el('div', { class: 'gate-field' }, icon('lock', 'icon--sm gate-field-icon'), password),
    error,
    submit,
  );

  const card = el('div', { class: 'gate-card card' },
    el('div', { class: 'gate-brand' },
      el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, brandMark(20)),
      el('span', { class: 'brand-name' }, 'Avatar'),
      el('span', { class: 'admin-pill' }, 'Admin')),
    el('div', { class: 'gate-intro' },
      el('span', { class: 'eyebrow' }, 'Owner console'),
      el('h1', { class: 'gate-title display' }, 'Step into the conversation.'),
      el('p', { class: 'gate-lede' },
        `Every thread between visitors and ${cfg.owner_name}'s digital twin. Read along, and join any of them as yourself.`)),
    options.notice
      ? el('p', { class: 'gate-notice', role: 'status' }, icon('clock', 'icon--sm'), el('span', null, options.notice))
      : null,
    form,
    el('p', { class: 'gate-note' }, icon('shield', 'icon--sm'), 'Signed, httpOnly session'),
  );

  const themeToggle = el('button', { type: 'button', class: 'icon-btn', id: 'themeToggle', title: 'Toggle light / dark' });
  const unbindTheme = bindThemeToggle(themeToggle);
  const element = el('main', { class: 'gate hud-grid', 'aria-labelledby': 'gateTitle' },
    el('div', { class: 'gate-corner' }, themeToggle),
    card);
  card.querySelector('h1')!.id = 'gateTitle';

  let busy = false;
  const setBusy = (next: boolean): void => {
    busy = next;
    submit.disabled = next;
    submit.classList.toggle('is-busy', next);
    submitLabel.textContent = next ? 'Signing in…' : 'Sign in';
    form.setAttribute('aria-busy', String(next));
  };

  const focusField = (select = false): void => {
    password.focus({ preventScroll: true });
    if (select) password.select();
  };

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    const value = password.value;
    if (!value) {
      setError('Enter the admin password.');
      focusField();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await adminLogin(value);
    } catch (err) {
      setBusy(false);
      if (err instanceof UnauthorizedError) setError('Incorrect password');
      else if (err instanceof ApiError) setError(err.detail);
      else setError('Something went wrong. Please try again.');
      focusField(true);
      return;
    }
    element.classList.add('is-success');
    try {
      await options.onSuccess();
    } catch (err) {
      console.error('[avatar] admin start failed', err);
      setBusy(false);
    }
  };

  const onInput = (): void => {
    if (!error.hidden) setError(null);
  };

  form.addEventListener('submit', onSubmit);
  password.addEventListener('input', onInput);

  setError(null);

  root.replaceChildren(element);
  document.body.dataset.screen = 'gate';
  focusField();

  return {
    element,
    destroy() {
      form.removeEventListener('submit', onSubmit);
      password.removeEventListener('input', onInput);
      unbindTheme();
      element.remove();
    },
  };
}
