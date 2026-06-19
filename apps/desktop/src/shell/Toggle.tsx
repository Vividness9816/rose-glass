/* Labeled on/off slider + labeled dropdown for the Settings menu. Presentational only;
   state + persistence live in the SettingsContext. Token-driven (no hardcoded hex). */

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`rg-toggle${disabled ? ' disabled' : ''}`}>
      <span className="rg-toggle-text">
        <span className="rg-toggle-label">{label}</span>
        {hint && <span className="rg-toggle-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="rg-toggle-track" aria-hidden="true" />
    </label>
  );
}

export function Select<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`rg-select${disabled ? ' disabled' : ''}`}>
      <span className="rg-toggle-text">
        <span className="rg-toggle-label">{label}</span>
        {hint && <span className="rg-toggle-hint">{hint}</span>}
      </span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
