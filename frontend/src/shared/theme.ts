/**
 * Theme handling. Dark is the default (the hero); the choice is persisted in
 * localStorage['avatar-theme'] and applied as data-theme on <html>.
 *
 * Each HTML <head> also carries an inline pre-paint script (see
 * {@link THEME_PREPAINT_SNIPPET}) so the stored theme applies before first
 * paint - no flash of the wrong theme.
 */
import { icon } from './dom';
import { storageGet, storageSet } from './storage';

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'avatar-theme';

/** Canvas colour per theme (tokens.css --surface-0), used for <meta name="theme-color">. */
const THEME_COLOR: Record<Theme, string> = { dark: '#04152a', light: '#f3f6fb' };

/**
 * The exact inline script placed in each HTML <head>, documented here for
 * reference (the HTML copy is authoritative at runtime):
 */
export const THEME_PREPAINT_SNIPPET =
  "(function(){try{var t=localStorage.getItem('avatar-theme');"
  + "if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();";

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();

function isTheme(v: unknown): v is Theme {
  return v === 'dark' || v === 'light';
}

/** The stored preference, or null when none/unavailable. */
export function getStoredTheme(): Theme | null {
  const v = storageGet(THEME_STORAGE_KEY);
  return isTheme(v) ? v : null;
}

/** The theme currently applied to <html> (dark when unset). */
export function getTheme(): Theme {
  const v = document.documentElement.getAttribute('data-theme');
  return isTheme(v) ? v : 'dark';
}

/** Apply a theme to <html>, update <meta name="theme-color">, optionally persist, notify listeners. */
export function setTheme(theme: Theme, persist = true): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.content = THEME_COLOR[theme];
  });
  if (persist) storageSet(THEME_STORAGE_KEY, theme);
  listeners.forEach((fn) => fn(theme));
}

/** Flip dark <-> light (persisted). Returns the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

let crossTabBound = false;

/**
 * Apply the stored theme (default dark) without re-persisting, and follow
 * theme changes made in other tabs. Call once at startup.
 */
export function initTheme(): Theme {
  const theme = getStoredTheme() ?? 'dark';
  setTheme(theme, false);
  if (!crossTabBound) {
    crossTabBound = true;
    window.addEventListener('storage', (e) => {
      if (e.key === THEME_STORAGE_KEY && isTheme(e.newValue) && e.newValue !== getTheme()) {
        setTheme(e.newValue, false);
      }
    });
  }
  return theme;
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Wire a theme toggle button (the mockups' `.icon-btn#themeToggle`). If the
 * button has no `.theme-moon` / `.theme-sun` icons they are added. Dark shows
 * the moon, light shows the sun (as in the mockups). Returns an unbind function.
 */
export function bindThemeToggle(button: HTMLElement): () => void {
  let moon = button.querySelector<SVGElement>('.theme-moon');
  let sun = button.querySelector<SVGElement>('.theme-sun');
  if (!moon) {
    moon = icon('moon', 'icon--sm theme-moon');
    button.appendChild(moon);
  }
  if (!sun) {
    sun = icon('sun', 'icon--sm theme-sun');
    button.appendChild(sun);
  }
  if (!button.title) button.title = 'Toggle light / dark';
  const sync = (theme: Theme): void => {
    moon!.style.display = theme === 'dark' ? '' : 'none';
    sun!.style.display = theme === 'dark' ? 'none' : '';
    button.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  };
  sync(getTheme());
  const onClick = (): void => {
    toggleTheme();
  };
  button.addEventListener('click', onClick);
  const unsubscribe = onThemeChange(sync);
  return () => {
    button.removeEventListener('click', onClick);
    unsubscribe();
  };
}

/** Build a ready-wired theme toggle: `<button class="icon-btn" id="themeToggle">` with moon/sun icons. */
export function createThemeToggle(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn';
  button.id = 'themeToggle';
  button.title = 'Toggle light / dark';
  bindThemeToggle(button);
  return button;
}
