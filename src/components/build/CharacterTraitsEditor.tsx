import { useId, useState } from 'react';
import { useProjectStore } from '../../stores/useProjectStore';
import { normalizeTraitTag } from '../../services/tagging/characterTraits';

/** Character traits of a `character` project: always written to captions or left for the trigger word to learn. */
export function CharacterTraitsEditor({ suggestions = [] }: { suggestions?: readonly string[] }) {
  const projectType = useProjectStore((state) => state.projectType);
  const traits = useProjectStore((state) => state.characterTraits) ?? [];
  const setCharacterTraits = useProjectStore((state) => state.setCharacterTraits);
  const [value, setValue] = useState('');
  const listId = useId();
  if (projectType !== 'character') return null;
  const add = () => {
    const tag = normalizeTraitTag(value);
    if (!tag || traits.some((trait) => trait.tag === tag)) { setValue(''); return; }
    setCharacterTraits([...traits, { tag, mode: 'include' }]);
    setValue('');
  };
  return <div role="group" aria-label="Character traits" className="w-full basis-full space-y-2 rounded border border-border p-2">
    <p className="font-medium">Character traits</p>
    <p className="text-muted-foreground">
      <b>Always tag</b> writes the trait into every auto-generated caption. <b>Leave to trigger</b> keeps it out so the trigger word learns it.
      Either way, contradicting tags of the same group (for example green_eyes next to blue_eyes) are removed. Your manual caption edits are not changed.
    </p>
    <div className="flex gap-2">
      <input aria-label="Trait tag" list={listId} value={value} placeholder="blue_eyes" onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }}
        className="min-w-48 rounded border border-border bg-background px-2 py-1" />
      <datalist id={listId}>{suggestions.slice(0, 300).map((tag) => <option key={tag} value={tag} />)}</datalist>
      <button type="button" onClick={add} disabled={!value.trim()} className="rounded border border-border px-2 py-1 disabled:opacity-50">Add trait</button>
    </div>
    {!!traits.length && <ul className="flex flex-wrap gap-2">
      {traits.map((trait) => <li key={trait.tag} className="flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2 pr-1">
        <span className="font-mono">{trait.tag}</span>
        <select aria-label={`Mode for ${trait.tag}`} value={trait.mode} className="rounded border border-border bg-background px-1 py-0.5"
          onChange={(event) => setCharacterTraits(traits.map((entry) => entry.tag === trait.tag ? { ...entry, mode: event.target.value as 'include' | 'omit' } : entry))}>
          <option value="include">Always tag</option>
          <option value="omit">Leave to trigger</option>
        </select>
        <button type="button" aria-label={`Remove ${trait.tag}`} className="rounded px-1.5 hover:bg-muted" onClick={() => setCharacterTraits(traits.filter((entry) => entry.tag !== trait.tag))}>×</button>
      </li>)}
    </ul>}
  </div>;
}
