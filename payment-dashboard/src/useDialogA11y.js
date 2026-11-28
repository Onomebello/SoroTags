import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
const getFocusable = (container) =>
  Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));

/**
 * Keyboard behaviour for a modal dialog that is mounted while open.
 *
 * On mount, focus moves to the first focusable element inside the dialog.
 * Tab and Shift+Tab wrap around inside it, Escape calls `onClose`, and on
 * unmount focus goes back to whatever had it before the dialog opened.
 *
 * @param {() => void} onClose
 * @returns {import('react').RefObject<HTMLDivElement | null>}
 */
export function useDialogA11y(onClose) {
  const dialogRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused = document.activeElement;
    (getFocusable(dialog)[0] ?? dialog).focus();

    /** @param {KeyboardEvent} event */
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusable(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const isOutside = !dialog.contains(active);

      if (event.shiftKey && (active === first || isOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || isOutside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return dialogRef;
}
