import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export function Button({
  className = '',
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}): React.JSX.Element {
  return <button className={`j-button j-button--${variant} ${className}`.trim()} {...props} />;
}

export function StatusBadge({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'error' | 'neutral';
  children: ReactNode;
}): React.JSX.Element {
  return <span className={`j-status j-status--${tone}`}>{children}</span>;
}

export function Surface({
  className = '',
  ...props
}: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <section className={`j-surface ${className}`.trim()} {...props} />;
}

export function EmptyState({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="j-empty-state" data-testid="availability-state" data-availability={eyebrow}>
      <span className="j-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}

export type TabItem = {
  id: string;
  label: string;
  panel: ReactNode;
};

export function Tabs({
  items,
  activeId,
  label,
  onChange,
}: {
  items: readonly TabItem[];
  activeId: string;
  label: string;
  onChange: (id: string) => void;
}): React.JSX.Element {
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % items.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = items[nextIndex];
    if (!next) return;
    onChange(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  const active = items.find((item) => item.id === activeId) ?? items[0];
  return (
    <div className="j-tabs">
      <div aria-label={label} className="j-tab-list" role="tablist">
        {items.map((item, index) => (
          <button
            aria-controls={`panel-${item.id}`}
            aria-selected={item.id === active?.id}
            className="j-tab"
            data-tab-id={item.id}
            id={`tab-${item.id}`}
            key={item.id}
            role="tab"
            tabIndex={item.id === active?.id ? 0 : -1}
            type="button"
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {active && (
        <div
          aria-labelledby={`tab-${active.id}`}
          id={`panel-${active.id}`}
          role="tabpanel"
          tabIndex={0}
        >
          {active.panel}
        </div>
      )}
    </div>
  );
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  title,
  description,
  closeLabel,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusables = (): HTMLElement[] =>
      dialog ? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    const animationFrame = requestAnimationFrame(() => focusables()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusables();
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div className="j-dialog-backdrop" role="presentation">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="j-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <span className="j-eyebrow">{description}</span>
        <h2 id={titleId}>{title}</h2>
        <div id={descriptionId}>{children}</div>
        <Button data-autofocus type="button" variant="secondary" onClick={onClose}>
          {closeLabel}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

export type ToastMessage = {
  id: string;
  message: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
};

export function ToastRegion({
  label,
  messages,
}: {
  label: string;
  messages: readonly ToastMessage[];
}): React.JSX.Element {
  return (
    <div aria-label={label} aria-live="polite" className="j-toast-region" role="status">
      {messages.map((toast) => (
        <div className={`j-toast j-toast--${toast.tone}`} key={toast.id}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="j-visually-hidden">{children}</span>;
}
