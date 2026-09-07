import * as React from "react";

export function SegmentedControl<T extends string>({ label, options, value, onChange, disabled = false }: {
  label: string; options: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void; disabled?: boolean;
}): React.JSX.Element {
  return <div className="mep-segmented" role="group" aria-label={label}>
    {options.map(([option, text]) => <button key={option} type="button" aria-pressed={value === option}
      disabled={disabled} onClick={() => onChange(option)}>{text}</button>)}
  </div>;
}
