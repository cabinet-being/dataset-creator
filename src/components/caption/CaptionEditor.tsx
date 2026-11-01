import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CompositionEvent, KeyboardEvent } from 'react';
import {
  getCaptionFragmentAtSelection,
  getCaptionSuggestionMatches,
  getCaptionTags,
  normalizeCaptionTag,
  replaceCaptionFragment,
} from '../../lib/captionEditor';

export type CaptionEditorProps = {
  value: string;
  onChange: (value: string) => void;
  suggestions?: string[];
  requiredTag?: string;
  id?: string;
  disabled?: boolean;
  rows?: number;
  placeholder?: string;
  onBlur?: () => void;
  ariaLabel?: string;
};

export const CaptionEditor = ({
  value, onChange, suggestions = [], requiredTag, id, disabled, rows = 2,
  placeholder = 'Add comma-separated tags…', onBlur, ariaLabel = 'Caption tags',
}: CaptionEditorProps) => {
  const generatedId = useId();
  const inputId = id ?? `caption-editor-${generatedId}`;
  const listId = `${inputId}-suggestions`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const composing = useRef(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const fragment = getCaptionFragmentAtSelection(value, selection.start, selection.end);
  const matches = useMemo(
    () => getCaptionSuggestionMatches(fragment.text, suggestions, value),
    [fragment.text, suggestions, value]
  );
  const open = !disabled && !dismissed && matches.length > 0 && focused && !/[,\r\n]/.test(value.slice(selection.start, selection.end));
  const selectedIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));
  useEffect(() => setActiveIndex(0), [fragment.text]);
  const tags = getCaptionTags(value);
  const counts = new Map<string, number>();
  tags.forEach((tag) => counts.set(normalizeCaptionTag(tag), (counts.get(normalizeCaptionTag(tag)) ?? 0) + 1));
  const duplicates = tags.filter((tag, index) => counts.get(normalizeCaptionTag(tag))! > 1 && tags.findIndex((item) => normalizeCaptionTag(item) === normalizeCaptionTag(tag)) === index);
  const missingRequired = Boolean(requiredTag && !tags.some((tag) => normalizeCaptionTag(tag) === normalizeCaptionTag(requiredTag)));

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !textareaRef.current) return;
    textareaRef.current.setSelectionRange(caret, caret);
    setSelection({ start: caret, end: caret });
    pendingCaret.current = null;
  }, [value]);

  const updateSelection = () => {
    const input = textareaRef.current;
    if (input) setSelection({ start: input.selectionStart, end: input.selectionEnd });
  };
  const onInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDismissed(false);
    onChange(event.target.value);
    setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd });
  };
  const accept = (suggestion: string) => {
    const input = textareaRef.current;
    if (!input) return;
    const result = replaceCaptionFragment(value, input.selectionStart, input.selectionEnd, suggestion);
    pendingCaret.current = result.caret;
    setDismissed(false);
    onChange(result.value);
    requestAnimationFrame(() => input.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing) return;
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (open && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault();
      event.stopPropagation();
      accept(matches[selectedIndex] ?? matches[0]);
    } else if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  };
  const onCompositionStart = (_event: CompositionEvent<HTMLTextAreaElement>) => { composing.current = true; };
  const onCompositionEnd = () => { composing.current = false; setDismissed(false); updateSelection(); };

  return <div className="relative min-w-0">
    <textarea
      ref={textareaRef}
      id={inputId}
      value={value}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? `${listId}-option-${selectedIndex}` : undefined}
      role="combobox"
      className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      onChange={onInputChange}
      onKeyDown={onKeyDown}
      onSelect={updateSelection}
      onClick={updateSelection}
      onKeyUp={updateSelection}
      onFocus={() => { setFocused(true); updateSelection(); }}
      onBlur={() => { setFocused(false); onBlur?.(); }}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
    />
    {open && <ul id={listId} role="listbox" className="relative z-30 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-lg">
      {matches.map((suggestion, index) => <li
        key={`${normalizeCaptionTag(suggestion)}-${index}`}
        id={`${listId}-option-${index}`}
        role="option"
        aria-selected={index === selectedIndex}
        className={`cursor-pointer rounded px-2 py-1 ${index === selectedIndex ? 'bg-accent text-accent-foreground' : 'text-popover-foreground'}`}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => accept(suggestion)}
      >{suggestion}</li>)}
    </ul>}
    {(duplicates.length > 0 || missingRequired) && <div className="mt-1 flex flex-wrap gap-1" aria-live="polite">
      {duplicates.map((tag) => <span key={`duplicate-${tag}`} className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">Duplicate: {tag}</span>)}
      {missingRequired && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">Required: {requiredTag}</span>}
    </div>}
  </div>;
};
