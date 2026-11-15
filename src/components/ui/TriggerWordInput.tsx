import { useEffect, useState, type KeyboardEvent } from 'react';
import { normalizeTriggerWord, validateTriggerWord } from '../../services/caption/captionFileService';

type Props = {
  /** The saved dataset trigger word. */
  value: string;
  /** Called only on an explicit apply (Enter or leaving the field) with a valid, changed word. */
  onApply: (value: string) => void;
  className?: string;
  ariaLabel?: string;
};

/** Edits the trigger word locally; changing it rewrites every caption in dataset/, so it is applied on Enter or blur, never per keystroke. */
export function TriggerWordInput({ value, onApply, className, ariaLabel = 'Trigger word' }: Props) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(value); setError(null); }, [value]);
  const apply = () => {
    const invalid = validateTriggerWord(draft);
    setError(invalid);
    if (invalid) return;
    if (normalizeTriggerWord(draft) !== normalizeTriggerWord(value)) onApply(draft);
    else setDraft(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); apply(); }
    else if (event.key === 'Escape') { setDraft(value); setError(null); }
  };
  return (
    <span className="inline-flex min-w-0 flex-col gap-1">
      <input
        value={draft}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        onChange={(event) => { setDraft(event.target.value); setError(validateTriggerWord(event.target.value)); }}
        onBlur={apply}
        onKeyDown={onKeyDown}
        className={className}
      />
      {error && <span role="alert" className="max-w-xs text-xs text-destructive">{error}</span>}
    </span>
  );
}
