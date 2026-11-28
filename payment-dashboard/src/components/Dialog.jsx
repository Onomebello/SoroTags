import { useDialogA11y } from '../useDialogA11y';

/**
 * @typedef {Object} DialogProps
 * @property {string} className - Class for the dialog box; the backdrop gets `${className}-backdrop`.
 * @property {string} titleId - Id of the heading that names the dialog.
 * @property {() => void} onClose - Called on Escape or a click on the backdrop.
 * @property {import('react').ReactNode} children
 */

/**
 * Modal dialog shell: backdrop, dialog semantics and keyboard handling
 * (focus moved in, Tab kept inside, Escape to close, focus returned).
 * Render it only while the dialog is open.
 *
 * @param {DialogProps} props
 */
function Dialog({ className, titleId, onClose, children }) {
  const dialogRef = useDialogA11y(onClose);

  return (
    <div
      className={`${className}-backdrop`}
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          backgroundColor: '#FFFFFF',
          color: '#0B1220',
          borderRadius: '8px',
          padding: '24px',
          minWidth: '320px',
          maxWidth: '90vw',
          boxShadow: '0 10px 30px rgba(0, 0, 0, 0.2)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default Dialog;
