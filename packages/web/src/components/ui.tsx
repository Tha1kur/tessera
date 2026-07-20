import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { useId } from "react";

/**
 * Shared interface primitives.
 *
 * Small, unopinionated wrappers over real HTML elements. They exist to keep
 * class names and accessibility wiring in one place - not to hide the element
 * underneath, which is why each one still forwards its native props.
 */

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  large?: boolean;
  loading?: boolean;
}

export function Button({
  variant = "default",
  block,
  large,
  loading,
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const classes = [
    "button",
    variant !== "default" ? `button--${variant}` : "",
    block ? "button--block" : "",
    large ? "button--lg" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      className={classes}
      // A button doing work must not be clickable twice - that is how duplicate
      // repositories and double-posted issues happen.
      disabled={disabled || loading}
      // Tells assistive technology the control is busy rather than broken.
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | undefined;
}

export function Field({ label, hint, error, id, ...rest }: FieldProps) {
  // A generated id keeps <label for> pointing at the right input even when the
  // same field appears twice on a page.
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = [hint ? `${inputId}-hint` : "", error ? `${inputId}-error` : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...rest}
      />
      {hint && !error && (
        <span className="field__hint" id={`${inputId}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        // role="alert" so the message is announced the moment it appears,
        // rather than silently sitting there for a screen reader user.
        <span className="field__error" id={`${inputId}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

interface TextFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string | undefined;
}

export function TextArea({ label, hint, error, id, ...rest }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
      </label>
      <textarea id={inputId} className="textarea" aria-invalid={error ? true : undefined} {...rest} />
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Alert({ children, variant = "error" }: { children: ReactNode; variant?: "error" | "info" }) {
  return (
    <div className={`alert alert--${variant}`} role={variant === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Avatar({ user, size = 32 }: { user: { username: string; avatarUrl?: string | null } | null; size?: number }) {
  const initial = user?.username?.[0]?.toUpperCase() ?? "?";

  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.max(11, size * 0.42) }}
      aria-hidden="true"
    >
      {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initial}
    </span>
  );
}

export function Badge({ children, variant }: { children: ReactNode; variant?: "open" | "closed" | "private" }) {
  return <span className={`badge${variant ? ` badge--${variant}` : ""}`}>{children}</span>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="row" style={{ justifyContent: "center", padding: "var(--space-7)" }}>
      <span className="spinner" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action && <div style={{ marginTop: "var(--space-4)" }}>{action}</div>}
    </div>
  );
}

/** Relative time, because "3 days ago" reads faster than a date. */
export function TimeAgo({ value }: { value: string }) {
  const then = new Date(value);
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];

  let label = "just now";
  for (const [unit, size] of units) {
    const amount = Math.floor(seconds / size);
    if (amount >= 1) {
      label = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-amount, unit);
      break;
    }
  }

  // The exact timestamp stays available on hover and to screen readers.
  return <time dateTime={value} title={then.toLocaleString()}>{label}</time>;
}
