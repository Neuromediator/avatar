/**
 * Visitor chat entry point (served at "/"). Markup lives in index.html
 * (lifted from design-system/mockups/Visitor Chat.html); behaviour lives in
 * ./chat.ts.
 */
import { bootstrap } from '../shared/boot';
import { $ } from '../shared/dom';
import { VisitorChat } from './chat';

async function main(): Promise<void> {
  // The composer takes focus immediately (before the config round-trip).
  const textarea = $<HTMLTextAreaElement>('#composerInput');
  textarea.focus({ preventScroll: true });

  const cfg = await bootstrap();

  const chat = new VisitorChat(cfg, {
    convo: $('#convo'),
    thread: $('#thread'),
    intro: $('#intro'),
    textarea,
    sendButton: $<HTMLButtonElement>('#sendBtn'),
    nameInput: $<HTMLInputElement>('#visitorName'),
    keepInput: $<HTMLInputElement>('#keepChat'),
    resetButton: $<HTMLButtonElement>('#resetChat'),
    themeButton: $<HTMLButtonElement>('#themeToggle'),
    jumpButton: $<HTMLButtonElement>('#jumpLatest'),
    liveRegion: $('#liveRegion'),
    chips: Array.from(document.querySelectorAll<HTMLButtonElement>('#intro [data-prompt]')),
  });
  await chat.start();
}

void main();
